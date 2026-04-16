import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { execFile, spawn, type SpawnOptions } from "node:child_process";
import { promisify } from "node:util";
import { type TaskPanelRecord } from "@shared/types";
import { buildZellijMissingMessage } from "@shared/zellij";
import {
  buildInlineCommand,
  buildOpencodePaneCommand,
  buildWindowsOpencodePaneScript,
  quoteInlineCommandArg,
} from "@shared/terminal-commands";
import { appendAppLog } from "./app-log";
import { toOpenCodeAgentName } from "./opencode-agent-name";
import { resolveZellijExecutable } from "./zellij-executable";

const execFileAsync = promisify(execFile);
const DEFAULT_OPENCODE_ATTACH_BASE_URL = "http://127.0.0.1:4096";
type ExecFileOptions = Parameters<typeof execFile>[2];

interface ZellijPaneInfo {
  id: string;
  title: string;
  command: string | null;
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
  status?: "idle" | "running" | "completed" | "failed" | "needs_revision";
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
  private opencodeAttachBaseUrl = DEFAULT_OPENCODE_ATTACH_BASE_URL;

  protected getHostPlatform(): NodeJS.Platform {
    return process.platform;
  }

  protected getZellijCommand(): string {
    return resolveZellijExecutable().command;
  }

  protected async execZellij(args: string[], options?: ExecFileOptions) {
    const command = this.getZellijCommand();
    try {
      return await execFileAsync(command, args, options);
    } catch (error) {
      this.logCommandFailure(command, args, options, error);
      throw error;
    }
  }

  async isAvailable(): Promise<boolean> {
    if (this.zellijAvailable !== null) {
      return this.zellijAvailable;
    }

    try {
      const resolved = resolveZellijExecutable();
      if (resolved.bundled && !resolved.available) {
        this.zellijAvailable = false;
        return this.zellijAvailable;
      }

      await execFileAsync(resolved.command, ["--version"], {
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

  setOpenCodeAttachBaseUrl(baseUrl: string) {
    const normalized = baseUrl.trim();
    this.opencodeAttachBaseUrl = normalized || DEFAULT_OPENCODE_ATTACH_BASE_URL;
  }

  async createTaskSession(projectId: string, taskId: string): Promise<string> {
    const sessionName = `oap-${projectId.slice(0, 6)}-${taskId.slice(0, 6)}`;

    if (!(await this.isAvailable())) {
      return sessionName;
    }

    await this.startBackgroundSession(sessionName);

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

    await this.execZellij(["kill-session", sessionName]).catch(async () => {
      await this.execZellij(["delete-session", sessionName]).catch(() => undefined);
    });
  }

  async listSessionNames(): Promise<Set<string> | null> {
    if (!(await this.isAvailable())) {
      return null;
    }

    try {
      const { stdout } = await this.execZellij(["list-sessions", "--no-formatting"], {
        timeout: 5000,
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
    const records: TaskPanelRecord[] = [];

    let refreshedPanes = await this.listTerminalPanes(options.sessionName);
    if (options.forceRebuild) {
      for (const pane of refreshedPanes.filter((item) =>
        visibleAgents.some((agent) =>
          this.matchesAgentPane(item, options.sessionName, options.cwd, agent.name),
        ))) {
        await this.closePane(options.sessionName, pane.id).catch(() => undefined);
      }
      refreshedPanes = await this.listTerminalPanes(options.sessionName);
    }

    const hadManagedPanes =
      options.forceRebuild !== true && refreshedPanes.some((pane) =>
        visibleAgents.some((agent) =>
          this.matchesAgentPane(pane, options.sessionName, options.cwd, agent.name),
        ));
    if (!hadManagedPanes && visibleAgents.length > 0) {
      const applied = await this.applyAgentGridLayout(
        options.sessionName,
        options.cwd,
        visibleAgents,
      ).catch(() => false);
      if (applied) {
        refreshedPanes = await this.listTerminalPanes(options.sessionName);
      } else {
        await this.ensureSessionActive(options.sessionName).catch(() => undefined);
        refreshedPanes = await this.listTerminalPanes(options.sessionName).catch(() => []);
        const orderedForCreation = this.getLayoutCreationOrder(visibleAgents);
        for (const agent of orderedForCreation) {
          const agentName = agent.name;
          let pane = refreshedPanes.find((item) =>
            this.matchesAgentPane(item, options.sessionName, options.cwd, agentName) && !item.exited);
          if (!pane) {
            const stalePane = refreshedPanes.find((item) =>
              this.matchesAgentPane(item, options.sessionName, options.cwd, agentName) && item.exited);
            if (stalePane) {
              await this.closePane(options.sessionName, stalePane.id).catch(() => undefined);
            }
            const paneId = await this.runAgentPaneWithRecovery(
              options.sessionName,
              options.cwd,
              agentName,
              agent.opencodeSessionId,
            );
            pane = {
              id: paneId,
              title: agentName,
              command: null,
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
        let pane = refreshedPanes.find((item) =>
          this.matchesAgentPane(item, options.sessionName, options.cwd, agentName) && !item.exited);
        if (!pane) {
          const stalePane = refreshedPanes.find((item) =>
            this.matchesAgentPane(item, options.sessionName, options.cwd, agentName) && item.exited);
          if (stalePane) {
            await this.closePane(options.sessionName, stalePane.id).catch(() => undefined);
          }
          const paneId = await this.runAgentPaneWithRecovery(
            options.sessionName,
            options.cwd,
            agentName,
            agent.opencodeSessionId,
          );
          pane = {
            id: paneId,
            title: agentName,
            command: null,
            isPlugin: false,
            exited: false,
            isFloating: false,
          };
          refreshedPanes = [...refreshedPanes.filter((item) => item.id !== paneId), pane];
        }
      }
    }

    for (const agent of visibleAgents) {
      const pane = refreshedPanes.find((item) =>
        this.matchesAgentPane(item, options.sessionName, options.cwd, agent.name) && !item.exited);
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
      for (const pane of refreshedPanes.filter((item) =>
        !item.exited
        && !visibleAgents.some((agent) =>
          this.matchesAgentPane(item, options.sessionName, options.cwd, agent.name)))) {
        await this.closePane(options.sessionName, pane.id).catch(() => undefined);
      }
    }

    return records;
  }

  async dispatchTaskToPane(panel: TaskPanelRecord, content: string): Promise<void> {
    if (!(await this.isAvailable())) {
      return;
    }

    await this.execZellij([
      "-s",
      panel.sessionName,
      "action",
      "write-chars",
      "-p",
      panel.paneId,
      content,
    ]).catch(() => undefined);
    await this.execZellij([
      "-s",
      panel.sessionName,
      "action",
      "send-keys",
      "-p",
      panel.paneId,
      "Enter",
    ]).catch(() => undefined);
  }

  async openAgentTerminal(spec: AgentTerminalSpec): Promise<void> {
    await this.waitForOpenCodeAttachReady();
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

  protected async ensureSessionActive(sessionName: string): Promise<void> {
    if (!(await this.isAvailable())) {
      return;
    }

    const activeSessions = await this.listSessionNames();
    if (activeSessions?.has(sessionName)) {
      return;
    }

    await this.startBackgroundSession(sessionName);
  }

  protected async startBackgroundSession(sessionName: string): Promise<void> {
    if (this.getHostPlatform() === "win32") {
      const spawned = await this.spawnDetachedProcess(
        "cmd.exe",
        [
          "/c",
          "start",
          "\"\"",
          "/min",
          this.getZellijCommand(),
          "attach",
          sessionName,
          "--create",
        ],
        {
          cwd: process.cwd(),
          windowsHide: true,
        },
      );
      if (!spawned) {
        throw new Error(`Failed to start detached Zellij session: ${sessionName}`);
      }
      await this.waitForSessionReady(sessionName, 15_000);
      return;
    }

    await this.execZellij(["attach", "--create-background", sessionName], {
      timeout: 4000,
    });
    await this.waitForSessionReady(sessionName);
  }

  protected async listTerminalPanes(sessionName: string): Promise<ZellijPaneInfo[]> {
    const loadPanes = async () => {
      const { stdout } = await this.execZellij([
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
      const parsed = this.parseListPanesOutput(sessionName, stdout);
      return parsed
        .filter((pane) => !pane.is_plugin)
        .map((pane) => ({
          id: `terminal_${pane.id}`,
          title: typeof pane.title === "string" ? pane.title : `terminal_${pane.id}`,
          command: typeof pane.pane_command === "string" ? pane.pane_command : null,
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
    };

    try {
      return await loadPanes();
    } catch (error) {
      if (!this.isSessionNotFoundError(error)) {
        throw error;
      }
      await this.waitForSessionReady(sessionName, 5_000);
      return loadPanes();
    }
  }

  protected async ensureSessionLayout(sessionName: string, targetPaneId?: string): Promise<void> {
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

  protected async togglePaneFullscreen(sessionName: string, paneId: string): Promise<void> {
    await this.execZellij([
      "-s",
      sessionName,
      "action",
      "toggle-fullscreen",
      "-p",
      paneId,
    ]).catch(() => undefined);
  }

  protected filterVisibleAgents(agents: AgentPaneSpec[]): AgentPaneSpec[] {
    return agents.filter((agent) => !HIDDEN_PANEL_AGENTS.has(agent.name));
  }

  protected matchesAgentPane(
    pane: Pick<ZellijPaneInfo, "title" | "command">,
    sessionName: string,
    cwd: string,
    agentName: string,
  ): boolean {
    if (pane.title === agentName) {
      return true;
    }
    if (this.getHostPlatform() !== "win32" || !pane.command) {
      return false;
    }

    const launcherPath = this.joinPlatformPath(
      this.ensurePaneRuntimeDir(cwd, sessionName, agentName),
      "launch-pane.cmd",
    );
    const normalizedCommand = pane.command.replace(/\//g, "\\").toLowerCase();
    return normalizedCommand.includes(launcherPath.toLowerCase());
  }

  protected async closePane(sessionName: string, paneId: string): Promise<void> {
    await this.execZellij([
      "-s",
      sessionName,
      "action",
      "close-pane",
      "-p",
      paneId,
    ]);
  }

  protected async runAgentPane(
    sessionName: string,
    cwd: string,
    agentName: string,
    opencodeSessionId: string | null,
  ): Promise<string> {
    await this.waitForOpenCodeAttachReady();
    const { shellLaunch } = this.buildOpencodePaneCommand(
      sessionName,
      cwd,
      agentName,
      opencodeSessionId,
    );
    const { stdout } = await this.execZellij([
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
    return this.parseRunPaneOutput(sessionName, agentName, stdout);
  }

  protected async runAgentPaneWithRecovery(
    sessionName: string,
    cwd: string,
    agentName: string,
    opencodeSessionId: string | null,
  ): Promise<string> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.runAgentPane(sessionName, cwd, agentName, opencodeSessionId);
      } catch (error) {
        lastError = error;
        if (attempt === 0 && this.isSessionNotFoundError(error)) {
          await this.ensureSessionActive(sessionName);
          await this.waitForSessionReady(sessionName, 5_000);
          continue;
        }
        throw error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  protected buildOpencodePaneCommand(
    sessionName: string,
    cwd: string,
    agentName: string,
    opencodeSessionId: string | null,
  ) {
    const runtimeDir = this.ensurePaneRuntimeDir(cwd, sessionName, agentName);
    const dbPath = path.join(runtimeDir, "opencode-pane.db");
    const paneCommand = buildOpencodePaneCommand({
      cwd,
      runtimeDir,
      dbPath,
      agentName,
      opencodeSessionId,
      opencodeAgentName: toOpenCodeAgentName(agentName),
      attachBaseUrl: this.opencodeAttachBaseUrl,
    });
    if (this.getHostPlatform() !== "win32") {
      return paneCommand;
    }

    const launcherPath = this.ensureWindowsPaneLauncher(
      runtimeDir,
      buildWindowsOpencodePaneScript({
        cwd,
        runtimeDir,
        dbPath,
        agentName,
        opencodeSessionId,
        opencodeAgentName: toOpenCodeAgentName(agentName),
        attachBaseUrl: this.opencodeAttachBaseUrl,
        platform: "win32",
      }),
    );
    const launcherCommand = `cmd.exe /d /s /c ${quoteInlineCommandArg(launcherPath, "win32")}`;
    return {
      shellCommand: launcherCommand,
      shellLaunch: {
        command: "cmd.exe",
        args: ["/d", "/s", "/c", launcherPath],
      },
    };
  }

  protected ensurePaneRuntimeDir(cwd: string, sessionName: string, agentName: string): string {
    const runtimeDir = this.joinPlatformPath(
      cwd,
      ".agentflow",
      "opencode-pane-runtime",
      this.sanitizePathSegment(sessionName),
      this.sanitizePathSegment(agentName),
    );
    fs.mkdirSync(runtimeDir, { recursive: true });
    return runtimeDir;
  }

  protected sanitizePathSegment(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]/g, "_");
  }

  protected ensureWindowsPaneLauncher(runtimeDir: string, shellCommand: string): string {
    const launcherPath = this.joinPlatformPath(runtimeDir, "launch-pane.cmd");
    const normalizedContent = shellCommand.startsWith("@echo off")
      ? `${shellCommand}\r\n`
      : ["@echo off", shellCommand, ""].join("\r\n");
    fs.writeFileSync(
      launcherPath,
      normalizedContent,
      "utf8",
    );
    return launcherPath;
  }

  protected joinPlatformPath(...segments: string[]): string {
    return this.getHostPlatform() === "win32"
      ? path.win32.join(...segments)
      : path.join(...segments);
  }

  protected async waitForOpenCodeAttachReady(timeoutMs = 8_000): Promise<boolean> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (await this.isOpenCodeAttachHealthy()) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  }

  protected async isOpenCodeAttachHealthy(timeoutMs = 500): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.opencodeAttachBaseUrl}/global/health`, {
        signal: controller.signal,
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  protected async openSessionInTerminal(sessionName: string, cwd: string): Promise<void> {
    const terminalCommand = buildInlineCommand({
      command: this.getZellijCommand(),
      args: ["attach", sessionName, "--create"],
    });
    await this.openCommandInTerminal(cwd, terminalCommand);
  }

  protected async openCommandInTerminal(cwd: string, terminalCommand: string): Promise<void> {
    if (this.getHostPlatform() === "darwin") {
      await this.openMacTerminalCommand(cwd, terminalCommand);
      return;
    }

    if (this.getHostPlatform() === "win32") {
      const windowsTerminalCommand = this.resolveWindowsInteractiveTerminalCommand(terminalCommand);
      const openedWithWindowsTerminal = await this.spawnDetachedProcess(
        "wt",
        this.buildWindowsTerminalArgs(cwd, windowsTerminalCommand),
        { cwd, windowsHide: false },
      );
      if (openedWithWindowsTerminal) {
        return;
      }

      const openedWithPowerShell = await this.openWindowsCmdSession(cwd, windowsTerminalCommand);
      if (openedWithPowerShell) {
        return;
      }

      const fallbackArgs = this.buildWindowsCmdInteractiveArgs(windowsTerminalCommand);
      await this.spawnDetachedProcess("cmd.exe", [
        "/c",
        "start",
        "\"\"",
        "/max",
        "cmd.exe",
        ...fallbackArgs,
      ], {
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

  protected buildWindowsTerminalArgs(
    cwd: string,
    terminalCommand: { command: string; args: string[] },
  ): string[] {
    return [
      "--maximized",
      "-w",
      "-1",
      "new-tab",
      "-d",
      cwd,
      terminalCommand.command,
      ...terminalCommand.args,
    ];
  }

  protected resolveWindowsInteractiveTerminalCommand(terminalCommand: string): {
    command: string;
    args: string[];
  } {
    const launcherPath = this.extractWindowsCmdLauncherPath(terminalCommand);
    if (launcherPath) {
      return {
        command: "cmd.exe",
        args: ["/k", launcherPath],
      };
    }

    return {
      command: "cmd.exe",
      args: ["/k", terminalCommand],
    };
  }

  protected extractWindowsCmdLauncherPath(terminalCommand: string): string | null {
    const matched = terminalCommand.match(/^cmd(?:\.exe)?\s+\/d\s+\/s\s+\/c\s+"(.+)"$/iu);
    if (!matched) {
      return null;
    }
    return matched[1] ?? null;
  }

  protected buildWindowsCmdInteractiveArgs(terminalCommand: {
    command: string;
    args: string[];
  }): string[] {
    if (terminalCommand.command.toLowerCase() !== "cmd.exe") {
      return ["/k", buildInlineCommand({
        command: terminalCommand.command,
        args: terminalCommand.args,
        platform: "win32",
      })];
    }
    return [...terminalCommand.args];
  }

  protected async openMacTerminalCommand(cwd: string, terminalCommand: string) {
    const startupCommand = `cd ${this.shellQuote(cwd)}; exec /bin/sh -lc ${this.shellQuote(terminalCommand)}`;
    const appleScript = [
      'tell application "Terminal"',
      // `do script` already opens a fresh Terminal window. Calling `reopen`
      // first leaves an extra login shell window behind when Terminal had no
      // front window, which looks like an empty popup before Zellij attaches.
      `do script ${JSON.stringify(startupCommand)}`,
      "activate",
      "end tell",
      "delay 0.25",
      "set desktopBounds to missing value",
      "try",
      'tell application "Finder"',
      "set desktopBounds to bounds of window of desktop",
      "end tell",
      "end try",
      'tell application "System Events"',
      'tell process "Terminal"',
      "if not (exists front window) then",
      "return",
      "end if",
      "set frontTerminalWindow to front window",
      "try",
      'set isFullscreen to value of attribute "AXFullScreen" of frontTerminalWindow',
      "on error",
      "set isFullscreen to false",
      "end try",
      "if isFullscreen is true then",
      'set value of attribute "AXFullScreen" of frontTerminalWindow to false',
      "delay 0.2",
      "end if",
      "try",
      'set isZoomed to value of attribute "AXZoomed" of frontTerminalWindow',
      "on error",
      "set isZoomed to false",
      "end try",
      "if desktopBounds is missing value and isZoomed is false then",
      "try",
      'set value of attribute "AXZoomed" of frontTerminalWindow to true',
      "on error",
      "try",
      'click (first button of frontTerminalWindow whose subrole is "AXZoomButton")',
      "end try",
      "end try",
      "end if",
      "end tell",
      "end tell",
      "if desktopBounds is not missing value then",
      'tell application "Terminal"',
      "try",
      "set bounds of front window to desktopBounds",
      "end try",
      "activate",
      "end tell",
      "end if",
    ];
    await this.spawnDetachedProcess("osascript", appleScript.flatMap((line) => ["-e", line]));
  }

  protected async openWindowsCmdSession(
    cwd: string,
    terminalCommand: { command: string; args: string[] },
  ): Promise<boolean> {
    const argumentList = terminalCommand.args
      .map((part) => `'${this.escapePowerShellSingleQuotedString(part)}'`)
      .join(", ");
    const powerShellScript = [
      "Add-Type -AssemblyName Microsoft.VisualBasic",
      `$proc = Start-Process -FilePath '${this.escapePowerShellSingleQuotedString(terminalCommand.command)}' -WorkingDirectory '${this.escapePowerShellSingleQuotedString(cwd)}' -ArgumentList @(${argumentList}) -WindowStyle Maximized -PassThru`,
      "Start-Sleep -Milliseconds 450",
      "try { [Microsoft.VisualBasic.Interaction]::AppActivate($proc.Id) } catch { }",
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

  protected spawnDetachedProcess(
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

  protected shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
  }

  protected escapePowerShellSingleQuotedString(value: string): string {
    return value.replace(/'/g, "''");
  }

  protected getLayoutCreationOrder(agents: AgentPaneSpec[]): AgentPaneSpec[] {
    return agents.slice();
  }

  protected async applyAgentGridLayout(
    sessionName: string,
    cwd: string,
    agents: AgentPaneSpec[],
  ): Promise<boolean> {
    const layout = this.buildAgentGridLayout(sessionName, cwd, agents);
    if (!layout) {
      return false;
    }

    await this.execZellij([
      "-s",
      sessionName,
      "action",
      "override-layout",
      "--layout-string",
      layout,
    ]);
    return true;
  }

  protected buildAgentGridLayout(
    sessionName: string,
    cwd: string,
    agents: AgentPaneSpec[],
  ): string | null {
    if (agents.length === 0) {
      return null;
    }

    const rows = this.partitionAgentsForGrid(agents);
    const rowHeights = this.distributePercentages(rows.length);
    const body = rows
      .map((row, index) =>
        this.buildGridRowKdl(sessionName, cwd, row, rowHeights[index] ?? 100),
      )
      .join("\n");

    return [
      "layout {",
      `  cwd ${this.toKdlString(cwd)}`,
      '  tab name="Tab #1" focus=true {',
      "    pane size=1 borderless=true {",
      '      plugin location="zellij:tab-bar";',
      "    }",
      '    pane split_direction="horizontal" {',
      body,
      "    }",
      "    pane size=1 borderless=true {",
      '      plugin location="zellij:status-bar";',
      "    }",
      "  }",
      "}",
    ].join("\n");
  }

  protected buildGridRowKdl(
    sessionName: string,
    cwd: string,
    agents: AgentPaneSpec[],
    heightPercent: number,
  ): string {
    const paneWidths = this.distributePercentages(agents.length);
    const panes = agents
      .map((agent, index) =>
        this.buildAgentPaneKdl(
          sessionName,
          cwd,
          agent,
          agents.length > 1 ? paneWidths[index] ?? null : null,
        ),
      )
      .join("\n");

    return [
      `      pane size="${heightPercent}%" split_direction="vertical" {`,
      panes,
      "      }",
    ].join("\n");
  }

  protected buildAgentPaneKdl(
    sessionName: string,
    cwd: string,
    agent: AgentPaneSpec,
    widthPercent: number | null,
  ): string {
    const size = widthPercent ? ` size="${widthPercent}%"` : "";
    const { shellLaunch } = this.buildOpencodePaneCommand(
      sessionName,
      cwd,
      agent.name,
      agent.opencodeSessionId,
    );
    return [
      `      pane command=${this.toKdlString(shellLaunch.command)} name=${this.toKdlString(agent.name)}${size} {`,
      `        args ${shellLaunch.args.map((arg) => this.toKdlString(arg)).join(" ")};`,
      "        start_suspended false;",
      "      }",
    ].join("\n");
  }

  protected partitionAgentsForGrid(agents: AgentPaneSpec[]): AgentPaneSpec[][] {
    if (agents.length <= 0) {
      return [];
    }

    const preferredColumns = Math.min(3, agents.length);
    const preferredRows = Math.ceil(agents.length / preferredColumns);
    const maxRows = 2;
    const maxColumns =
      preferredRows <= maxRows
        ? preferredColumns
        : Math.ceil(agents.length / maxRows);
    const rows: AgentPaneSpec[][] = [];
    for (let index = 0; index < agents.length; index += maxColumns) {
      rows.push(agents.slice(index, index + maxColumns));
    }
    return rows;
  }

  protected toKdlString(value: string): string {
    return JSON.stringify(value);
  }

  protected async waitForSessionReady(sessionName: string, timeoutMs = 4_000): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (await this.canQuerySession(sessionName)) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Zellij session 未就绪：${sessionName}`);
  }

  protected async canQuerySession(sessionName: string): Promise<boolean> {
    try {
      const { stdout } = await this.execZellij([
        "-s",
        sessionName,
        "action",
        "list-panes",
        "-j",
        "-a",
        "-g",
        "-s",
        "-t",
      ], {
        timeout: this.getHostPlatform() === "win32" ? 5_000 : 3_000,
      });
      this.parseListPanesOutput(sessionName, stdout, { logInvalidJson: false });
      return true;
    } catch (error) {
      if (this.isSessionNotFoundError(error)) {
        return false;
      }
      return false;
    }
  }

  protected isSessionNotFoundError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    const execError = error as Error & {
      stdout?: string;
      stderr?: string;
    };
    const outputs = [execError.stdout, execError.stderr, execError.message]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => this.stripAnsi(value));
    if (outputs.some((value) => this.extractSessionListingNames(value).length > 0)) {
      return true;
    }
    const combined = outputs.join("\n").toLowerCase();

    return (
      (combined.includes("session") && combined.includes("not found"))
      || combined.includes("there is no active session")
      || combined.includes("the following sessions are active")
    );
  }

  protected logCommandFailure(
    command: string,
    args: string[],
    options: ExecFileOptions | undefined,
    error: unknown,
  ) {
    const execError = error as Error & {
      code?: number | string;
      signal?: string;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      cmd?: string;
      killed?: boolean;
    };
    const stdout = this.normalizeExecOutput(execError?.stdout);
    const stderr = this.normalizeExecOutput(execError?.stderr);
    appendAppLog("error", "zellij.command_failed", {
      command,
      args,
      renderedCommand: this.renderCommand(command, args),
      cwd: options?.cwd ?? process.cwd(),
      timeout: options?.timeout ?? null,
      code: execError?.code ?? null,
      signal: execError?.signal ?? null,
      killed: execError?.killed ?? null,
      message: error instanceof Error ? error.message : String(error),
      stdout,
      stderr,
    });
    console.error("[zellij] command failed", {
      command,
      args,
      renderedCommand: this.renderCommand(command, args),
      cwd: options?.cwd ?? process.cwd(),
      timeout: options?.timeout ?? null,
      code: execError?.code ?? null,
      signal: execError?.signal ?? null,
      killed: execError?.killed ?? null,
      message: error instanceof Error ? error.message : String(error),
      stdout,
      stderr,
    });
  }

  protected normalizeExecOutput(value: string | Buffer | undefined): string {
    if (typeof value === "string") {
      return value;
    }
    if (Buffer.isBuffer(value)) {
      return value.toString("utf8");
    }
    return "";
  }

  protected renderCommand(command: string, args: string[]): string {
    return [command, ...args.map((arg) => JSON.stringify(arg))].join(" ");
  }

  protected distributePercentages(count: number): number[] {
    if (count <= 0) {
      return [];
    }

    const base = Math.floor(100 / count);
    const remainder = 100 % count;
    return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0));
  }

  protected parseListPanesOutput(
    sessionName: string,
    stdout: string,
    options: { logInvalidJson?: boolean } = {},
  ): Array<Record<string, unknown>> {
    const trimmed = stdout.trim();
    const ansiStripped = this.stripAnsi(trimmed);

    for (const candidate of [trimmed, ansiStripped]) {
      if (!candidate) {
        continue;
      }
      try {
        const parsed = JSON.parse(candidate) as unknown;
        return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [];
      } catch {
        // Try the next representation.
      }
    }

    if (options.logInvalidJson !== false) {
      appendAppLog("error", "zellij.list_panes_invalid_json", {
        sessionName,
        stdout: this.truncateLogPayload(trimmed),
        ansiStripped: this.truncateLogPayload(ansiStripped),
      });
    }
    throw new Error(ansiStripped || trimmed || `Zellij list-panes 返回空输出: ${sessionName}`);
  }

  protected parseRunPaneOutput(sessionName: string, agentName: string, stdout: string): string {
    const trimmed = stdout.trim();
    const ansiStripped = this.stripAnsi(trimmed);
    const lines = ansiStripped
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length === 0) {
      return `terminal_${agentName}`;
    }

    if (lines.length === 1) {
      const onlyLine = lines[0] ?? "";
      if (/^terminal_\d+$/i.test(onlyLine)) {
        return onlyLine;
      }
      if (/^\d+$/.test(onlyLine)) {
        return `terminal_${onlyLine}`;
      }
    }

    appendAppLog("error", "zellij.run_invalid_output", {
      sessionName,
      agentName,
      stdout: this.truncateLogPayload(trimmed),
      ansiStripped: this.truncateLogPayload(ansiStripped),
    });
    throw new Error(ansiStripped || trimmed || `Zellij run returned invalid pane id: ${agentName}`);
  }

  protected extractSessionListingNames(output: string): string[] {
    const lines = this.stripAnsi(output)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length === 0) {
      return [];
    }

    const sessionNames: string[] = [];
    for (const line of lines) {
      const lowerLine = line.toLowerCase();
      if (
        (lowerLine.startsWith("session '") && lowerLine.includes("not found"))
        || lowerLine === "the following sessions are active:"
      ) {
        continue;
      }

      const match = line.match(/^([A-Za-z0-9._-]+)(?:\s+\[Created\b.*)?(?:\s+\(EXITED\b.*\))?$/);
      if (!match) {
        return [];
      }
      sessionNames.push(match[1] ?? "");
    }

    return sessionNames.filter(Boolean);
  }

  protected stripAnsi(value: string): string {
    return value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
  }

  protected truncateLogPayload(value: string, maxLength = 4000): string {
    if (value.length <= maxLength) {
      return value;
    }
    return `${value.slice(0, maxLength)}...(truncated)`;
  }
}
