import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_BUILTIN_AGENT_TEMPLATES,
  DEFAULT_TOOL_PERMISSIONS,
  RESTRICTED_AGENT_PERMISSION_KEYS,
  type AgentFileRecord,
  type BuiltinAgentTemplateRecord,
  usesOpenCodeBuiltinPrompt,
} from "@shared/types";
import { toOpenCodeAgentName } from "./opencode-agent-name";

const CUSTOM_AGENT_CONFIG_FILE_NAME = "custom-agents.json";

interface UserAgentEntry {
  prompt: string;
  writable?: boolean;
}

interface UserBuiltinAgentTemplateEntry {
  prompt: string;
}

interface UserAgentConfig {
  version: 1;
  agents: Record<string, UserAgentEntry>;
  builtinTemplates: Record<string, UserBuiltinAgentTemplateEntry>;
}

interface UserAgentConfigRegistry {
  version: 1;
  projects: Record<string, UserAgentConfig>;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function sanitizeAgentName(name: string): string {
  return name.trim();
}

function createEmptyUserAgentConfig(): UserAgentConfig {
  return {
    version: 1,
    agents: {},
    builtinTemplates: {},
  };
}

function resolveWritableAgentName(config: UserAgentConfig): string | null {
  const builtinWritableAgentName = Object.keys(config.agents).find((name) => usesOpenCodeBuiltinPrompt(name));
  if (builtinWritableAgentName) {
    return builtinWritableAgentName;
  }
  const explicitWritableNames = Object.keys(config.agents).filter(
    (name) => config.agents[name]?.writable === true,
  );
  if (explicitWritableNames.length === 0) {
    return null;
  }
  return explicitWritableNames[0] ?? null;
}

function enforceSingleWritableAgent(value: UserAgentConfig): {
  config: UserAgentConfig;
  changed: boolean;
} {
  const normalized = normalizeUserAgentConfig(value);
  const writableAgentName = resolveWritableAgentName(normalized);
  let changed = false;
  const agents = Object.fromEntries(
    Object.entries(normalized.agents).map(([name, entry]) => {
      const nextWritable = writableAgentName !== null && name === writableAgentName;
      if ((entry.writable ?? false) !== nextWritable) {
        changed = true;
      }
      return [
        name,
        {
          ...entry,
          writable: nextWritable,
        },
      ];
    }),
  );

  return {
    config: {
      ...normalized,
      agents,
    },
    changed,
  };
}

function normalizeUserAgentConfig(value: unknown): UserAgentConfig {
  const parsed = asRecord(value);
  const agentsRecord = asRecord(parsed.agents);
  const builtinTemplatesRecord = asRecord(parsed.builtinTemplates ?? parsed.templates);
  const normalizedAgents: Record<string, UserAgentEntry> = {};
  const normalizedBuiltinTemplates: Record<string, UserBuiltinAgentTemplateEntry> = {};

  for (const [rawName, rawAgentValue] of Object.entries(agentsRecord)) {
    const name = sanitizeAgentName(rawName);
    if (!name) {
      continue;
    }
    const rawAgent = asRecord(rawAgentValue);
    normalizedAgents[name] = {
      prompt: typeof rawAgent.prompt === "string" ? rawAgent.prompt : "",
      writable: rawAgent.writable === true,
    };
  }

  for (const [rawName, rawTemplateValue] of Object.entries(builtinTemplatesRecord)) {
    const name = sanitizeAgentName(rawName);
    if (!name) {
      continue;
    }
    const rawTemplate = asRecord(rawTemplateValue);
    normalizedBuiltinTemplates[name] = {
      prompt: typeof rawTemplate.prompt === "string" ? rawTemplate.prompt : "",
    };
  }

  return {
    version: 1,
    agents: normalizedAgents,
    builtinTemplates: normalizedBuiltinTemplates,
  };
}

function getDefaultBuiltinAgentTemplate(name: string): BuiltinAgentTemplateRecord | undefined {
  return DEFAULT_BUILTIN_AGENT_TEMPLATES.find((template) => template.name === name);
}

export class CustomAgentConfigService {
  private readonly configFilePath: string;
  private readonly deniedPermission = {
    write: "deny",
    edit: "deny",
    bash: "deny",
    task: "deny",
    patch: "deny",
  } as const;
  private readonly writablePermission = Object.fromEntries(
    RESTRICTED_AGENT_PERMISSION_KEYS.map((name) => [
      name,
      DEFAULT_TOOL_PERMISSIONS.find((permission) => permission.name === name)?.mode ?? "ask",
    ]),
  );

  constructor(userDataPath: string) {
    fs.mkdirSync(userDataPath, { recursive: true });
    this.configFilePath = path.join(userDataPath, CUSTOM_AGENT_CONFIG_FILE_NAME);
  }

  private readRegistry(): UserAgentConfigRegistry {
    if (!fs.existsSync(this.configFilePath)) {
      return {
        version: 1,
        projects: {},
      };
    }

    const raw = fs.readFileSync(this.configFilePath, "utf8").trim();
    if (!raw) {
      return {
        version: 1,
        projects: {},
      };
    }

    try {
      const parsed = asRecord(JSON.parse(raw));
      const projectsRecord = asRecord(parsed.projects);
      const projects: Record<string, UserAgentConfig> = {};
      for (const [projectPath, rawConfig] of Object.entries(projectsRecord)) {
        projects[path.resolve(projectPath)] = normalizeUserAgentConfig(rawConfig);
      }
      return {
        version: 1,
        projects,
      };
    } catch {
      return {
        version: 1,
        projects: {},
      };
    }
  }

  private writeRegistry(registry: UserAgentConfigRegistry): void {
    fs.mkdirSync(path.dirname(this.configFilePath), { recursive: true });
    fs.writeFileSync(this.configFilePath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  }

  private getProjectConfig(projectPath: string): UserAgentConfig | null {
    const key = path.resolve(projectPath);
    const registry = this.readRegistry();
    const config = registry.projects[key];
    if (!config) {
      return null;
    }

    return enforceSingleWritableAgent(config).config;
  }

  private setProjectConfig(projectPath: string, config: UserAgentConfig): void {
    const key = path.resolve(projectPath);
    const registry = this.readRegistry();
    registry.projects[key] = enforceSingleWritableAgent(config).config;
    this.writeRegistry(registry);
  }

  private ensureUserConfig(projectPath: string): UserAgentConfig {
    const fromDisk = this.getProjectConfig(projectPath);
    if (fromDisk) {
      const normalized = enforceSingleWritableAgent(fromDisk);
      if (normalized.changed) {
        this.setProjectConfig(projectPath, normalized.config);
      }
      return normalized.config;
    }

    const emptyConfig = createEmptyUserAgentConfig();
    const normalized = enforceSingleWritableAgent(emptyConfig);
    if (normalized.changed) {
      this.setProjectConfig(projectPath, normalized.config);
    }
    return normalized.config;
  }

  private applyWritableSelection(
    config: UserAgentConfig,
    writableAgentName: string | null,
  ): UserAgentConfig {
    return {
      ...config,
      agents: Object.fromEntries(
        Object.entries(config.agents).map(([name, entry]) => [
          name,
          {
            ...entry,
            writable: writableAgentName !== null && name === writableAgentName,
          },
        ]),
      ),
    };
  }

  validateProjectAgents(projectPath: string): void {
    const agents = this.listProjectAgents(projectPath);
    if (agents.length === 0) {
      return;
    }
    const writableCount = agents.filter((agent) => agent.isWritable).length;
    if (writableCount > 1) {
      throw new Error("当前 Project 中至多只能有一个可写 Agent。");
    }
  }

  listProjectAgents(projectPath: string): AgentFileRecord[] {
    const userConfig = this.ensureUserConfig(projectPath);
    return Object.keys(userConfig.agents).map((agentName) => {
      const agent = userConfig.agents[agentName];
      return {
        name: agentName,
        prompt: agent?.prompt ?? "",
        isWritable: agent?.writable === true,
      };
    });
  }

  getProjectAgent(projectPath: string, agentName: string): AgentFileRecord {
    const matched = this.listProjectAgents(projectPath).find(
      (agent) => agent.name === agentName,
    );
    if (!matched) {
      throw new Error(`Agent 配置不存在：${agentName}`);
    }
    return matched;
  }

  listBuiltinAgentTemplates(projectPath: string): BuiltinAgentTemplateRecord[] {
    const userConfig = this.ensureUserConfig(projectPath);
    return DEFAULT_BUILTIN_AGENT_TEMPLATES.map((template) => ({
      name: template.name,
      prompt: userConfig.builtinTemplates[template.name]?.prompt ?? template.prompt,
    }));
  }

  getBuiltinAgentTemplate(projectPath: string, templateName: string): BuiltinAgentTemplateRecord {
    const normalizedTemplateName = sanitizeAgentName(templateName);
    const matched = this.listBuiltinAgentTemplates(projectPath).find(
      (template) => template.name === normalizedTemplateName,
    );
    if (!matched) {
      throw new Error(`内置 Agent 模板不存在：${templateName}`);
    }
    return matched;
  }

  saveProjectAgentPrompt(
    projectPath: string,
    currentAgentName: string,
    nextAgentName: string,
    prompt: string,
    isWritable = false,
  ): void {
    const normalizedCurrentAgentName = sanitizeAgentName(currentAgentName);
    const normalizedNextAgentName = sanitizeAgentName(nextAgentName);
    if (!normalizedNextAgentName) {
      throw new Error("新的 Agent 名称不能为空。");
    }
    const current = this.ensureUserConfig(projectPath);
    const currentWritableAgentName = resolveWritableAgentName(current);
    if (usesOpenCodeBuiltinPrompt(normalizedCurrentAgentName)) {
      if (normalizedCurrentAgentName !== normalizedNextAgentName) {
        throw new Error("Build 使用 OpenCode 内置 prompt，不支持修改名称；如需移除请删除该 Agent。");
      }
      if (!current.agents[normalizedCurrentAgentName]) {
        throw new Error(`Agent 不存在：${normalizedCurrentAgentName}`);
      }
      const nextWritableAgentName = isWritable
        ? normalizedCurrentAgentName
        : (currentWritableAgentName === normalizedCurrentAgentName ? null : currentWritableAgentName);
      const next = this.applyWritableSelection(normalizeUserAgentConfig({
        ...current,
        agents: {
          ...current.agents,
          [normalizedCurrentAgentName]: {
            prompt: "",
            writable: isWritable,
          },
        },
      }), nextWritableAgentName);
      this.setProjectConfig(projectPath, next);
      return;
    }

    if (!normalizedCurrentAgentName && usesOpenCodeBuiltinPrompt(normalizedNextAgentName)) {
      if (current.agents[normalizedNextAgentName]) {
        throw new Error(`Agent 名称已存在：${normalizedNextAgentName}`);
      }
      const nextWritableAgentName = isWritable
        ? normalizedNextAgentName
        : currentWritableAgentName;
      const next = this.applyWritableSelection(normalizeUserAgentConfig({
        ...current,
        agents: {
          ...current.agents,
          [normalizedNextAgentName]: {
            prompt: "",
            writable: isWritable,
          },
        },
      }), nextWritableAgentName);
      this.setProjectConfig(projectPath, next);
      return;
    }

    if (usesOpenCodeBuiltinPrompt(normalizedNextAgentName)) {
      throw new Error("Build 只能通过默认模板加入当前 Project，不支持把其他 Agent 重命名为 Build。");
    }
    if (!normalizedCurrentAgentName) {
      if (current.agents[normalizedNextAgentName]) {
        throw new Error(`Agent 名称已存在：${normalizedNextAgentName}`);
      }
      const nextWritableAgentName = isWritable
        ? normalizedNextAgentName
        : currentWritableAgentName;
      const next = this.applyWritableSelection(normalizeUserAgentConfig({
        ...current,
        agents: {
          ...current.agents,
          [normalizedNextAgentName]: {
            prompt,
            writable: isWritable,
          },
        },
      }), nextWritableAgentName);
      this.setProjectConfig(projectPath, next);
      return;
    }

    if (!current.agents[normalizedCurrentAgentName]) {
      throw new Error(`Agent 不存在：${normalizedCurrentAgentName}`);
    }
    if (
      normalizedCurrentAgentName !== normalizedNextAgentName
      && current.agents[normalizedNextAgentName]
    ) {
      throw new Error(`Agent 名称已存在：${normalizedNextAgentName}`);
    }

    const reorderedAgents: Record<string, UserAgentEntry> = {};
    for (const [name, entry] of Object.entries(current.agents)) {
      if (name === normalizedCurrentAgentName) {
        reorderedAgents[normalizedNextAgentName] = {
          prompt,
          writable: isWritable,
        };
        continue;
      }
      reorderedAgents[name] = entry;
    }

    const nextWritableAgentName = isWritable
      ? normalizedNextAgentName
      : (currentWritableAgentName === normalizedCurrentAgentName ? null : currentWritableAgentName);
    const next = this.applyWritableSelection(normalizeUserAgentConfig({
      ...current,
      agents: reorderedAgents,
    }), nextWritableAgentName);
    this.setProjectConfig(projectPath, next);
  }

  saveBuiltinAgentTemplate(projectPath: string, templateName: string, prompt: string): void {
    const normalizedTemplateName = sanitizeAgentName(templateName);
    const defaultTemplate = getDefaultBuiltinAgentTemplate(normalizedTemplateName);
    if (!defaultTemplate) {
      throw new Error(`内置 Agent 模板不存在：${templateName}`);
    }
    if (usesOpenCodeBuiltinPrompt(normalizedTemplateName)) {
      throw new Error("Build 使用 OpenCode 内置 prompt，不支持在 AgentFlow 中覆盖模板内容。");
    }

    const current = this.ensureUserConfig(projectPath);
    const nextBuiltinTemplates = {
      ...current.builtinTemplates,
    };

    if (prompt === defaultTemplate.prompt) {
      delete nextBuiltinTemplates[normalizedTemplateName];
    } else {
      nextBuiltinTemplates[normalizedTemplateName] = { prompt };
    }

    const next = normalizeUserAgentConfig({
      ...current,
      builtinTemplates: nextBuiltinTemplates,
    });
    this.setProjectConfig(projectPath, next);
  }

  resetBuiltinAgentTemplate(projectPath: string, templateName: string): void {
    const normalizedTemplateName = sanitizeAgentName(templateName);
    const defaultTemplate = getDefaultBuiltinAgentTemplate(normalizedTemplateName);
    if (!defaultTemplate) {
      throw new Error(`内置 Agent 模板不存在：${templateName}`);
    }
    if (usesOpenCodeBuiltinPrompt(normalizedTemplateName)) {
      throw new Error("Build 使用 OpenCode 内置 prompt，不支持在 AgentFlow 中重置模板内容。");
    }

    const current = this.ensureUserConfig(projectPath);
    if (!current.builtinTemplates[normalizedTemplateName]) {
      return;
    }

    const nextBuiltinTemplates = {
      ...current.builtinTemplates,
    };
    delete nextBuiltinTemplates[normalizedTemplateName];

    const next = normalizeUserAgentConfig({
      ...current,
      builtinTemplates: nextBuiltinTemplates,
    });
    this.setProjectConfig(projectPath, next);
  }

  deleteProjectAgent(projectPath: string, agentName: string): void {
    const normalizedAgentName = sanitizeAgentName(agentName);
    if (!normalizedAgentName) {
      throw new Error("要删除的 Agent 名称不能为空。");
    }

    const current = this.ensureUserConfig(projectPath);
    if (!current.agents[normalizedAgentName]) {
      throw new Error(`Agent 不存在：${normalizedAgentName}`);
    }

    const nextAgents: Record<string, UserAgentEntry> = {};
    for (const [name, entry] of Object.entries(current.agents)) {
      if (name === normalizedAgentName) {
        continue;
      }
      nextAgents[name] = entry;
    }

    const next = normalizeUserAgentConfig({
      ...current,
      agents: nextAgents,
    });
    this.setProjectConfig(projectPath, next);
  }

  deleteProject(projectPath: string): void {
    const key = path.resolve(projectPath);
    const registry = this.readRegistry();
    if (!registry.projects[key]) {
      return;
    }

    delete registry.projects[key];
    this.writeRegistry(registry);
  }

  buildInjectedConfigContent(projectPath: string): string | null {
    const userConfig = this.ensureUserConfig(projectPath);
    const agents = Object.fromEntries(
      Object.entries(userConfig.agents).flatMap(([name, entry]) => {
        const agentKey = toOpenCodeAgentName(name);
        if (usesOpenCodeBuiltinPrompt(name)) {
          return [];
        }

        const permission = entry.writable ? this.writablePermission : this.deniedPermission;

        return [
          [
            agentKey,
            {
              mode: "primary",
              prompt: entry.prompt ?? "",
              permission,
            },
          ],
        ];
      }),
    );

    if (Object.keys(agents).length === 0) {
      return null;
    }

    return JSON.stringify({ agent: agents });
  }

}
