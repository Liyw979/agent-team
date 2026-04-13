import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_TOOL_PERMISSIONS,
  type AgentFileRecord,
  type AgentMode,
  type PermissionMode,
  type ToolPermission,
} from "@shared/types";

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

const DEFAULT_AGENT_TEMPLATES: Record<string, string> = {
  "BA.md": `---
mode: primary
role: business_analyst
permission:
  read: allow
  grep: allow
  glob: allow
  list: allow
  webfetch: allow
---
你是 BA。
你的职责：
1. 润色原始 User Story，并输出一个可执行的实现方案。
2. 在收到审查阶段回流后，站在用户旅程角度、功能完备性审核最终交付质量。

请只关注你当前负责的业务分析与验收工作，输出高层结果，不要假设还有其他角色，也不要描述任何调度链路。
`,
  "CodeReview.md": `---
mode: subagent
role: code_review
permission:
  read: allow
  grep: allow
  glob: allow
  list: allow
---
你是代码审查角色，关注冗余实现、可读性和是否符合 BA 定义的使用旅程。

请只关注你当前负责的审查工作，输出高层结果，不要假设还有其他角色，也不要描述任何调度链路。

要求代码最小化改动，思考并质疑当前的改动是不是最小的。
`,
  "DocsReview.md": `---
mode: subagent
role: docs_review
permission:
  read: allow
  grep: allow
  glob: allow
  list: allow
---
你是文档审查角色，负责检查当前改动是否已经同步反映到 README.md、AGENTS.md 和其他协作文档。

请只关注文档同步审查本身，输出高层结果，不要假设还有其他角色，也不要描述任何调度链路。
`,
  "IntegrationTest.md": `---
mode: subagent
role: integration_test
permission:
  read: allow
  grep: allow
  glob: allow
  list: allow
---
你是集成测试审查角色，负责检查实现是否提供了覆盖充分、可直接执行通过的集成测试。

请只关注你当前负责的审查工作，输出高层结果，不要假设还有其他角色，也不要描述任何调度链路。
`,
  "UnitTest.md": `---
mode: subagent
role: unit_test
permission:
  read: allow
  grep: allow
  glob: allow
  list: allow
---
你是单元测试审查角色，负责检查单元测试是否遵循四条标准：单功能单测试、每个测试有注释、执行要快、尽量使用纯函数而不是 Mock。

请只关注你当前负责的审查工作，输出高层结果，不要假设还有其他角色，也不要描述任何调度链路。
`,
};

const LEGACY_AGENT_FILE_MAP: Record<string, string> = {
  "BA-Agent.md": "BA.md",
  "CodeReview-Agent.md": "CodeReview.md",
  "DocsReview-Agent.md": "DocsReview.md",
  "IntegrationTest-Agent.md": "IntegrationTest.md",
  "UnitTest-Agent.md": "UnitTest.md",
};

const BUILTIN_BUILD_AGENT_PATH = "builtin://build";

const TOOL_PERMISSION_MODE_SET = new Set<PermissionMode>(["allow", "ask", "deny"]);
const DEFAULT_TOOL_MODE_MAP = new Map(DEFAULT_TOOL_PERMISSIONS.map((tool) => [tool.name, tool.mode]));
const DEFAULT_TOOL_ORDER = new Map(DEFAULT_TOOL_PERMISSIONS.map((tool, index) => [tool.name, index]));

function cloneDefaultToolPermissions(): ToolPermission[] {
  return DEFAULT_TOOL_PERMISSIONS.map((tool) => ({ ...tool }));
}

function sortToolPermissions(tools: ToolPermission[]): ToolPermission[] {
  return [...tools].sort((left, right) => {
    const leftOrder = DEFAULT_TOOL_ORDER.get(left.name) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = DEFAULT_TOOL_ORDER.get(right.name) ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    return left.name.localeCompare(right.name);
  });
}

function normalizePermissionMode(value: unknown): PermissionMode | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (!TOOL_PERMISSION_MODE_SET.has(normalized as PermissionMode)) {
    return null;
  }
  return normalized as PermissionMode;
}

function toPermissionList(rawTools: unknown): ToolPermission[] {
  if (rawTools && typeof rawTools === "object") {
    const permissions = Object.entries(rawTools as Record<string, unknown>)
      .map(([name, value]) => {
        const mode = normalizePermissionMode(value);
        if (!mode) {
          return null;
        }
        return { name, mode };
      })
      .filter((tool): tool is ToolPermission => Boolean(tool));

    if (permissions.length > 0) {
      return sortToolPermissions(permissions);
    }
  }

  return cloneDefaultToolPermissions();
}

function parseFrontmatter(frontmatter: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = frontmatter.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trimEnd() ?? "";
    if (!line.trim() || line.trim().startsWith("#")) {
      continue;
    }

    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) {
      continue;
    }

    const [, key, rawValue] = match;
    const value = rawValue.trim();

    if (value === "") {
      const list: string[] = [];
      const record: Record<string, string> = {};
      let hasList = false;
      let hasRecord = false;
      while (index + 1 < lines.length) {
        const next = lines[index + 1] ?? "";
        const itemMatch = next.match(/^\s*-\s*(.+)$/);
        if (itemMatch) {
          list.push(itemMatch[1].trim());
          hasList = true;
          index += 1;
          continue;
        }

        const recordMatch = next.match(/^\s+([A-Za-z0-9_*.-]+):\s*(.+)?$/);
        if (recordMatch) {
          record[recordMatch[1]] = (recordMatch[2] ?? "").trim().replace(/^['"]|['"]$/g, "");
          hasRecord = true;
          index += 1;
          continue;
        }

        if (!next.trim()) {
          index += 1;
          continue;
        }

        if (!/^\s/.test(next)) {
          break;
        }
      }
      result[key] = hasRecord && !hasList ? record : list;
      continue;
    }

    if (value.startsWith("[") && value.endsWith("]")) {
      result[key] = value
        .slice(1, -1)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      continue;
    }

    result[key] = value.replace(/^['"]|['"]$/g, "");
  }

  return result;
}

function parseAgentContent(content: string) {
  const match = content.match(FRONTMATTER_REGEX);
  if (!match) {
    return {
      data: {} as Record<string, unknown>,
      prompt: content.trim(),
    };
  }

  return {
    data: parseFrontmatter(match[1] ?? ""),
    prompt: (match[2] ?? "").trim(),
  };
}

function collectMarkdownFiles(root: string, current = root): string[] {
  const entries = fs.readdirSync(current, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectMarkdownFiles(root, absolute));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(absolute);
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}

function buildAgentRecord(projectId: string, projectPath: string, absolutePath: string): AgentFileRecord {
  const content = fs.readFileSync(absolutePath, "utf8");
  const parsed = parseAgentContent(content);
  const relativePath = path.relative(path.join(projectPath, ".opencode", "agents"), absolutePath);
  const name = relativePath.replace(/\\/g, "/").replace(/\.md$/i, "");
  const mode =
    parsed.data.mode === "subagent" || parsed.data.mode === "primary"
      ? (parsed.data.mode as AgentMode)
      : "subagent";
  return {
    id: `${projectId}:${name}`,
    projectId,
    name,
    relativePath: relativePath.replace(/\\/g, "/"),
    absolutePath,
    mode,
    role: typeof parsed.data.role === "string" ? parsed.data.role : null,
    tools: toPermissionList(parsed.data.permission),
    prompt: parsed.prompt,
    content,
  };
}

function buildBuiltinBuildAgentRecord(projectId: string): AgentFileRecord {
  const content = `# OpenCode built-in agent: build

这个 Agent 使用 OpenCode 自带的内置 build agent。
它不是项目里的 Markdown 文件，因此不会出现在 .opencode/agents 文件编辑链路里。
`;

  return {
    id: `${projectId}:build`,
    projectId,
    name: "build",
    relativePath: BUILTIN_BUILD_AGENT_PATH,
    absolutePath: BUILTIN_BUILD_AGENT_PATH,
    mode: "primary",
    role: "implementation",
    tools: cloneDefaultToolPermissions(),
    prompt: "",
    content,
  };
}

export class AgentFileService {
  ensureProjectAgents(projectPath: string) {
    const agentsDir = path.join(projectPath, ".opencode", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });

    for (const [legacyName, nextName] of Object.entries(LEGACY_AGENT_FILE_MAP)) {
      const legacyPath = path.join(agentsDir, legacyName);
      const nextPath = path.join(agentsDir, nextName);
      if (fs.existsSync(legacyPath) && !fs.existsSync(nextPath)) {
        fs.renameSync(legacyPath, nextPath);
      }
    }

    const deprecatedPaths = ["Code.md", "Code-Agent.md", "Delivery.md", "Delivery-Agent.md"].map((name) =>
      path.join(agentsDir, name),
    );
    const docsReviewPath = path.join(agentsDir, "DocsReview.md");
    if (deprecatedPaths.some((deprecatedPath) => fs.existsSync(deprecatedPath)) && !fs.existsSync(docsReviewPath)) {
      fs.writeFileSync(docsReviewPath, DEFAULT_AGENT_TEMPLATES["DocsReview.md"], "utf8");
    }

    for (const deprecatedName of ["Code.md", "Code-Agent.md", "Delivery.md", "Delivery-Agent.md"]) {
      const deprecatedPath = path.join(agentsDir, deprecatedName);
      if (fs.existsSync(deprecatedPath)) {
        fs.rmSync(deprecatedPath, { force: true });
      }
    }

    const markdownFiles = collectMarkdownFiles(agentsDir);
    if (markdownFiles.length > 0) {
      return;
    }

    for (const [fileName, content] of Object.entries(DEFAULT_AGENT_TEMPLATES)) {
      fs.writeFileSync(path.join(agentsDir, fileName), content, "utf8");
    }
  }

  listAgentFiles(projectId: string, projectPath: string): AgentFileRecord[] {
    this.ensureProjectAgents(projectPath);
    const agentsDir = path.join(projectPath, ".opencode", "agents");
    const fileAgents = collectMarkdownFiles(agentsDir).map((absolutePath) =>
      buildAgentRecord(projectId, projectPath, absolutePath),
    );
    return [...fileAgents, buildBuiltinBuildAgentRecord(projectId)];
  }

  saveAgentFile(projectId: string, projectPath: string, relativePath: string, content: string) {
    if (relativePath === BUILTIN_BUILD_AGENT_PATH) {
      throw new Error("OpenCode 内置 build agent 不支持保存为本地 Markdown 文件");
    }
    const agentsDir = path.join(projectPath, ".opencode", "agents");
    const normalizedRelativePath = relativePath.replace(/^\/+/, "");
    const absolutePath = path.join(agentsDir, normalizedRelativePath);

    if (!absolutePath.startsWith(agentsDir)) {
      throw new Error("非法的 Agent 文件路径");
    }

    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content, "utf8");
    return buildAgentRecord(projectId, projectPath, absolutePath);
  }
}
