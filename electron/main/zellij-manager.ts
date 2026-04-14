import fs from "node:fs";
import path from "node:path";
import { execFile, spawn, type SpawnOptions } from "node:child_process";
import { promisify } from "node:util";
import type { TaskPanelRecord } from "@shared/types";
import { buildZellijMissingMessage } from "@shared/zellij";
import {
  buildInlineCommand,
  buildOpencodePaneCommand,
} from "@shared/terminal-commands";
import { toOpenCodeAgentName } from "./opencode-agent-name";

const execFileAsync = promisify(execFile);

interface ZellijPaneInfo {
  id: string;
  title: string;
  isPlugin: boolean;
  exited: boolean;
  isFocused: boolean;
  isFullscreen: boolean;
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

interface AgentTerminalSpec {
  sessionName: string;
  cwd: string;
  agentName: string;
  opencodeSessionId: string | null;
}

const HIDDEN_PANEL_AGENTS = new Set<string>();

export class ZellijManager {
  private zellijAvailable: boolean | null = null;

  async isAvailable(): Promise<boolean> {
    if (this.zellijAvailable !== null) {
      return this.zellijAvailable;
    }

    try {
      await execFileAsync("zellij", ["--version"], {
        timeout: 2000,
      });
      this.zellijAvailable = true;
    } catch {
      this.zellijAvailable = false;
    }

    return this.zellijAvailable;
  }

  async assertAvailable(action: string): Promise<void> {
    if (!(await this.isAvailable())) {
      throw new Error(buildZellijMissingMessage(action));
    }
  }

  async createTaskSession(projectId: string, taskId: string): Promise<string> {
    const sessionName = `oap-${projectId.slice(0, 6)}-${taskId.slice(0, 6)}`;

    if (!(await this.isAvailable())) {
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
    await this.assertAvailable("无法打开 Zellij Session");
    await this.ensureSessionActive(sessionName);
    await this.ensureSessionLayout(sessionName);
    await this.openSessionInTerminal(sessionName, cwd);
  }

  async deleteTaskSession(sessionName: string | null | undefined): Promise<void> {
    if (!sessionName || !(await this.isAvailable())) {
      return;
    }

    await execFileAsync("zellij", ["kill-session", sessionName]).catch(async () => {
      await execFileAsync("zellij", ["delete-session", sessionName]).catch(() => undefined);
    });
  }

  async listSessionNames(): Promise<Set<string> | null> {
    if (!(await this.isAvailable())) {
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
    if (!(await this.isAvailable())) {
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
    if (!(await this.isAvailable())) {
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
    throw new Error("focusAgentPANEL 需要携带 Agent OpenCode session 信息，请改用 openAgentTerminal");
  }

  async openAgentTerminal(spec: AgentTerminalSpec): Promise<void> {
    const { shellCommand } = this.buildOpencodePaneCommand(
      spec.sessionName,
      spec.cwd,
      spec.agentName,
      spec.opencodeSessionId,
    );
    await this.openCommandInTerminal(spec.cwd, shellCommand);
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
    if (!(await this.isAvailable())) {
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
        isFocused: Boolean(pane.is_focused),
        isFullscreen: Boolean(pane.is_fullscreen),
        isFloating: Boolean(pane.is_floating),
        x: typeof pane.pane_x === "number" ? pane.pane_x : 0,
        y: typeof pane.pane_y === "number" ? pane.pane_y : 0,
        rows: typeof pane.pane_rows === "number" ? pane.pane_rows : 0,
        columns: typeof pane.pane_columns === "number" ? pane.pane_columns : 0,
      }));
  }

  private async ensureSessionLayout(sessionName: string, targetPaneId?: string): Promise<void> {
    const panes = await this.listTerminalPanes(sessionName);
    const fullscreenPane = panes.find((pane) => pane.isFullscreen && !pane.exited);

    if (!targetPaneId) {
      if (fullscreenPane) {
        await this.togglePaneFullscreen(sessionName, fullscreenPane.id);
      }
      return;
    }

    const targetPane = panes.find((pane) => pane.id === targetPaneId && !pane.exited);
    if (!targetPane) {
      throw new Error(`未找到 pane ${targetPaneId}`);
    }

    if (fullscreenPane && fullscreenPane.id !== targetPaneId) {
      await this.togglePaneFullscreen(sessionName, fullscreenPane.id);
    }

    const refreshedPanes = await this.listTerminalPanes(sessionName);
    const refreshedTargetPane = refreshedPanes.find((pane) => pane.id === targetPaneId && !pane.exited);
    if (!refreshedTargetPane) {
      throw new Error(`未找到 pane ${targetPaneId}`);
    }
    if (!refreshedTargetPane.isFullscreen) {
      await this.togglePaneFullscreen(sessionName, targetPaneId);
    }
  }

  private async togglePaneFullscreen(sessionName: string, paneId: string): Promise<void> {
    await execFileAsync("zellij", [
      "-s",
      sessionName,
      "action",
      "toggle-fullscreen",
      "-p",
      paneId,
    ]).catch(() => undefined);
  }

  private filterVisibleAgents(agents: AgentPaneSpec[]): AgentPaneSpec[] {
    return agents.filter((agent) => !HIDDEN_PANEL_AGENTS.has(agent.name));
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
    const { shellLaunch } = this.buildOpencodePaneCommand(
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
      shellLaunch.command,
      ...shellLaunch.args,
    ]);
    return stdout.trim() || `terminal_${agentName}`;
  }

  private buildOpencodePaneCommand(
    sessionName: string,
    cwd: string,
    agentName: string,
    opencodeSessionId: string | null,
  ) {
    const runtimeDir = this.ensurePaneRuntimeDir(cwd, sessionName, agentName);
    const dbPath = path.join(runtimeDir, "opencode-pane.db");
    return buildOpencodePaneCommand({
      cwd,
      runtimeDir,
      dbPath,
      agentName,
      opencodeSessionId,
      opencodeAgentName: toOpenCodeAgentName(agentName),
    });
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
    const terminalCommand = buildInlineCommand({
      command: "zellij",
      args: ["attach", sessionName, "--create"],
    });
    await this.openCommandInTerminal(cwd, terminalCommand);
  }

  private async openCommandInTerminal(cwd: string, terminalCommand: string): Promise<void> {
    if (process.platform === "darwin") {
      await this.openMacTerminalCommand(cwd, terminalCommand);
      return;
    }

    if (process.platform === "win32") {
      const openedWithWindowsTerminal = await this.spawnDetachedProcess(
        "wt",
        ["--fullscreen", "new-window", "--startingDirectory", cwd, "cmd.exe", "/k", terminalCommand],
        { cwd, windowsHide: false },
      );
      if (openedWithWindowsTerminal) {
        return;
      }

      const openedWithPowerShell = await this.openWindowsCmdSession(cwd, terminalCommand);
      if (openedWithPowerShell) {
        return;
      }

      await this.spawnDetachedProcess("cmd.exe", ["/k", terminalCommand], {
        cwd,
        windowsHide: false,
      });
      return;
    }

    const linuxOpeners: Array<{ command: string; args: string[] }> = [
      {
        command: "x-terminal-emulator",
        args: ["-e", "/bin/sh", "-lc", terminalCommand],
      },
      {
        command: "gnome-terminal",
        args: ["--", "/bin/sh", "-lc", terminalCommand],
      },
      {
        command: "konsole",
        args: ["-e", "/bin/sh", "-lc", terminalCommand],
      },
      {
        command: "xterm",
        args: ["-e", "/bin/sh", "-lc", terminalCommand],
      },
    ];

    for (const opener of linuxOpeners) {
      const opened = await this.spawnDetachedProcess(opener.command, opener.args, { cwd });
      if (opened) {
        return;
      }
    }
  }

  private async openMacTerminalCommand(cwd: string, terminalCommand: string) {
    const startupCommand = `cd ${this.shellQuote(cwd)}; exec /bin/sh -lc ${this.shellQuote(terminalCommand)}`;
    const appleScript = [
      'tell application "Terminal"',
      "reopen",
      // Always create a fresh Terminal window so opening Zellij does not depend
      // on whether Terminal was already running or what the front window is.
      `do script ${JSON.stringify(startupCommand)}`,
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

  private async openWindowsCmdSession(cwd: string, terminalCommand: string): Promise<boolean> {
    const argumentList = ["/k", terminalCommand]
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
    const { shellLaunch } = this.buildOpencodePaneCommand(
      sessionName,
      cwd,
      agent.name,
      agent.opencodeSessionId,
    );
    const size = heightPercent ? ` size="${heightPercent}%"` : "";
    return [
      `      pane command=${this.toKdlString(shellLaunch.command)} name=${this.toKdlString(agent.name)}${size} {`,
      `        args ${shellLaunch.args.map((arg) => this.toKdlString(arg)).join(" ")};`,
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
