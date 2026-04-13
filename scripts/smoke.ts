import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Orchestrator } from "../electron/main/orchestrator";

async function main() {
  const timeout = setTimeout(() => {
    console.error("smoke timeout");
    process.exit(1);
  }, 30000);
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-smoke-"));
  const cwd = process.cwd();
  const orchestrator = new Orchestrator({ userDataPath });

  // 避免冒烟时拉起额外终端窗口，其他运行时逻辑仍保持真实执行。
  (orchestrator as any).zellijManager.openTaskSession = async () => undefined;
  (orchestrator as any).zellijManager.focusAgentPANEL = async () => undefined;
  (orchestrator as any).zellijManager.createTaskSession = async (_projectId: string, taskId: string) =>
    `smoke-${taskId.slice(0, 8)}`;
  (orchestrator as any).zellijManager.materializePanelBindings = async (options: {
    projectId: string;
    taskId: string;
    sessionName: string;
    cwd: string;
    agentNames: string[];
  }) => (orchestrator as any).zellijManager.createPanelBindings(options);
  (orchestrator as any).zellijManager.dispatchTaskToPane = async () => undefined;
  (orchestrator as any).opencodeClient.ensureServer = async () => ({
    process: null,
    port: 0,
    mock: true,
  });
  (orchestrator as any).opencodeClient.connectEvents = async () => undefined;

  try {
    console.log("smoke: initialize");
    await orchestrator.initialize();
    console.log("smoke: bootstrap");
    const projects = await orchestrator.bootstrap();
    const project = projects[0];
    if (!project) {
      throw new Error("bootstrap 后未发现默认项目");
    }

    const entryAgent =
      project.agentFiles.find((agent) => agent.mode === "primary" && !agent.relativePath.startsWith("builtin://")) ??
      project.agentFiles[0];
    if (!entryAgent) {
      throw new Error("未找到可作为入口的 Agent");
    }
    const buildAgent = project.agentFiles.find((agent) => agent.name === "build");
    const codeReviewAgent = project.agentFiles.find((agent) => agent.role === "code_review");
    if (!buildAgent || !codeReviewAgent) {
      throw new Error("未找到 build 或 CodeReview Agent，无法执行条件触发冒烟");
    }

    console.log("smoke: saveTopology");
    await orchestrator.saveTopology({
      projectId: project.project.id,
      topology: {
        ...project.topology,
        edges: [
          {
            id: `${entryAgent.name}__${buildAgent.name}__success`,
            source: entryAgent.name,
            target: buildAgent.name,
            triggerOn: "success",
          },
          {
            id: `${buildAgent.name}__${codeReviewAgent.name}__success`,
            source: buildAgent.name,
            target: codeReviewAgent.name,
            triggerOn: "success",
          },
          {
            id: `${codeReviewAgent.name}__${buildAgent.name}__failed`,
            source: codeReviewAgent.name,
            target: buildAgent.name,
            triggerOn: "failed",
          },
          {
            id: `${codeReviewAgent.name}__${entryAgent.name}__success`,
            source: codeReviewAgent.name,
            target: entryAgent.name,
            triggerOn: "success",
          },
        ],
      },
    });

    console.log("smoke: submitTask");
    const created = await orchestrator.submitTask({
      projectId: project.project.id,
      content: `@${entryAgent.name} 请围绕当前仓库做一次完整实现并推进到最终交付。`,
      mentionAgent: entryAgent.name,
    });

    let settled = created;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      settled = await orchestrator.getTaskSnapshot(created.task.id);
      if (settled.task.status === "success" || settled.task.status === "failed") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    if (settled.task.status !== "success") {
      throw new Error(`Task 未成功完成，当前状态为 ${settled.task.status}`);
    }

    if (settled.agents.length < 6) {
      throw new Error(`Task Agent 数量异常，当前仅有 ${settled.agents.length} 个`);
    }

    const hasDecisionLeak = settled.messages.some((message) => message.content.includes("【DECISION】"));
    if (hasDecisionLeak) {
      throw new Error("Task 群聊中泄露了自检 DECISION 文本");
    }

    const hasHighLevelTrigger = settled.messages.some(
      (message) => message.meta?.kind === "high-level-trigger",
    );
    if (!hasHighLevelTrigger) {
      throw new Error("Task 群聊中未出现 Agent -> Agent 高层触发消息");
    }

    const hasCodeReview = settled.messages.some((message) => message.sender === codeReviewAgent.name);
    if (!hasCodeReview) {
      throw new Error(`未看到 ${codeReviewAgent.name} 的审查消息`);
    }

    const buildRun = settled.agents.find((agent) => agent.name === buildAgent.name)?.runCount ?? 0;
    if (buildRun !== 1) {
      throw new Error(`CodeReview 已通过时不应回流到 ${buildAgent.name}，但其运行次数为 ${buildRun}`);
    }

    const entryRun = settled.agents.find((agent) => agent.name === entryAgent.name)?.runCount ?? 0;
    if (entryRun < 2) {
      throw new Error("未形成“审查通过后回流入口 Agent 完成收口”的链路");
    }

    const nonIdleAgents = settled.agents.filter((agent) => agent.runCount > 0);
    if (nonIdleAgents.length < 2) {
      throw new Error("流水线未实际推进到多个 Agent");
    }

    const summary = {
      projectId: project.project.id,
      taskId: settled.task.id,
      taskStatus: settled.task.status,
      agentRuns: settled.agents.map((agent) => ({
        name: agent.name,
        status: agent.status,
        runCount: agent.runCount,
        sessionId: agent.opencodeSessionId,
      })),
      messageKinds: settled.messages.map((message) => ({
        sender: message.sender,
        kind: message.meta?.kind ?? "plain",
      })),
    };

    console.log(JSON.stringify(summary, null, 2));
    clearTimeout(timeout);
    process.exit(0);
  } finally {
    fs.rmSync(userDataPath, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
