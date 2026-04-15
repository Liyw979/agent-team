import fs from "node:fs";
import path from "node:path";
import {
  BUILD_AGENT_NAME,
  DEFAULT_BUILTIN_AGENT_TEMPLATES,
  type AgentFileRecord,
  type BuiltinAgentTemplateRecord,
} from "@shared/types";

const CUSTOM_AGENT_CONFIG_FILE_NAME = "custom-agents.json";

interface UserAgentEntry {
  prompt: string;
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
    return config ? normalizeUserAgentConfig(config) : null;
  }

  private setProjectConfig(projectPath: string, config: UserAgentConfig): void {
    const key = path.resolve(projectPath);
    const registry = this.readRegistry();
    registry.projects[key] = normalizeUserAgentConfig(config);
    this.writeRegistry(registry);
  }

  private ensureUserConfig(projectPath: string): UserAgentConfig {
    const fromDisk = this.getProjectConfig(projectPath);
    if (fromDisk) {
      return fromDisk;
    }

    return {
      version: 1,
      agents: {},
      builtinTemplates: {},
    };
  }

  listProjectAgents(projectPath: string): AgentFileRecord[] {
    const userConfig = this.ensureUserConfig(projectPath);
    const customAgentNames = Object.keys(userConfig.agents).filter((name) => name !== BUILD_AGENT_NAME);
    const agentNames = [BUILD_AGENT_NAME, ...customAgentNames];
    return agentNames.map((agentName) => {
      const prompt = userConfig.agents[agentName]?.prompt ?? "";
      return {
        name: agentName,
        prompt,
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
  ): void {
    const normalizedCurrentAgentName = sanitizeAgentName(currentAgentName);
    const normalizedNextAgentName = sanitizeAgentName(nextAgentName);
    if (!normalizedNextAgentName) {
      throw new Error("新的 Agent 名称不能为空。");
    }
    if (normalizedCurrentAgentName === BUILD_AGENT_NAME) {
      throw new Error("Build 是系统默认且必选 Agent，不支持在自定义配置里编辑。");
    }
    if (normalizedNextAgentName === BUILD_AGENT_NAME) {
      throw new Error("Build 是系统默认且必选 Agent，不支持作为自定义 Agent 新增或重命名。");
    }

    const current = this.ensureUserConfig(projectPath);
    if (!normalizedCurrentAgentName) {
      if (current.agents[normalizedNextAgentName]) {
        throw new Error(`Agent 名称已存在：${normalizedNextAgentName}`);
      }
      const next = normalizeUserAgentConfig({
        ...current,
        agents: {
          ...current.agents,
          [normalizedNextAgentName]: {
            prompt,
          },
        },
      });
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
        };
        continue;
      }
      reorderedAgents[name] = entry;
    }

    const next = normalizeUserAgentConfig({
      ...current,
      agents: reorderedAgents,
    });
    this.setProjectConfig(projectPath, next);
  }

  saveBuiltinAgentTemplate(projectPath: string, templateName: string, prompt: string): void {
    const normalizedTemplateName = sanitizeAgentName(templateName);
    const defaultTemplate = getDefaultBuiltinAgentTemplate(normalizedTemplateName);
    if (!defaultTemplate) {
      throw new Error(`内置 Agent 模板不存在：${templateName}`);
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
    if (normalizedAgentName === BUILD_AGENT_NAME) {
      throw new Error("Build 是系统默认且必选 Agent，不支持删除。");
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

  buildInjectedConfigContent(projectPath: string): string {
    const userConfig = this.ensureUserConfig(projectPath);
    const agentNames = Object.keys(userConfig.agents).filter((name) => name !== BUILD_AGENT_NAME);

    const agents = Object.fromEntries(
      agentNames.map((name) => [
        name,
        {
          mode: "primary",
          prompt: userConfig.agents[name]?.prompt ?? "",
          permission: this.deniedPermission,
        },
      ]),
    );

    const content: Record<string, unknown> = {
      agent: agents,
    };

    return JSON.stringify(content);
  }

}
