import fs from "node:fs";
import path from "node:path";
import { execFile, spawn, type SpawnOptions } from "node:child_process";
import { promisify } from "node:util";
import type { TaskPanelRecord } from "@shared/types";

const execFileAsync = promisify(execFile);

interface ZellijPaneInfo {
  id: string;
  title: string;
  isPlugin: boolean;
  exited: boolean;
  isFloating: boolean;
  x: number;
  y: number;
  rows: number;
  columns: number;
}

interface AgentPaneSpec {
  name: string;
  opencodeSessionId: string | null;
  status?: "idle" | "running" | "success" | "failed" | "needs_revision";
}

const HIDDEN_PANEL_AGENTS = new Set<string>();

export class ZellijManager {
  async createTaskSession(projectId: string, taskId: string): Promise<string> {
    const sessionName = `oap-${projectId.slice(0, 6)}-${taskId.slice(0, 6)}`;

    if (!(await this.hasZellij())) {
      return sessionName;
    }

    try {
      await execFileAsync("zellij", ["attach", "--create-background", sessionName], {
        timeout: 4000,
      });
    } catch {
      return sessionName;
    }

    return sessionName;
  }

  async openTaskSession(sessionName: string, cwd: string): Promise<void> {
    await this.ensureSessionActive(sessionName);
    await this.openSessionInTerminal(sessionName, cwd);
  }

  async deleteTaskSession(sessionName: string | null | undefined): Promise<void> {
    if (!sessionName || !(await this.hasZellij())) {
      return;
    }

    await execFileAsync("zellij", ["kill-session", sessionName]).catch(async () => {
      await execFileAsync("zellij", ["delete-session", sessionName]).catch(() => undefined);
    });
  }

  async listSessionNames(): Promise<Set<string> | null> {
    if (!(await this.hasZellij())) {
      return null;
    }

    try {
      const { stdout } = await execFileAsync("zellij", ["list-sessions", "--no-formatting"], {
        timeout: 2000,
      });
      return new Set(this.extractActiveSessionNames(stdout));
    } catch (error) {
      if (this.isEmptySessionListError(error)) {
        return new Set();
      }
      return null;
    }
  }

  createPanelBindings(options: {
    projectId: string;
    taskId: string;
    sessionName: string;
    cwd: string;
    agents: AgentPaneSpec[];
  }): TaskPanelRecord[] {
    return this.filterVisibleAgents(options.agents).map((agent, index) => ({
      id: `${options.taskId}:${agent.name}`,
      taskId: options.taskId,
      projectId: options.projectId,
      sessionName: options.sessionName,
      paneId: `pane-${index + 1}`,
      agentName: agent.name,
      cwd: options.cwd,
      order: index,
    }));
  }

  async materializePanelBindings(options: {
    projectId: string;
    taskId: string;
    sessionName: string;
    cwd: string;
    agents: AgentPaneSpec[];
    forceRebuild?: boolean;
  }): Promise<TaskPanelRecord[]> {
    if (!(await this.hasZellij())) {
      return this.createPanelBindings(options);
    }

    await this.ensureSessionActive(options.sessionName);

    const visibleAgents = this.filterVisibleAgents(options.agents);
    const agentNames = visibleAgents.map((agent) => agent.name);
    const records: TaskPanelRecord[] = [];

    let refreshedPanes = await this.listTerminalPanes(options.sessionName);
    if (options.forceRebuild) {
      for (const pane of refreshedPanes.filter((item) => agentNames.includes(item.title))) {
        await this.closePane(options.sessionName, pane.id).catch(() => undefined);
      }
      refreshedPanes = await this.listTerminalPanes(options.sessionName);
    }

    const hadManagedPanes =
      options.forceRebuild !== true && refreshedPanes.some((pane) => agentNames.includes(pane.title));
    if (!hadManagedPanes && visibleAgents.length > 0) {
      const applied = await this.applyAgentGridLayout(
        options.sessionName,
        options.cwd,
        visibleAgents,
      ).catch(() => false);
      if (applied) {
        refreshedPanes = await this.listTerminalPanes(options.sessionName);
      } else {
        const orderedForCreation = this.getLayoutCreationOrder(visibleAgents);
        for (const agent of orderedForCreation) {
          const agentName = agent.name;
          let pane = refreshedPanes.find((item) => item.title === agentName && !item.exited);
          if (!pane) {
            const stalePane = refreshedPanes.find((item) => item.title === agentName && item.exited);
            if (stalePane) {
              await this.closePane(options.sessionName, stalePane.id).catch(() => undefined);
            }
            const paneId = await this.runAgentPane(
              options.sessionName,
              options.cwd,
              agentName,
              agent.opencodeSessionId,
            );
            pane = {
              id: paneId,
              title: agentName,
              isPlugin: false,
              exited: false,
              isFloating: false,
            };
            refreshedPanes = [...refreshedPanes.filter((item) => item.id !== paneId), pane];
          }
        }
      }
    } else {
      for (const agent of visibleAgents) {
        const agentName = agent.name;
        let pane = refreshedPanes.find((item) => item.title === agentName && !item.exited);
        if (!pane) {
          const stalePane = refreshedPanes.find((item) => item.title === agentName && item.exited);
          if (stalePane) {
            await this.closePane(options.sessionName, stalePane.id).catch(() => undefined);
          }
          const paneId = await this.runAgentPane(
            options.sessionName,
            options.cwd,
            agentName,
            agent.opencodeSessionId,
          );
          pane = {
            id: paneId,
            title: agentName,
            isPlugin: false,
            exited: false,
            isFloating: false,
          };
          refreshedPanes = [...refreshedPanes.filter((item) => item.id !== paneId), pane];
        }
      }
    }

    for (const agent of visibleAgents) {
      const pane = refreshedPanes.find((item) => item.title === agent.name && !item.exited);
      if (!pane) {
        continue;
      }
      records.push({
        id: `${options.taskId}:${agent.name}`,
        taskId: options.taskId,
        projectId: options.projectId,
        sessionName: options.sessionName,
        paneId: pane.id,
        agentName: agent.name,
        cwd: options.cwd,
        order: visibleAgents.findIndex((item) => item.name === agent.name),
      });
    }

    if (!hadManagedPanes) {
      for (const pane of refreshedPanes.filter((item) => !item.exited && !agentNames.includes(item.title))) {
        await this.closePane(options.sessionName, pane.id).catch(() => undefined);
      }
    }

    return records;
  }

  async dispatchTaskToPane(panel: TaskPanelRecord, content: string): Promise<void> {
    if (!(await this.hasZellij())) {
      return;
    }

    await execFileAsync("zellij", [
      "-s",
      panel.sessionName,
      "action",
      "write-chars",
      "-p",
      panel.paneId,
      content,
    ]).catch(() => undefined);
    await execFileAsync("zellij", [
      "-s",
      panel.sessionName,
      "action",
      "send-keys",
      "-p",
      panel.paneId,
      "Enter",
    ]).catch(() => undefined);
  }

  async focusAgentPANEL(panel: TaskPanelRecord): Promise<void> {
    if (!(await this.hasZellij())) {
      return;
    }

    await this.ensureSessionActive(panel.sessionName);

    await execFileAsync("zellij", [
      "-s",
      panel.sessionName,
      "action",
      "focus-pane-id",
      panel.paneId,
    ]).catch(() => undefined);
    await this.openSessionInTerminal(panel.sessionName, panel.cwd);
  }

  private async hasZellij(): Promise<boolean> {
    try {
      await execFileAsync("zellij", ["--version"], {
        timeout: 2000,
      });
      return true;
    } catch {
      return false;
    }
  }

  private isEmptySessionListError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    const execError = error as Error & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    const combined = [execError.stdout, execError.stderr, execError.message]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .join("\n")
      .toLowerCase();

    return (
      combined.includes("no active zellij sessions") ||
      combined.includes("no zellij sessions") ||
      combined.includes("no sessions") ||
      (execError.code === 1 && combined.length === 0)
    );
  }

  private extractActiveSessionNames(output: string): string[] {
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !line.toLowerCase().includes("(exited"))
      .map((line) => line.split(/\s+/, 1)[0] ?? "")
      .filter(Boolean);
  }

  private async ensureSessionActive(sessionName: string): Promise<void> {
    if (!(await this.hasZellij())) {
      return;
    }

    const activeSessions = await this.listSessionNames();
    if (activeSessions?.has(sessionName)) {
      return;
    }

    await execFileAsync("zellij", ["attach", "--create-background", sessionName], {
      timeout: 4000,
    });
  }

  private async listTerminalPanes(sessionName: string): Promise<ZellijPaneInfo[]> {
    const { stdout } = await execFileAsync("zellij", [
      "-s",
      sessionName,
      "action",
      "list-panes",
      "-j",
      "-a",
      "-g",
      "-s",
      "-t",
    ]);
    const parsed = JSON.parse(stdout) as Array<Record<string, unknown>>;
    return parsed
      .filter((pane) => !pane.is_plugin)
      .map((pane) => ({
        id: `terminal_${pane.id}`,
        title: typeof pane.title === "string" ? pane.title : `terminal_${pane.id}`,
        isPlugin: false,
        exited: Boolean(pane.exited),
        isFloating: Boolean(pane.is_floating),
        x: typeof pane.pane_x === "number" ? pane.pane_x : 0,
        y: typeof pane.pane_y === "number" ? pane.pane_y : 0,
        rows: typeof pane.pane_rows === "number" ? pane.pane_rows : 0,
        columns: typeof pane.pane_columns === "number" ? pane.pane_columns : 0,
      }));
  }

  private filterVisibleAgents(agents: AgentPaneSpec[]): AgentPaneSpec[] {
    return agents.filter((agent) => !HIDDEN_PANEL_AGENTS.has(agent.name));
  }

  private getOpencodeAgentName(agentName: string): string {
    if (agentName === "Build") {
      return "build";
    }
    return agentName;
  }

  private async closePane(sessionName: string, paneId: string): Promise<void> {
    await execFileAsync("zellij", [
      "-s",
      sessionName,
      "action",
      "close-pane",
      "-p",
      paneId,
    ]);
  }

  private async runAgentPane(
    sessionName: string,
    cwd: string,
    agentName: string,
    opencodeSessionId: string | null,
  ): Promise<string> {
    const shellCommand = this.buildOpencodeShellCommand(
      sessionName,
      cwd,
      agentName,
      opencodeSessionId,
    );
    const { stdout } = await execFileAsync("zellij", [
      "-s",
      sessionName,
      "run",
      "--name",
      agentName,
      "--cwd",
      cwd,
      "--",
      "/bin/sh",
      "-c",
      shellCommand,
    ]);
    return stdout.trim() || `terminal_${agentName}`;
  }

  private buildOpencodeShellCommand(
    sessionName: string,
    cwd: string,
    agentName: string,
    opencodeSessionId: string | null,
  ): string {
    const escapedCwd = cwd.replace(/'/g, "'\\''");
    const escapedAgentName = this.getOpencodeAgentName(agentName).replace(/'/g, "'\\''");
    const escapedSessionId = opencodeSessionId?.replace(/'/g, "'\\''");
    const runtimeDir = this.ensurePaneRuntimeDir(cwd, sessionName, agentName);
    const escapedRuntimeDir = runtimeDir.replace(/'/g, "'\\''");
    const dbPath = path.join(runtimeDir, "opencode-pane.db");
    const escapedDbPath = dbPath.replace(/'/g, "'\\''");

    if (escapedSessionId) {
      return [
        `mkdir -p '${escapedRuntimeDir}'`,
        "&&",
        `cd '${escapedCwd}'`,
        "&&",
        `export OPENCODE_CONFIG_DIR='${escapedRuntimeDir}'`,
        `OPENCODE_DB='${escapedDbPath}'`,
        "OPENCODE_CLIENT='agentflow-zellij'",
        "&&",
        "exec opencode attach 'http://127.0.0.1:4096'",
        `--session '${escapedSessionId}'`,
        `--dir '${escapedCwd}'`,
      ]
        .filter(Boolean)
        .join(" ");
    }

    return [
      `mkdir -p '${escapedRuntimeDir}'`,
      "&&",
      `cd '${escapedCwd}'`,
      "&&",
      `export OPENCODE_CONFIG_DIR='${escapedRuntimeDir}'`,
      `OPENCODE_DB='${escapedDbPath}'`,
      "OPENCODE_CLIENT='agentflow-zellij'",
      "&&",
      "exec opencode .",
      `--agent '${escapedAgentName}'`,
      escapedSessionId ? `--session '${escapedSessionId}'` : "",
    ]
      .filter(Boolean)
      .join(" ");
  }

  private ensurePaneRuntimeDir(cwd: string, sessionName: string, agentName: string): string {
    const runtimeDir = path.join(
      cwd,
      ".agentflow",
      "opencode-pane-runtime",
      this.sanitizePathSegment(sessionName),
      this.sanitizePathSegment(agentName),
    );
    fs.mkdirSync(runtimeDir, { recursive: true });
    return runtimeDir;
  }

  private sanitizePathSegment(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]/g, "_");
  }

  private async openSessionInTerminal(sessionName: string, cwd: string): Promise<void> {
    const attachArgs = ["attach", sessionName, "--create"];

    if (process.platform === "darwin") {
      await this.openMacTerminalSession(sessionName, cwd, attachArgs);
      return;
    }

    if (process.platform === "win32") {
      const openedWithWindowsTerminal = await this.spawnDetachedProcess(
        "wt",
        ["--fullscreen", "new-window", "--startingDirectory", cwd, "zellij", ...attachArgs],
        { cwd, windowsHide: false },
      );
      if (openedWithWindowsTerminal) {
        return;
      }

      const openedWithPowerShell = await this.openWindowsCmdSession(cwd, attachArgs);
      if (openedWithPowerShell) {
        return;
      }

      await this.spawnDetachedProcess("cmd.exe", ["/k", "zellij", ...attachArgs], {
        cwd,
        windowsHide: false,
      });
      return;
    }

    const linuxOpeners: Array<{ command: string; args: string[] }> = [
      {
        command: "x-terminal-emulator",
        args: ["-e", "zellij", ...attachArgs],
      },
      {
        command: "gnome-terminal",
        args: ["--", "zellij", ...attachArgs],
      },
      {
        command: "konsole",
        args: ["-e", "zellij", ...attachArgs],
      },
      {
        command: "xterm",
        args: ["-e", "zellij", ...attachArgs],
      },
    ];

    for (const opener of linuxOpeners) {
      const opened = await this.spawnDetachedProcess(opener.command, opener.args, { cwd });
      if (opened) {
        return;
      }
    }
  }

  private async openMacTerminalSession(_sessionName: string, cwd: string, attachArgs: string[]) {
    const terminalCommand = ["zellij", ...attachArgs].map((part) => this.shellQuote(part)).join(" ");
    const startupCommand = `cd ${this.shellQuote(cwd)}; exec ${terminalCommand}`;
    const appleScript = [
      'set terminalWasRunning to application "Terminal" is running',
      'tell application "Terminal"',
      'if terminalWasRunning then',
      "if (count of windows) = 0 then",
      "reopen",
      "end if",
      `do script ${JSON.stringify(startupCommand)} in front window`,
      "else",
      "reopen",
      `do script ${JSON.stringify(startupCommand)} in window 1`,
      "end if",
      "activate",
      "end tell",
      "delay 0.25",
      'tell application "System Events"',
      'tell process "Terminal"',
      "if not (exists front window) then",
      "return",
      "end if",
      "try",
      'set isFullscreen to value of attribute "AXFullScreen" of front window',
      "on error",
      "set isFullscreen to false",
      "end try",
      "if isFullscreen is false then",
      'keystroke "f" using {command down, control down}',
      "end if",
      "end tell",
      "end tell",
    ];
    await this.spawnDetachedProcess("osascript", appleScript.flatMap((line) => ["-e", line]));
  }

  private async openWindowsCmdSession(cwd: string, attachArgs: string[]): Promise<boolean> {
    const argumentList = ["/k", "zellij", ...attachArgs]
      .map((part) => `'${this.escapePowerShellSingleQuotedString(part)}'`)
      .join(", ");
    const powerShellScript = [
      "Add-Type -AssemblyName Microsoft.VisualBasic",
      "Add-Type -AssemblyName System.Windows.Forms",
      `$proc = Start-Process -FilePath 'cmd.exe' -WorkingDirectory '${this.escapePowerShellSingleQuotedString(cwd)}' -ArgumentList @(${argumentList}) -PassThru`,
      "Start-Sleep -Milliseconds 450",
      "try { [Microsoft.VisualBasic.Interaction]::AppActivate($proc.Id) } catch { }",
      "Start-Sleep -Milliseconds 120",
      "try { [System.Windows.Forms.SendKeys]::SendWait('{F11}') } catch { }",
    ].join("; ");

    return this.spawnDetachedProcess(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-WindowStyle",
        "Hidden",
        "-Command",
        powerShellScript,
      ],
      { cwd, windowsHide: true },
    );
  }

  private spawnDetachedProcess(
    command: string,
    args: string[],
    options: Omit<SpawnOptions, "detached" | "stdio"> = {},
  ): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const child = spawn(command, args, {
        ...options,
        detached: true,
        stdio: "ignore",
      });

      const finalize = (opened: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        if (opened) {
          child.unref();
        }
        resolve(opened);
      };

      child.once("spawn", () => finalize(true));
      child.once("error", () => finalize(false));
    });
  }

  private shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
  }

  private escapePowerShellSingleQuotedString(value: string): string {
    return value.replace(/'/g, "''");
  }

  private getLayoutCreationOrder(agents: AgentPaneSpec[]): AgentPaneSpec[] {
    return agents.slice();
  }

  private async applyAgentGridLayout(
    sessionName: string,
    cwd: string,
    agents: AgentPaneSpec[],
  ): Promise<boolean> {
    const layout = this.buildAgentGridLayout(sessionName, cwd, agents);
    if (!layout) {
      return false;
    }

    await execFileAsync("zellij", [
      "-s",
      sessionName,
      "action",
      "override-layout",
      "--layout-string",
      layout,
    ]);
    return true;
  }

  private buildAgentGridLayout(
    sessionName: string,
    cwd: string,
    agents: AgentPaneSpec[],
  ): string | null {
    if (agents.length === 0) {
      return null;
    }

    const columns = this.partitionAgentsForGrid(agents);
    const columnWidths = this.distributePercentages(columns.length);
    const body = columns
      .map((column, index) =>
        this.buildGridColumnKdl(sessionName, cwd, column, columnWidths[index] ?? 100),
      )
      .join("\n");

    return [
      "layout {",
      `  cwd ${this.toKdlString(cwd)}`,
      '  tab name="Tab #1" focus=true {',
      "    pane size=1 borderless=true {",
      '      plugin location="zellij:tab-bar";',
      "    }",
      '    pane split_direction="vertical" {',
      body,
      "    }",
      "    pane size=1 borderless=true {",
      '      plugin location="zellij:status-bar";',
      "    }",
      "  }",
      "}",
    ].join("\n");
  }

  private buildGridColumnKdl(
    sessionName: string,
    cwd: string,
    agents: AgentPaneSpec[],
    widthPercent: number,
  ): string {
    const paneHeights = this.distributePercentages(agents.length);
    const panes = agents
      .map((agent, index) =>
        this.buildAgentPaneKdl(
          sessionName,
          cwd,
          agent,
          agents.length > 1 ? paneHeights[index] ?? null : null,
        ),
      )
      .join("\n");

    return [
      `      pane size="${widthPercent}%" split_direction="horizontal" {`,
      panes,
      "      }",
    ].join("\n");
  }

  private buildAgentPaneKdl(
    sessionName: string,
    cwd: string,
    agent: AgentPaneSpec,
    heightPercent: number | null,
  ): string {
    const shellCommand = this.buildOpencodeShellCommand(
      sessionName,
      cwd,
      agent.name,
      agent.opencodeSessionId,
    );
    const size = heightPercent ? ` size="${heightPercent}%"` : "";
    return [
      `      pane command=${this.toKdlString("/bin/sh")} name=${this.toKdlString(agent.name)}${size} {`,
      `        args ${this.toKdlString("-c")} ${this.toKdlString(shellCommand)};`,
      "      }",
    ].join("\n");
  }

  private partitionAgentsForGrid(agents: AgentPaneSpec[]): AgentPaneSpec[][] {
    if (agents.length <= 1) {
      return [agents.slice()];
    }

    const columnCount = Math.min(3, Math.ceil(Math.sqrt(agents.length)));
    const columns = Array.from({ length: columnCount }, () => [] as AgentPaneSpec[]);

    for (const [index, agent] of agents.entries()) {
      columns[index % columnCount]?.push(agent);
    }

    return columns.filter((column) => column.length > 0);
  }

  private toKdlString(value: string): string {
    return JSON.stringify(value);
  }

  private distributePercentages(count: number): number[] {
    if (count <= 0) {
      return [];
    }

    const base = Math.floor(100 / count);
    const remainder = 100 % count;
    return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0));
  }
}
