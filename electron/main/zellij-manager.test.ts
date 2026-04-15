import test from "node:test";
import assert from "node:assert/strict";

import { ZellijManager } from "./zellij-manager";

class StubZellijManager extends ZellijManager {
  public available = true;
  public calls: Array<{ method: string; args: unknown[] }> = [];
  public sessionNames = new Set<string>();
  public panes: Array<Record<string, unknown>> = [];
  public listPanesStdoutOverride: string | null = null;
  public failKill = false;
  public failCreate = false;
  public failListPanesOnceWithSessionNotFound = false;
  public failListPanesOnceWithSessionNotFoundOutput = false;
  public failListSessions = false;
  public failApplyAgentGridLayout = false;
  public runPaneStdoutQueue: string[] = [];
  public useDetachedBackgroundSession = false;

  async isAvailable(): Promise<boolean> {
    this.calls.push({ method: "isAvailable", args: [] });
    return this.available;
  }

  protected override async execZellij(args: string[]): Promise<{ stdout: string }> {
    this.calls.push({ method: "execZellij", args: [...args] });
    if (args[0] === "list-sessions") {
      if (this.failListSessions) {
        throw new Error("list sessions failed");
      }
      return {
        stdout: [...this.sessionNames].map((sessionName) => `${sessionName} [Created 1s ago]`).join("\n"),
      };
    }
    if (args[0] === "attach" && args[1] === "--create-background") {
      if (this.failCreate) {
        throw new Error("create failed");
      }
      const sessionName = typeof args[2] === "string" ? args[2] : "";
      if (sessionName) {
        this.sessionNames.add(sessionName);
      }
      return { stdout: "" };
    }
    if (args[0] === "kill-session" && this.failKill) {
      throw new Error("kill failed");
    }
    if (args[2] === "action" && args.includes("list-panes")) {
      if (this.failListPanesOnceWithSessionNotFound) {
        this.failListPanesOnceWithSessionNotFound = false;
        throw new Error(`session '${String(args[1] ?? "")}' not found`);
      }
      if (this.failListPanesOnceWithSessionNotFoundOutput) {
        this.failListPanesOnceWithSessionNotFoundOutput = false;
        return {
          stdout: "Session 'session-1' not found. The following sessions are active:\n\u001b[32;1msession-1\u001b[m [Created \u001b[35;1m1s\u001b[m ago]",
        };
      }
      if (this.listPanesStdoutOverride !== null) {
        const stdout = this.listPanesStdoutOverride;
        this.listPanesStdoutOverride = null;
        return { stdout };
      }
      return { stdout: JSON.stringify(this.panes) };
    }
    if (args[2] === "run") {
      return { stdout: this.runPaneStdoutQueue.shift() ?? "terminal_1" };
    }
    return { stdout: "terminal_1" };
  }

  protected override async applyAgentGridLayout(
    sessionName: string,
    cwd: string,
    agents: Array<{ name: string }>,
  ): Promise<boolean> {
    this.calls.push({ method: "applyAgentGridLayout", args: [sessionName, cwd, agents.map((agent) => agent.name)] });
    if (this.failApplyAgentGridLayout) {
      throw new Error("layout failed");
    }
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

  protected override usesDetachedBackgroundSession(): boolean {
    return this.useDetachedBackgroundSession;
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
    if (
      args[0] === "attach"
      && args[1] === "--create-background"
      && typeof args[2] === "string"
    ) {
      this.sessionNames.add(args[2]);
    }
    return true;
  }

  protected override async closePane(sessionName: string, paneId: string): Promise<void> {
    this.calls.push({ method: "closePane", args: [sessionName, paneId] });
  }

  protected override async runAgentPane(
    sessionName: string,
    cwd: string,
    agentName: string,
    opencodeSessionId: string | null,
  ): Promise<string> {
    this.calls.push({ method: "runAgentPane", args: [sessionName, cwd, agentName, opencodeSessionId] });
    return super.runAgentPane(sessionName, cwd, agentName, opencodeSessionId);
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

  public inspectCanQuerySession(sessionName: string) {
    return this.canQuerySession(sessionName);
  }
}

class CaptureMacTerminalManager extends ZellijManager {
  public spawnCalls: Array<{ command: string; args: string[] }> = [];

  async runOpenMacTerminalCommand(cwd: string, terminalCommand: string): Promise<void> {
    await this.openMacTerminalCommand(cwd, terminalCommand);
  }

  protected override async spawnDetachedProcess(command: string, args: string[]): Promise<boolean> {
    this.spawnCalls.push({ command, args });
    return true;
  }
}

class CaptureWindowsTerminalManager extends ZellijManager {
  public spawnCalls: Array<{ command: string; args: string[] }> = [];

  async runOpenCommandInTerminal(cwd: string, terminalCommand: string): Promise<void> {
    await this.openCommandInTerminal(cwd, terminalCommand);
  }

  async runOpenWindowsCmdSession(cwd: string, terminalCommand: string): Promise<boolean> {
    return this.openWindowsCmdSession(cwd, terminalCommand);
  }

  protected override getHostPlatform(): NodeJS.Platform {
    return "win32";
  }

  protected override async spawnDetachedProcess(command: string, args: string[]): Promise<boolean> {
    this.spawnCalls.push({ command, args });
    return true;
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
  assert.equal(manager.sessionNames.has("oap-projec-task-1"), true);
});

test("createTaskSession 在 zellij 创建失败时会直接抛错，不再返回不存在的 session 名", async () => {
  const manager = new StubZellijManager();
  manager.failCreate = true;

  await assert.rejects(
    manager.createTaskSession("project-1", "task-1"),
    /create failed/,
  );
});

test("createTaskSession 在 list-sessions 不稳定时会回退到直接探测 session", async () => {
  const manager = new StubZellijManager();
  manager.failListSessions = true;

  const session = await manager.createTaskSession("project-1", "task-1");

  assert.equal(session, "oap-projec-task-1");
  assert.equal(
    manager.calls.some(
      (item) =>
        item.method === "execZellij"
        && Array.isArray(item.args)
        && item.args[0] === "-s"
        && item.args[1] === "oap-projec-task-1",
    ),
    true,
  );
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

test("openMacTerminalCommand 不会先 reopen Terminal 造成额外空窗", async () => {
  const manager = new CaptureMacTerminalManager();

  await manager.runOpenMacTerminalCommand("/tmp/demo", "zellij attach session-1 --create");

  assert.equal(manager.spawnCalls.length, 1);
  assert.equal(manager.spawnCalls[0]?.command, "osascript");
  assert.equal(manager.spawnCalls[0]?.args.includes("reopen"), false);
  const scriptLines = manager.spawnCalls[0]?.args.filter((arg) => arg !== "-e") ?? [];
  assert.equal(
    scriptLines.some((line) => line.startsWith('do script "cd ')),
    true,
  );
  assert.equal(
    scriptLines.some((line) => line.includes("zellij attach session-1 --create")),
    true,
  );
});

test("materializePanelBindings 首次创建时返回面板绑定", async () => {
  const manager = new StubZellijManager();
  manager.panes = [];
  manager.sessionNames.add("session-1");

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

test("listTerminalPanes 遇到 session not found 时会等待 session 就绪后重试", async () => {
  const manager = new StubZellijManager();
  manager.sessionNames.add("session-1");
  manager.failListPanesOnceWithSessionNotFound = true;
  manager.panes = [{
    id: "1",
    title: "Build",
    is_plugin: false,
    exited: false,
    is_focused: true,
    is_fullscreen: false,
    is_floating: false,
    pane_x: 0,
    pane_y: 0,
    pane_rows: 20,
    pane_columns: 80,
  }];

  const bindings = await manager.materializePanelBindings({
    projectId: "project-1",
    taskId: "task-1",
    sessionName: "session-1",
    cwd: "/tmp/demo",
    agents: [{ name: "Build", opencodeSessionId: null, status: "idle" }],
  });

  assert.match(bindings[0]?.paneId ?? "", /^terminal_(1|Build)$/);
});

test("listTerminalPanes 遇到非 JSON 的 session not found 输出时也会重试", async () => {
  const manager = new StubZellijManager();
  manager.sessionNames.add("session-1");
  manager.failListPanesOnceWithSessionNotFoundOutput = true;
  manager.panes = [{
    id: "1",
    title: "Build",
    is_plugin: false,
    exited: false,
    is_focused: true,
    is_fullscreen: false,
    is_floating: false,
    pane_x: 0,
    pane_y: 0,
    pane_rows: 20,
    pane_columns: 80,
  }];

  const bindings = await manager.materializePanelBindings({
    projectId: "project-1",
    taskId: "task-1",
    sessionName: "session-1",
    cwd: "/tmp/demo",
    agents: [{ name: "Build", opencodeSessionId: null, status: "idle" }],
  });

  assert.match(bindings[0]?.paneId ?? "", /^terminal_(1|Build)$/);
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

test("createTaskSession uses a bootstrap pane when detached session startup is enabled", async () => {
  const manager = new StubZellijManager();
  manager.useDetachedBackgroundSession = true;

  const session = await manager.createTaskSession("project-1", "task-1");

  assert.equal(session, "oap-projec-task-1");
  assert.equal(
    manager.calls.some(
      (item) =>
        item.method === "spawnDetachedProcess"
        && Array.isArray(item.args[1])
        && item.args[1][0] === "attach"
        && item.args[1][1] === "--create-background"
        && item.args[1][2] === "oap-projec-task-1",
    ),
    true,
  );
  assert.equal(
    manager.calls.some(
      (item) =>
        item.method === "execZellij"
        && Array.isArray(item.args)
        && item.args[0] === "-s"
        && item.args[1] === "oap-projec-task-1"
        && item.args[2] === "run",
    ),
    true,
  );
});

test("openCommandInTerminal on Windows uses wt maximized new-tab syntax with starting directory", async () => {
  const manager = new CaptureWindowsTerminalManager();

  await manager.runOpenCommandInTerminal(
    "D:\\empty",
    "\"D:\\agent-flow\\download\\zellij.exe\" \"attach\" \"session-1\" \"--create\"",
  );

  assert.equal(manager.spawnCalls.length, 1);
  assert.equal(manager.spawnCalls[0]?.command, "wt");
  assert.deepEqual(manager.spawnCalls[0]?.args, [
    "--maximized",
    "-w",
    "-1",
    "new-tab",
    "-d",
    "D:\\empty",
    "cmd.exe",
    "/k",
    "\"D:\\agent-flow\\download\\zellij.exe\" \"attach\" \"session-1\" \"--create\"",
  ]);
});

test("openWindowsCmdSession on Windows uses maximized fallback without fullscreen", async () => {
  const manager = new CaptureWindowsTerminalManager();

  const opened = await manager.runOpenWindowsCmdSession(
    "D:\\empty",
    "\"D:\\agent-flow\\download\\zellij.exe\" \"attach\" \"session-1\" \"--create\"",
  );

  assert.equal(opened, true);
  assert.equal(manager.spawnCalls.length, 1);
  assert.equal(manager.spawnCalls[0]?.command, "powershell.exe");
  const serializedArgs = (manager.spawnCalls[0]?.args ?? []).join(" ");
  assert.equal(serializedArgs.includes("WindowStyle Maximized"), true);
  assert.equal(serializedArgs.includes("System.Windows.Forms"), false);
  assert.equal(serializedArgs.includes("F11"), false);
});

test("canQuerySession treats session listing output as not ready", async () => {
  const manager = new StubZellijManager();
  manager.listPanesStdoutOverride = "session-2 [Created 1s ago]";

  const ready = await manager.inspectCanQuerySession("session-1");

  assert.equal(ready, false);
});

test("materializePanelBindings retries pane creation when run returns a session listing", async () => {
  const manager = new StubZellijManager();
  manager.sessionNames.add("session-1");
  manager.failApplyAgentGridLayout = true;
  manager.runPaneStdoutQueue = [
    "session-2 [Created 1s ago]",
    "1",
  ];

  const bindings = await manager.materializePanelBindings({
    projectId: "project-1",
    taskId: "task-1",
    sessionName: "session-1",
    cwd: "/tmp/demo",
    agents: [{ name: "Build", opencodeSessionId: null, status: "idle" }],
  });

  assert.match(bindings[0]?.paneId ?? "", /^terminal_(1|Build)$/);
  assert.equal(
    manager.calls.filter(
      (item) =>
        item.method === "execZellij"
        && Array.isArray(item.args)
        && item.args[2] === "run",
    ).length,
    2,
  );
});
