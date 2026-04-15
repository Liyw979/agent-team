import test from "node:test";
import assert from "node:assert/strict";

import { ZellijManager } from "./zellij-manager";

class StubZellijManager extends ZellijManager {
  public available = true;
  public calls: Array<{ method: string; args: unknown[] }> = [];
  public sessionNames = new Set<string>();
  public panes: Array<Record<string, unknown>> = [];
  public listSessionsResult: string = "";
  public failKill = false;

  async isAvailable(): Promise<boolean> {
    this.calls.push({ method: "isAvailable", args: [] });
    return this.available;
  }

  protected override async execZellij(args: string[]): Promise<{ stdout: string }> {
    this.calls.push({ method: "execZellij", args: [...args] });
    if (args[0] === "list-sessions") {
      return { stdout: this.listSessionsResult };
    }
    if (args[0] === "kill-session" && this.failKill) {
      throw new Error("kill failed");
    }
    if (args[2] === "action" && args.includes("list-panes")) {
      return { stdout: JSON.stringify(this.panes) };
    }
    return { stdout: "terminal_1" };
  }

  protected override async applyAgentGridLayout(
    sessionName: string,
    cwd: string,
    agents: Array<{ name: string }>,
  ): Promise<boolean> {
    this.calls.push({ method: "applyAgentGridLayout", args: [sessionName, cwd, agents.map((agent) => agent.name)] });
    this.panes = agents.map((agent, index) => ({
      id: `${index + 1}`,
      title: agent.name,
      is_plugin: false,
      exited: false,
      is_focused: index === 0,
      is_fullscreen: false,
      is_floating: false,
      pane_x: 0,
      pane_y: 0,
      pane_rows: 20,
      pane_columns: 80,
    }));
    return true;
  }

  protected override async ensureSessionActive(sessionName: string): Promise<void> {
    this.calls.push({ method: "ensureSessionActive", args: [sessionName] });
  }

  protected override async ensureSessionLayout(sessionName: string, targetPaneId?: string): Promise<void> {
    this.calls.push({ method: "ensureSessionLayout", args: [sessionName, targetPaneId ?? null] });
  }

  protected override async openSessionInTerminal(sessionName: string, cwd: string): Promise<void> {
    this.calls.push({ method: "openSessionInTerminal", args: [sessionName, cwd] });
  }

  protected override async openCommandInTerminal(cwd: string, terminalCommand: string): Promise<void> {
    this.calls.push({ method: "openCommandInTerminal", args: [cwd, terminalCommand] });
  }

  protected override async openMacTerminalCommand(cwd: string, terminalCommand: string): Promise<void> {
    this.calls.push({ method: "openMacTerminalCommand", args: [cwd, terminalCommand] });
  }

  protected override async openWindowsCmdSession(cwd: string, terminalCommand: string): Promise<boolean> {
    this.calls.push({ method: "openWindowsCmdSession", args: [cwd, terminalCommand] });
    return true;
  }

  protected override async spawnDetachedProcess(command: string, args: string[]): Promise<boolean> {
    this.calls.push({ method: "spawnDetachedProcess", args: [command, args] });
    return true;
  }

  protected override async closePane(sessionName: string, paneId: string): Promise<void> {
    this.calls.push({ method: "closePane", args: [sessionName, paneId] });
  }

  protected override async runAgentPane(sessionName: string, cwd: string, agentName: string): Promise<string> {
    this.calls.push({ method: "runAgentPane", args: [sessionName, cwd, agentName] });
    return `terminal_${agentName}`;
  }

  public inspectPartitionAgentsForGrid(agents: Array<{ name: string; opencodeSessionId?: string | null }>) {
    return this.partitionAgentsForGrid(
      agents.map((agent) => ({
        name: agent.name,
        opencodeSessionId: agent.opencodeSessionId ?? null,
      })),
    );
  }

  public inspectBuildAgentGridLayout(
    sessionName: string,
    cwd: string,
    agents: Array<{ name: string; opencodeSessionId?: string | null }>,
  ) {
    return this.buildAgentGridLayout(
      sessionName,
      cwd,
      agents.map((agent) => ({
        name: agent.name,
        opencodeSessionId: agent.opencodeSessionId ?? null,
      })),
    );
  }
}

test("createTaskSession 在不可用时只返回 session 名", async () => {
  const manager = new StubZellijManager();
  manager.available = false;

  const session = await manager.createTaskSession("project-1", "task-1");

  assert.equal(session, "oap-projec-task-1");
  assert.equal(manager.calls.some((item) => item.method === "execZellij"), false);
});

test("createTaskSession 在可用时会尝试创建后台 session", async () => {
  const manager = new StubZellijManager();

  const session = await manager.createTaskSession("project-1", "task-1");

  assert.equal(session, "oap-projec-task-1");
  assert.equal(manager.calls.some((item) => item.method === "execZellij"), true);
});

test("openTaskSession 会先校验可用性再补 session 与布局", async () => {
  const manager = new StubZellijManager();

  await manager.openTaskSession("session-1", "/tmp/demo");

  assert.deepEqual(manager.calls.slice(0, 4).map((item) => item.method), [
    "isAvailable",
    "ensureSessionActive",
    "ensureSessionLayout",
    "openSessionInTerminal",
  ]);
});

test("materializePanelBindings 首次创建时返回面板绑定", async () => {
  const manager = new StubZellijManager();
  manager.panes = [];

  const bindings = await manager.materializePanelBindings({
    projectId: "project-1",
    taskId: "task-1",
    sessionName: "session-1",
    cwd: "/tmp/demo",
    agents: [{ name: "Build", opencodeSessionId: null, status: "idle" }],
  });

  assert.equal(bindings.length, 1);
  assert.equal(bindings[0]?.agentName, "Build");
});

test("partitionAgentsForGrid 会按 Agent 顺序优先横向排布（最多两排）", () => {
  const manager = new StubZellijManager();

  const rows = manager.inspectPartitionAgentsForGrid([
    { name: "BA" },
    { name: "Build" },
    { name: "UnitTest" },
    { name: "IntegrationTest" },
    { name: "TaskReview" },
  ]);

  assert.deepEqual(
    rows.map((row) => row.map((agent) => agent.name)),
    [["BA", "Build", "UnitTest"], ["IntegrationTest", "TaskReview"]],
  );
});

test("partitionAgentsForGrid 在 Agent 数量较多时仍限制为最多两排", () => {
  const manager = new StubZellijManager();

  const rows = manager.inspectPartitionAgentsForGrid([
    { name: "A" },
    { name: "B" },
    { name: "C" },
    { name: "D" },
    { name: "E" },
    { name: "F" },
    { name: "G" },
  ]);

  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => row.map((agent) => agent.name)),
    [["A", "B", "C", "D"], ["E", "F", "G"]],
  );
});

test("buildAgentGridLayout 生成的布局会按 Agent 顺序横向优先排布", () => {
  const manager = new StubZellijManager();

  const layout = manager.inspectBuildAgentGridLayout("session-1", "/tmp/demo", [
    { name: "BA" },
    { name: "Build" },
    { name: "UnitTest" },
    { name: "IntegrationTest" },
  ]);

  assert.ok(layout);
  assert.match(layout ?? "", /pane split_direction="horizontal" \{/);
  assert.match(layout ?? "", /pane size="50%" split_direction="vertical" \{/);

  const normalizedLayout = layout ?? "";
  const baIndex = normalizedLayout.indexOf('name="BA" size="34%"');
  const buildIndex = normalizedLayout.indexOf('name="Build" size="33%"');
  const unitTestIndex = normalizedLayout.indexOf('name="UnitTest" size="33%"');

  assert.ok(baIndex >= 0);
  assert.ok(buildIndex > baIndex);
  assert.ok(unitTestIndex > buildIndex);
});

test("buildAgentGridLayout 会把当前 OpenCode attach 地址写入 pane 命令", () => {
  const manager = new StubZellijManager();
  manager.setOpenCodeAttachBaseUrl("http://127.0.0.1:43127");

  const layout = manager.inspectBuildAgentGridLayout("session-1", "/tmp/demo", [
    { name: "Build", opencodeSessionId: "session-123" },
  ]);

  assert.match(layout ?? "", /http:\/\/127\.0\.0\.1:43127/);
});

test("deleteTaskSession 在 kill 失败时会回退到 delete-session", async () => {
  const manager = new StubZellijManager();
  manager.failKill = true;

  await manager.deleteTaskSession("session-1");

  const commands = manager.calls
    .filter((item) => item.method === "execZellij")
    .map((item) => item.args[0] as string);
  assert.equal(commands.includes("kill-session"), true);
  assert.equal(commands.includes("delete-session"), true);
});
