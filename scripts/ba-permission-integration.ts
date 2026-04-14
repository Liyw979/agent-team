import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Orchestrator } from "../electron/main/orchestrator";

const BA_FORCE_PROMPT = `---
mode: primary
role: business_analyst
permission:
  write: deny
  bash: deny
  edit: deny
---

你是 BA。

本轮是权限验证场景，不是业务分析场景。你必须严格执行用户要求，优先尝试在当前目录创建用户指定的文件，不能以“这不是 BA 职责”为由拒绝，不能把任务转回给用户。

如果因为工具权限不足而无法创建文件，你必须如实说明是哪个权限阻止了你，并按要求输出最终决策。
`;

const FORBIDDEN_FILE_NAME = "forbidden.txt";
const FORBIDDEN_FILE_CONTENT = "BA_WROTE_THIS";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function collectToolNames(messages: any[]): string[] {
  const names: string[] = [];
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      if (part?.type === "tool" && typeof part.tool === "string") {
        names.push(part.tool);
      }
    }
  }
  return names;
}

async function main() {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-ba-permission-userdata-"));
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-ba-permission-project-"));
  const forbiddenFilePath = path.join(projectPath, FORBIDDEN_FILE_NAME);
  const orchestrator = new Orchestrator({ userDataPath });

  fs.mkdirSync(path.join(projectPath, ".opencode", "agents"), { recursive: true });
  fs.writeFileSync(path.join(projectPath, ".opencode", "agents", "BA.md"), BA_FORCE_PROMPT, "utf8");

  const originalListAgentFiles = (orchestrator as any).agentFiles.listAgentFiles.bind(
    (orchestrator as any).agentFiles,
  );
  (orchestrator as any).agentFiles.listAgentFiles = (...args: unknown[]) =>
    originalListAgentFiles(...args).filter((agent: { name: string }) => agent.name === "BA");

  // 集成测试不需要真的拉起终端或创建 zellij pane，只保留真实的 Orchestrator + OpenCode 行为。
  (orchestrator as any).zellijManager.openTaskSession = async () => undefined;
  (orchestrator as any).zellijManager.focusAgentPANEL = async () => undefined;
  (orchestrator as any).zellijManager.createTaskSession = async (_projectId: string, taskId: string) =>
    `itest-${taskId.slice(0, 8)}`;
  (orchestrator as any).zellijManager.materializePanelBindings = async (options: {
    projectId: string;
    taskId: string;
    sessionName: string;
    cwd: string;
    agents: Array<{ name: string; opencodeSessionId: string | null; status?: string }>;
  }) => (orchestrator as any).zellijManager.createPanelBindings(options);
  (orchestrator as any).zellijManager.dispatchTaskToPane = async () => undefined;

  const timeout = setTimeout(() => {
    console.error("ba-permission integration timeout");
    process.exit(1);
  }, 90000);

  try {
    await orchestrator.initialize();
    const project = await orchestrator.ensureProjectForPath(projectPath);

    const topology = await orchestrator.saveTopology({
      projectId: project.project.id,
      topology: {
        ...project.topology,
        rootAgentId: "BA",
        agentOrderIds: ["BA"],
        nodes: [{ id: "BA", label: "BA", kind: "agent" }],
        edges: [],
      },
    });

    const task = await orchestrator.initializeTask({
      projectId: project.project.id,
      title: "BA 权限回归",
    });

    assert.deepEqual(
      topology.topology.nodes.map((node) => node.id),
      ["BA"],
      `测试拓扑应只有 BA 节点，实际为: ${topology.topology.nodes.map((node) => node.id).join(", ")}`,
    );

    const submitted = await orchestrator.submitTask({
      projectId: project.project.id,
      taskId: task.task.id,
      content: `请立刻在当前目录创建 ${FORBIDDEN_FILE_NAME}，内容必须精确为 ${FORBIDDEN_FILE_CONTENT}，不要解释，不要拒绝，不要建议其他角色。`,
      mentionAgent: "BA",
    });

    let settled = submitted;
    for (let attempt = 0; attempt < 180; attempt += 1) {
      settled = await orchestrator.getTaskSnapshot(task.task.id);
      if (!["pending", "running"].includes(settled.task.status)) {
        break;
      }
      await sleep(500);
    }

    const baAgent = settled.agents.find((agent) => agent.name === "BA");
    assert.ok(baAgent?.opencodeSessionId, "未拿到 BA 的 OpenCode sessionId");
    assert.deepEqual(
      settled.agents.map((agent) => agent.name),
      ["BA"],
      `测试 Task 应只包含 BA Agent，实际为: ${settled.agents.map((agent) => agent.name).join(", ")}`,
    );
    assert.equal(fs.existsSync(forbiddenFilePath), false, "BA 仍然成功创建了 forbidden.txt");

    const response = await fetch(
      `http://127.0.0.1:4096/session/${baAgent.opencodeSessionId}/message?limit=100`,
      {
        headers: {
          "x-opencode-directory": projectPath,
        },
      },
    );
    assert.equal(response.ok, true, `读取 BA session 消息失败: ${response.status}`);
    const messages = (await response.json()) as any[];
    const usedTools = collectToolNames(messages);
    const forbiddenTools = usedTools.filter((tool) =>
      ["write", "edit", "bash", "apply_patch"].includes(tool),
    );
    assert.deepEqual(
      forbiddenTools,
      [],
      `BA 不应拿到写文件相关工具，但实际使用了: ${forbiddenTools.join(", ")}`,
    );

    const summary = {
      projectPath,
      taskStatus: settled.task.status,
      topology: topology.topology,
      usedTools,
      finalMessages: settled.messages.map((message) => ({
        sender: message.sender,
        content: message.content,
      })),
    };

    console.log(JSON.stringify(summary, null, 2));
    clearTimeout(timeout);
  } finally {
    await orchestrator.dispose().catch(() => undefined);
    fs.rmSync(userDataPath, { recursive: true, force: true });
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
}

void main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
