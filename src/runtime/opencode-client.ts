import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { withOptionalString, withOptionalValue } from "@shared/object-utils";
import { buildSubmitMessageBody } from "./opencode-request-body";
import { toOpenCodeAgentId } from "./opencode-agent-id";
import { appendAppLog } from "./app-log";
import { extractOpenCodeServeBaseUrl } from "./opencode-serve-launch";
import { resolveOpenCodeRequestTimeoutMs } from "./opencode-request-timeout";
import { resolveWindowsCmdPath } from "./windows-shell";

interface ServeHandle {
  process: ChildProcessWithoutNullStreams | null;
  port: number;
}

interface OpenCodeEvent {
  directory?: string;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SubmitMessagePayload {
  content: string;
  agent: string;
  system?: string;
}

export interface OpenCodeNormalizedMessage {
  id: string;
  content: string;
  sender: string;
  timestamp: string;
  completedAt: string | null;
  error: string | null;
  raw: unknown;
}

export interface OpenCodeExecutionResult {
  status: "completed" | "error";
  finalMessage: string;
  messageId: string;
  timestamp: string;
  rawMessage: OpenCodeNormalizedMessage;
}

export interface OpenCodeRuntimeActivity {
  id: string;
  kind: "tool" | "message" | "thinking" | "step";
  label: string;
  detail: string;
  timestamp: string;
}

export interface OpenCodeSessionRuntime {
  sessionId: string;
  messageCount: number;
  updatedAt: string | null;
  headline: string | null;
  activeToolNames: string[];
  activities: OpenCodeRuntimeActivity[];
}

const MAX_RUNTIME_MESSAGES = 100;
const SERVE_BASE_URL_TIMEOUT_MS = 10_000;
interface SessionWaiter {
  sessionId: string;
  after: number;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface ProjectServerState {
  runtimeKey: string;
  projectPath: string;
  serverHandle: Promise<ServeHandle> | null;
  eventPump: Promise<void> | null;
  injectedConfigContent: string | null;
}

export interface OpenCodeRuntimeTarget {
  runtimeKey: string;
  projectPath: string;
}

type OpenCodeRuntimeTargetInput = string | OpenCodeRuntimeTarget;

export interface OpenCodeShutdownReport {
  killedPids: number[];
}

export class OpenCodeClient {
  readonly servers = new Map<string, ProjectServerState>();
  readonly host = "127.0.0.1";
  readonly sessionIdleAt = new Map<string, number>();
  readonly sessionErrors = new Map<string, string>();
  readonly sessionWaiters = new Map<string, SessionWaiter[]>();

  constructor() {}

  protected normalizeTarget(target: OpenCodeRuntimeTargetInput): OpenCodeRuntimeTarget {
    if (typeof target === "string") {
      const projectPath = path.resolve(target);
      return {
        runtimeKey: projectPath,
        projectPath,
      };
    }

    return {
      runtimeKey: target.runtimeKey.trim(),
      projectPath: path.resolve(target.projectPath),
    };
  }

  protected getProjectServerState(target: OpenCodeRuntimeTargetInput): ProjectServerState {
    const normalized = this.normalizeTarget(target);
    const key = normalized.runtimeKey;
    const existing = this.servers.get(key);
    if (existing) {
      return existing;
    }

    const created: ProjectServerState = {
      runtimeKey: key,
      projectPath: normalized.projectPath,
      serverHandle: null,
      eventPump: null,
      injectedConfigContent: null,
    };
    this.servers.set(key, created);
    return created;
  }

  async ensureServer(target: OpenCodeRuntimeTargetInput): Promise<ServeHandle> {
    const state = this.getProjectServerState(target);
    if (state.serverHandle) {
      const cached = await state.serverHandle;
      if (this.canReuseCachedServerHandle(cached)) {
        return cached;
      }
      await this.terminateServeHandle(cached).catch(() => undefined);
      state.serverHandle = null;
      state.eventPump = null;
    }

    state.serverHandle = this.resolveServerHandle(state).catch((error) => {
      if (state.serverHandle) {
        state.serverHandle = null;
      }
      throw error;
    });
    return state.serverHandle;
  }

  protected canReuseCachedServerHandle(cached: ServeHandle): boolean {
    return Number.isInteger(cached.port) && cached.port > 0;
  }

  protected async resolveServerHandle(state: ProjectServerState): Promise<ServeHandle> {
    return this.startServer({
      runtimeKey: state.runtimeKey,
      projectPath: state.projectPath,
    });
  }

  setInjectedConfigContent(target: OpenCodeRuntimeTargetInput, content: string | null) {
    const state = this.getProjectServerState(target);
    const normalized = content?.trim();
    const nextContent = normalized ? normalized : null;
    if (nextContent === state.injectedConfigContent) {
      return;
    }
    state.injectedConfigContent = nextContent;
  }

  async createSession(target: OpenCodeRuntimeTargetInput, title: string): Promise<string> {
    const normalized = this.normalizeTarget(target);
    const response = await this.request("/session", {
      method: "POST",
      target: normalized,
      body: JSON.stringify({ title }),
    });

    if (!response.ok) {
      appendAppLog("error", "opencode.create_session_failed", {
        projectPath: normalized.projectPath,
        title,
        status: response.status,
        statusText: response.statusText,
      }, {
        runtimeKey: normalized.runtimeKey,
      });
      throw new Error(`OpenCode 创建 session 失败: ${response.status}`);
    }

    const data = (await this.readJsonResponse(response)) as { id?: string } | null;
    if (typeof data?.id === "string" && data.id.trim()) {
      return data.id;
    }

    appendAppLog("error", "opencode.create_session_invalid_response", {
      projectPath: normalized.projectPath,
      title,
      status: response.status,
    }, {
      runtimeKey: normalized.runtimeKey,
    });
    throw new Error("OpenCode 创建 session 响应缺少有效的 session id");
  }

  async connectEvents(target: OpenCodeRuntimeTargetInput, onEvent: (event: OpenCodeEvent) => void): Promise<void> {
    const normalized = this.normalizeTarget(target);
    const state = this.getProjectServerState(normalized);
    const server = await this.ensureServer(normalized);
    if (state.eventPump) {
      return;
    }

    state.eventPump = this.startEventPump(onEvent, server, state.runtimeKey);
    await state.eventPump;
  }

  async submitMessage(
    target: OpenCodeRuntimeTargetInput,
    sessionId: string,
    payload: SubmitMessagePayload,
  ): Promise<OpenCodeNormalizedMessage> {
    const normalized = this.normalizeTarget(target);
    const opencodeAgent = toOpenCodeAgentId(payload.agent);

    const body = buildSubmitMessageBody(withOptionalString({
      agent: opencodeAgent,
      content: payload.content,
    }, "system", payload.system));
    // Do not send deprecated `tools` here. OpenCode copies that field into session-level
    // permissions, which can accidentally reopen write/edit/bash access for restricted agents.

    const response = await this.request(`/session/${sessionId}/message`, {
      method: "POST",
      target: normalized,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`OpenCode 请求失败: ${response.status}`);
    }

    const raw = await this.readJsonResponse(response);
    if (!raw || typeof raw !== "object") {
      appendAppLog("error", "opencode.submit_message_invalid_response", {
        projectPath: normalized.projectPath,
        sessionId,
        agent: opencodeAgent,
        status: response.status,
      }, {
        runtimeKey: normalized.runtimeKey,
      });
      throw new Error("OpenCode 提交消息响应缺少有效的消息实体");
    }
    return this.normalizeMessageEnvelope(raw as Record<string, unknown>, opencodeAgent);
  }

  async resolveExecutionResult(
    target: OpenCodeRuntimeTargetInput,
    sessionId: string,
    submitted: OpenCodeNormalizedMessage,
  ): Promise<OpenCodeExecutionResult> {
    const normalized = this.normalizeTarget(target);
    const submittedAt = Date.parse(submitted.timestamp) || Date.now();
    const messageCompletionPromise = this.waitForMessageCompletion(
      normalized,
      sessionId,
      submitted.id,
      submitted.timestamp,
      8000,
    );
    let latest = await Promise.race([
      messageCompletionPromise,
      this.waitForSessionSettled(sessionId, submittedAt, 8000)
        .then(async () => {
          const current = await this.getSessionMessage(normalized, sessionId, submitted.id);
          return current && (current.completedAt || current.error) ? current : null;
        })
        .catch(() => null),
    ]);

    if (!latest) {
      latest =
        (await messageCompletionPromise) ??
        (await this.getLatestAssistantMessage(normalized, sessionId));
    }

    if (!latest) {
      throw new Error(`OpenCode session ${sessionId} 未返回任何有效的 assistant 消息`);
    }

    const finalMessage = latest.content || latest.error || "";
    if (!finalMessage.trim()) {
      throw new Error(this.buildEmptyAssistantResultError(sessionId, latest));
    }

    return {
      status: latest.error ? "error" : "completed",
      finalMessage,
      messageId: latest.id,
      timestamp: latest.completedAt ?? latest.timestamp,
      rawMessage: latest,
    };
  }

  async recoverExecutionResultAfterTransportError(
    target: OpenCodeRuntimeTargetInput,
    sessionId: string,
    startedAt: string,
    errorMessage: string,
    timeoutMs = 45_000,
  ): Promise<OpenCodeExecutionResult | null> {
    const normalized = this.normalizeTarget(target);
    if (!this.isRecoverableTransportError(errorMessage)) {
      return null;
    }

    const startedAtMs = Date.parse(startedAt);
    const lowerBound = Number.isFinite(startedAtMs) ? startedAtMs - 2_000 : Date.now() - 2_000;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const recovered = await this.findRecoveredAssistantReply(normalized, sessionId, lowerBound);
      if (recovered) {
        return recovered;
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }

    return null;
  }

  async getSessionRuntime(
    target: OpenCodeRuntimeTargetInput,
    sessionId: string,
  ): Promise<OpenCodeSessionRuntime> {
    const list = await this.listSessionMessages(target, sessionId, MAX_RUNTIME_MESSAGES);
    if (list.length === 0) {
      return {
        sessionId,
        messageCount: 0,
        updatedAt: null,
        headline: null,
        activeToolNames: [],
        activities: [],
      };
    }
    return this.buildRuntimeSnapshot(sessionId, list);
  }

  async shutdown(runtimeKey?: string): Promise<OpenCodeShutdownReport> {
    if (runtimeKey) {
      const state = this.servers.get(runtimeKey);
      if (!state?.serverHandle) {
        return {
          killedPids: [],
        };
      }

      let report: OpenCodeShutdownReport = {
        killedPids: [],
      };
      let server: ServeHandle | null = null;
      try {
        server = await state.serverHandle;
        report = await this.terminateServeHandle(server);
      } catch {
        // ignore shutdown errors
      } finally {
        state.serverHandle = null;
        state.eventPump = null;
      }
      return report;
    }

    const reports: OpenCodeShutdownReport[] = [];
    for (const state of this.servers.values()) {
      let server: ServeHandle | null = null;
      try {
        if (!state.serverHandle) {
          continue;
        }
        server = await state.serverHandle;
        reports.push(await this.terminateServeHandle(server));
      } catch {
        // ignore shutdown errors
      } finally {
        state.serverHandle = null;
        state.eventPump = null;
      }
    }
    this.sessionIdleAt.clear();
    this.sessionErrors.clear();
    this.sessionWaiters.clear();
    return this.mergeShutdownReports(reports);
  }

  async deleteProject(projectPath: string): Promise<void> {
    const key = this.normalizeTarget(projectPath).runtimeKey;
    await this.shutdown(key);
    const state = this.servers.get(key);
    if (!state) {
      return;
    }

    this.servers.delete(key);
  }

  private async terminateServeHandle(server: ServeHandle): Promise<OpenCodeShutdownReport> {
    const killedPids = this.findListeningPids(server.port)
      .filter((pid) => this.isOpenCodeServeProcess(pid));

    if (server.process) {
      await this.killChildProcessTree(server.process);
    }

    for (const pid of this.findListeningPids(server.port)) {
      if (!this.isOpenCodeServeProcess(pid)) {
        continue;
      }
      this.killProcess(pid);
      killedPids.push(pid);
    }

    return {
      killedPids: [...new Set(killedPids)],
    };
  }

  private async killChildProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
    const pid = child.pid;
    if (!pid) {
      if (!child.killed) {
        child.kill();
      }
      return;
    }

    if (process.platform === "win32") {
      this.killWindowsProcessTree(pid);
      const exited = await this.waitForChildExit(child, 1500);
      if (!exited && !child.killed) {
        child.kill("SIGKILL");
        await this.waitForChildExit(child, 1000);
      }
      return;
    }

    const processTree = this.collectUnixProcessTreePids(pid);
    this.killUnixPids(processTree, "SIGTERM");
    await this.waitForChildExit(child, 1500);
    if (this.findAlivePids(processTree).length === 0) {
      return;
    }

    this.killUnixPids(processTree, "SIGKILL");
    await this.waitForChildExit(child, 1000);
  }

  private waitForChildExit(
    child: ChildProcessWithoutNullStreams,
    timeoutMs: number,
  ): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) {
      return Promise.resolve(true);
    }

    return new Promise<boolean>((resolve) => {
      const handleExit = () => {
        clearTimeout(timeout);
        child.off("exit", handleExit);
        resolve(true);
      };
      const timeout = setTimeout(() => {
        child.off("exit", handleExit);
        resolve(false);
      }, timeoutMs);
      child.on("exit", handleExit);
    });
  }

  private killWindowsProcessTree(pid: number) {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch {
      this.killProcess(pid);
    }
  }

  private killUnixPids(targets: number[], signal: NodeJS.Signals) {
    for (const targetPid of targets.reverse()) {
      try {
        process.kill(targetPid, signal);
      } catch {
        // ignore
      }
    }
  }

  private collectUnixProcessTreePids(rootPid: number): number[] {
    try {
      const output = execFileSync("ps", ["-axo", "pid=,ppid="], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const childPidsByParent = new Map<number, number[]>();
      for (const line of output.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        const [pidText, parentPidText] = trimmed.split(/\s+/);
        const pid = Number(pidText);
        const parentPid = Number(parentPidText);
        if (!Number.isInteger(pid) || !Number.isInteger(parentPid) || pid <= 0 || parentPid <= 0) {
          continue;
        }
        const current = childPidsByParent.get(parentPid) ?? [];
        current.push(pid);
        childPidsByParent.set(parentPid, current);
      }

      const ordered: number[] = [];
      const pending = [rootPid];
      while (pending.length > 0) {
        const currentPid = pending.pop();
        if (!currentPid || ordered.includes(currentPid)) {
          continue;
        }
        ordered.push(currentPid);
        for (const childPid of childPidsByParent.get(currentPid) ?? []) {
          pending.push(childPid);
        }
      }
      return ordered;
    } catch {
      return [rootPid];
    }
  }

  private findAlivePids(targets: number[]): number[] {
    return targets.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
  }

  protected async startServer(target: OpenCodeRuntimeTarget): Promise<ServeHandle> {
    const state = this.getProjectServerState(target);

    const serverEnv = { ...process.env };
    // Isolate the embedded runtime from parent OpenCode config injection.
    delete serverEnv["OPENCODE_CONFIG"];
    delete serverEnv["OPENCODE_CONFIG_CONTENT"];
    delete serverEnv["OPENCODE_CONFIG_DIR"];
    delete serverEnv["OPENCODE_DB"];
    delete serverEnv["OPENCODE_CLIENT"];
    serverEnv["OPENCODE_CLIENT"] = "agent-team-orchestrator";
    serverEnv["OPENCODE_DISABLE_PROJECT_CONFIG"] = "true";
    if (state.injectedConfigContent) {
      serverEnv["OPENCODE_CONFIG_CONTENT"] = state.injectedConfigContent;
    }
    appendAppLog("info", "opencode.serve_starting", {
      projectPath: state.projectPath,
    }, {
      runtimeKey: state.runtimeKey,
    });
    const launchArgs = ["serve"];
    const spawnSpec = process.platform === "win32"
      ? {
          command: resolveWindowsCmdPath(serverEnv),
          args: [
            "/d",
            "/s",
            "/c",
            ["opencode", ...launchArgs].join(" "),
          ],
        }
      : {
          command: "opencode",
          args: launchArgs,
        };
    const childProcess = spawn(
      spawnSpec.command,
      spawnSpec.args,
      {
        cwd: state.projectPath,
        env: serverEnv,
        stdio: "pipe",
      },
    );

    let spawnErrorMessage: string | null = null;
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    childProcess.on("error", (error) => {
      spawnErrorMessage = error instanceof Error ? error.message : String(error);
    });

    childProcess.stderr.on("data", (chunk) => {
      stderrChunks.push(this.normalizeProcessOutput(chunk));
    });
    childProcess.stdout.on("data", (chunk) => {
      stdoutChunks.push(this.normalizeProcessOutput(chunk));
    });

    const baseUrl = await this.waitForServeBaseUrl(childProcess, stdoutChunks, stderrChunks).catch(async (error) => {
      await this.killChildProcessTree(childProcess).catch(() => undefined);
      appendAppLog("error", "opencode.serve_start_failed", {
        projectPath: state.projectPath,
        command: spawnSpec.command,
        args: spawnSpec.args,
        message: error instanceof Error ? error.message : String(error),
        stdout: this.truncateLogPayload(stdoutChunks.join("")),
        stderr: this.truncateLogPayload(stderrChunks.join("")),
      }, {
        runtimeKey: state.runtimeKey,
      });
      throw error;
    });
    const port = this.parsePortFromBaseUrl(baseUrl);
    const healthy = await this.waitForHealthy(baseUrl);
    if (spawnErrorMessage !== null || !healthy) {
      const message = spawnErrorMessage !== null
        ? `OpenCode serve 启动失败: ${spawnErrorMessage}`
          : `OpenCode serve 健康检查失败: ${baseUrl}/global/health 未在预期时间内返回成功`;
      await this.killChildProcessTree(childProcess).catch(() => undefined);
      appendAppLog("error", "opencode.serve_start_failed", {
        projectPath: state.projectPath,
        port,
        baseUrl,
        command: spawnSpec.command,
        args: spawnSpec.args,
        message,
        stdout: this.truncateLogPayload(stdoutChunks.join("")),
        stderr: this.truncateLogPayload(stderrChunks.join("")),
      }, {
        runtimeKey: state.runtimeKey,
      });
      throw new Error(message);
    }

    appendAppLog("info", "opencode.serve_started", {
      projectPath: state.projectPath,
      port,
      baseUrl,
      command: spawnSpec.command,
      args: spawnSpec.args,
    }, {
      runtimeKey: state.runtimeKey,
    });

    return {
      process: childProcess,
      port,
    };
  }

  async getAttachBaseUrl(target: OpenCodeRuntimeTargetInput): Promise<string> {
    const server = await this.ensureServer(target);
    return this.buildBaseUrl(server.port);
  }

  private findListeningPids(port: number): number[] {
    try {
      if (process.platform === "win32") {
        const output = execFileSync("netstat", ["-ano", "-p", "tcp"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
        return output
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.includes("LISTENING"))
          .filter((line) => line.includes(`:${port}`))
          .map((line) => {
            const parts = line.split(/\s+/);
            return Number(parts.at(-1));
          })
          .filter((pid) => Number.isInteger(pid) && pid > 0);
      }

      const output = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      return output
        .split(/\n/)
        .filter((line) => line.startsWith("p"))
        .map((line) => Number(line.slice(1)))
        .filter((pid) => Number.isInteger(pid) && pid > 0);
    } catch {
      return [];
    }
  }

  private isOpenCodeServeProcess(pid: number): boolean {
    try {
      if (process.platform === "win32") {
        const output = execFileSync("tasklist", ["/FI", `PID eq ${pid}`], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
        return output.toLowerCase().includes("opencode");
      }

      const command = execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      return command.includes("opencode") && command.includes("serve");
    } catch {
      return false;
    }
  }

  private killProcess(pid: number) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }

    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        return;
      }
    }

    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // ignore
    }
  }

  private async startEventPump(
    onEvent: (event: OpenCodeEvent) => void,
    server: ServeHandle,
    runtimeKey: string,
  ): Promise<void> {
    try {
      const response = await fetch(`${this.buildBaseUrl(server.port)}/global/event`);
      if (!response.ok || !response.body) {
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() ?? "";

        for (const chunk of chunks) {
          const dataLines = chunk
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim());

          for (const dataLine of dataLines) {
            if (!dataLine) {
              continue;
            }

            try {
              const event = JSON.parse(dataLine) as OpenCodeEvent;
              this.handleEvent(event);
              onEvent(event);
            } catch {
              onEvent({ payload: { raw: dataLine } });
            }
          }
        }
      }
    } finally {
      const state = this.servers.get(runtimeKey);
      if (state) {
        state.eventPump = null;
      }
    }
  }

  private handleEvent(event: OpenCodeEvent) {
    const eventType = typeof event["type"] === "string" ? event["type"] : "";
    const properties = this.asRecord(event["properties"]);

    if (eventType === "session.idle") {
      const sessionId = typeof properties["sessionID"] === "string" ? properties["sessionID"] : null;
      if (!sessionId) {
        return;
      }
      this.sessionIdleAt.set(sessionId, Date.now());
      const waiters = this.sessionWaiters.get(sessionId) ?? [];
      const ready = waiters.filter((waiter) => waiter.after <= Date.now());
      this.sessionWaiters.set(
        sessionId,
        waiters.filter((waiter) => waiter.after > Date.now()),
      );
      for (const waiter of ready) {
        waiter.resolve();
      }
      return;
    }

    if (eventType === "session.error") {
      const sessionId = typeof properties["sessionID"] === "string" ? properties["sessionID"] : null;
      if (!sessionId) {
        return;
      }
      const error = this.extractEventError(properties["error"]) ?? "OpenCode session 发生未知错误";
      this.sessionErrors.set(sessionId, error);
      const waiters = this.sessionWaiters.get(sessionId) ?? [];
      this.sessionWaiters.delete(sessionId);
      for (const waiter of waiters) {
        waiter.reject(new Error(error));
      }
    }
  }

  protected async request(
    pathname: string,
    options: {
      method: "GET" | "POST";
      target?: OpenCodeRuntimeTargetInput;
      projectPath?: string;
      body?: string;
    },
  ): Promise<Response> {
    const normalized = this.normalizeTarget(options.target ?? options.projectPath ?? globalThis.process.cwd());
    const headers: Record<string, string> = {};
    if (options.body) {
      headers["content-type"] = "application/json";
    }
    if (options.target || options.projectPath) {
      headers["x-opencode-directory"] = normalized.projectPath;
    }

    const timeoutMs = resolveOpenCodeRequestTimeoutMs({
      pathname,
      method: options.method,
    });
    const requestWithServer = async (server: ServeHandle) => {
      const url = `${this.buildBaseUrl(server.port)}${pathname}`;
      return this.fetchWithTimeout(url, withOptionalValue({
        method: options.method,
        headers,
      }, "body", options.body), timeoutMs);
    };
    const server = await this.ensureServer(normalized);
    const url = `${this.buildBaseUrl(server.port)}${pathname}`;
    try {
      return await requestWithServer(server);
    } catch (error) {
      appendAppLog("error", "opencode.request_failed", {
        projectPath: normalized.projectPath,
        method: options.method,
        url,
        message: error instanceof Error ? error.message : String(error),
      }, {
        runtimeKey: normalized.runtimeKey,
      });
      throw error;
    }
  }

  private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number | null): Promise<Response> {
    if (timeoutMs === null) {
      return fetch(url, init);
    }
    const controller = new AbortController();
    const timeoutMessage = `OpenCode 请求超时: ${(init.method ?? "GET").toUpperCase()} ${url} 超过 ${timeoutMs}ms`;
    const timeout = setTimeout(() => {
      controller.abort(new Error(timeoutMessage));
    }, timeoutMs);

    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(timeoutMessage);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async waitForSessionSettled(sessionId: string, after: number, timeoutMs: number): Promise<void> {
    const idleAt = this.sessionIdleAt.get(sessionId);
    if (typeof idleAt === "number" && idleAt >= after) {
      return;
    }

    const error = this.sessionErrors.get(sessionId);
    if (error) {
      throw new Error(error);
    }

    await new Promise<void>((resolve, reject) => {
      const waiter: SessionWaiter = {
        sessionId,
        after,
        resolve: () => {
          clearTimeout(timeout);
          resolve();
        },
        reject: (reason) => {
          clearTimeout(timeout);
          reject(reason);
        },
      };
      const timeout = setTimeout(() => {
        const waiters = this.sessionWaiters.get(sessionId) ?? [];
        this.sessionWaiters.set(
          sessionId,
          waiters.filter((item) => item !== waiter),
        );
        resolve();
      }, timeoutMs);

      this.sessionWaiters.set(sessionId, [...(this.sessionWaiters.get(sessionId) ?? []), waiter]);
    });
  }

  async waitForMessageCompletion(
    target: OpenCodeRuntimeTargetInput,
    sessionId: string,
    messageId: string,
    fallbackTimestamp: string,
    timeoutMs: number,
  ): Promise<OpenCodeNormalizedMessage | null> {
    const startedAt = Date.now();
    let latestNonEmptyMessage: OpenCodeNormalizedMessage | null = null;
    while (Date.now() - startedAt < timeoutMs) {
      const message = await this.getSessionMessage(target, sessionId, messageId);
      if (message?.content.trim()) {
        latestNonEmptyMessage = message;
      }
      if (message && (message.completedAt || message.error)) {
        return message;
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }

    return this.getSessionMessage(target, sessionId, messageId).then(
      (message) =>
        message ??
        latestNonEmptyMessage ?? {
          id: messageId,
          content: "",
          sender: "assistant",
          timestamp: fallbackTimestamp,
          completedAt: null,
          error: null,
          raw: null,
        },
    );
  }

  async getLatestAssistantMessage(
    target: OpenCodeRuntimeTargetInput,
    sessionId: string,
  ): Promise<OpenCodeNormalizedMessage | null> {
    const list = await this.listSessionMessages(target, sessionId);
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const message = this.normalizeMessageEnvelope(list[index], "assistant");
      if (message.sender === "assistant" || message.sender === "system" || message.sender === "unknown") {
        return message;
      }
    }
    return null;
  }

  private async findRecoveredAssistantReply(
    target: OpenCodeRuntimeTargetInput,
    sessionId: string,
    lowerBoundMs: number,
  ): Promise<OpenCodeExecutionResult | null> {
    const messages = await this.listSessionMessages(target, sessionId);
    if (messages.length === 0) {
      return null;
    }

    const normalizedRecords = messages.map((raw) => {
      const envelope = this.asRecord(raw);
      const info = this.asRecord(envelope["info"] ?? raw);
      const normalized = this.normalizeMessageEnvelope(raw, "assistant");
      return {
        raw,
        info,
        normalized,
        createdAtMs: Date.parse(normalized.timestamp),
      };
    });

    const submittedMessage = normalizedRecords
      .filter((record) =>
        record.normalized.sender === "user"
        && Number.isFinite(record.createdAtMs)
        && record.createdAtMs >= lowerBoundMs)
      .sort((left, right) => left.createdAtMs - right.createdAtMs)[0];
    if (!submittedMessage) {
      return null;
    }

    const finalReply = normalizedRecords
      .filter((record) =>
        this.extractParentMessageId(record.info) === submittedMessage.normalized.id
        && this.isRecoverableReplyCandidate(record.info, record.normalized))
      .sort((left, right) => {
        const leftCompleted = Date.parse(left.normalized.completedAt ?? left.normalized.timestamp) || 0;
        const rightCompleted = Date.parse(right.normalized.completedAt ?? right.normalized.timestamp) || 0;
        return rightCompleted - leftCompleted;
      })[0];
    if (!finalReply) {
      return null;
    }

    const message = finalReply.normalized;
    return {
      status: message.error ? "error" : "completed",
      finalMessage: message.content || message.error || "",
      messageId: message.id,
      timestamp: message.completedAt ?? message.timestamp,
      rawMessage: message,
    };
  }

  async getSessionMessage(
    target: OpenCodeRuntimeTargetInput,
    sessionId: string,
    messageId: string,
  ): Promise<OpenCodeNormalizedMessage | null> {
    const response = await this.request(`/session/${sessionId}/message/${messageId}`, {
      method: "GET",
      target,
    });
    if (!response.ok) {
      return null;
    }
    const raw = await this.readJsonResponse(response);
    if (!raw || typeof raw !== "object") {
      return null;
    }
    return this.normalizeMessageEnvelope(raw as Record<string, unknown>, "assistant");
  }

  async listSessionMessages(
    target: OpenCodeRuntimeTargetInput,
    sessionId: string,
    limit?: number,
  ): Promise<unknown[]> {
    const pathname = limit
      ? `/session/${sessionId}/message?limit=${limit}`
      : `/session/${sessionId}/message`;
    const response = await this.request(pathname, {
      method: "GET",
      target,
    });
    if (!response.ok) {
      return [];
    }

    const raw = await this.readJsonResponse(response);
    return Array.isArray(raw) ? raw : [];
  }

  private async readJsonResponse(response: Response): Promise<unknown | null> {
    const raw = await response.text();
    const trimmed = raw.trim();
    if (!trimmed) {
      return null;
    }

    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return null;
    }
  }

  private normalizeMessageEnvelope(
    raw: unknown,
    fallbackSender: string,
  ): OpenCodeNormalizedMessage {
    const envelope = this.asRecord(raw);
    const info = this.asRecord(envelope["info"] ?? raw);
    const parts = Array.isArray(envelope["parts"]) ? (envelope["parts"] as Array<Record<string, unknown>>) : [];
    const time = this.asRecord(info["time"]);
    const created =
      this.toIsoString(time["created"]) ??
      this.toIsoString(info["createdAt"]) ??
      new Date().toISOString();
    const completed =
      this.toIsoString(time["completed"]) ??
      this.toIsoString(info["completedAt"]) ??
      null;
    const sender =
      typeof info["role"] === "string"
        ? info["role"]
        : typeof envelope["sender"] === "string"
          ? envelope["sender"]
          : fallbackSender;
    const content =
      parts.length > 0
        ? this.extractVisibleMessageText(parts)
        : typeof envelope["content"] === "string"
          ? envelope["content"]
          : typeof envelope["text"] === "string"
            ? envelope["text"]
            : "";

    return {
      id:
        (typeof info["id"] === "string" ? info["id"] : null) ??
        (typeof envelope["id"] === "string" ? envelope["id"] : null) ??
        randomUUID(),
      content,
      sender,
      timestamp: created,
      completedAt: completed,
      error: this.extractEventError(info["error"] ?? envelope["error"]),
      raw,
    };
  }

  private buildEmptyAssistantResultError(
    sessionId: string,
    message: OpenCodeNormalizedMessage,
  ): string {
    const record = this.asRecord(message.raw);
    const info = this.asRecord(record["info"] ?? message.raw);
    const parts = Array.isArray(record["parts"]) ? (record["parts"] as Array<Record<string, unknown>>) : [];
    const finish = typeof info["finish"] === "string" && info["finish"].trim()
      ? info["finish"].trim()
      : "unknown";
    const partTypes = parts
      .map((part) => (typeof part["type"] === "string" ? part["type"].trim() : ""))
      .filter(Boolean);
    const partSummary = partTypes.length > 0 ? partTypes.join(",") : "none";
    return `OpenCode session ${sessionId} 返回了空的 assistant 结果: messageId=${message.id}, finish=${finish}, partTypes=${partSummary}`;
  }

  private extractParentMessageId(info: Record<string, unknown>): string | null {
    return typeof info["parentID"] === "string" && info["parentID"].trim()
      ? info["parentID"]
      : null;
  }

  private isRecoverableReplyCandidate(
    info: Record<string, unknown>,
    message: OpenCodeNormalizedMessage,
  ): boolean {
    if (message.sender !== "assistant" && message.sender !== "system" && message.sender !== "unknown") {
      return false;
    }

    if (message.error) {
      return true;
    }

    if (message.content.trim()) {
      return true;
    }

    return typeof info["finish"] === "string" && info["finish"] === "stop";
  }

  private isRecoverableTransportError(errorMessage: string): boolean {
    return /\b(terminated|aborted)\b/i.test(errorMessage) || /fetch failed/i.test(errorMessage);
  }

  buildRuntimeSnapshot(sessionId: string, messages: unknown[]): OpenCodeSessionRuntime {
    const activities: OpenCodeRuntimeActivity[] = [];
    const toolNames: string[] = [];
    const seen = new Set<string>();

    for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
      const raw = messages[messageIndex];
      const normalized = this.normalizeMessageEnvelope(raw, "assistant");
      if (normalized.sender === "user") {
        continue;
      }

      const record = this.asRecord(raw);
      const parts = Array.isArray(record["parts"]) ? (record["parts"] as Array<Record<string, unknown>>) : [];
      const extracted = this.extractRuntimeActivities(parts, normalized, messageIndex);

      if (extracted.length === 0 && normalized.content.trim()) {
        extracted.push({
          id: `${normalized.id}:message`,
          kind: "message",
          label: this.shortenText(normalized.content, 48),
          detail: normalized.content.trim(),
          timestamp: normalized.completedAt ?? normalized.timestamp,
        });
      }

      for (const activity of extracted) {
        const signature = `${activity.kind}:${activity.label}:${activity.detail}:${activity.timestamp}`;
        if (seen.has(signature)) {
          continue;
        }
        seen.add(signature);
        activities.push(activity);
        if (activity.kind === "tool") {
          const toolName = activity.label.replace(/^tool:\s*/i, "").trim();
          if (toolName && !toolNames.includes(toolName)) {
            toolNames.push(toolName);
          }
        }
      }
    }

    const latestActivity = activities.at(-1) ?? null;
    const recentToolNames = activities
      .filter((activity) => activity.kind === "tool")
      .map((activity) => activity.label.replace(/^tool:\s*/i, "").trim())
      .filter((toolName, index, all) => Boolean(toolName) && all.indexOf(toolName) === index)
      .slice(-2)
      .reverse();

    return {
      sessionId,
      messageCount: messages.length,
      updatedAt: latestActivity?.timestamp ?? null,
      headline: latestActivity?.detail ?? null,
      activeToolNames: recentToolNames.length > 0 ? recentToolNames : toolNames.slice(-2).reverse(),
      activities,
    };
  }

  private extractRuntimeActivities(
    parts: Array<Record<string, unknown>>,
    message: OpenCodeNormalizedMessage,
    messageIndex: number,
  ): OpenCodeRuntimeActivity[] {
    const activities: OpenCodeRuntimeActivity[] = [];

    for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
      const part = parts[partIndex];
      if (!part) {
        continue;
      }
      const activity = this.partToRuntimeActivity(part, message, messageIndex, partIndex);
      if (activity) {
        activities.push(activity);
      }
    }

    return activities;
  }

  private partToRuntimeActivity(
    part: Record<string, unknown>,
    message: OpenCodeNormalizedMessage,
    messageIndex: number,
    partIndex: number,
  ): OpenCodeRuntimeActivity | null {
    const type = typeof part["type"] === "string" ? part["type"] : "";
    const timestamp = message.completedAt ?? message.timestamp;
    const toolName = this.extractToolName(part);

    if (toolName) {
      const toolDetail = this.extractToolCallDetail(part);
      return {
        id: `${message.id}:${messageIndex}:${partIndex}:tool`,
        kind: "tool",
        label: toolName,
        detail: toolDetail || "未获取到调用参数",
        timestamp,
      };
    }

    const reasoningDetail = this.extractReasoningDetail(part);
    if (reasoningDetail) {
      return {
        id: `${message.id}:${messageIndex}:${partIndex}:thinking`,
        kind: "thinking",
        label: this.shortenText(reasoningDetail, 48),
        detail: reasoningDetail,
        timestamp,
      };
    }

    if (type === "step-start" && typeof part["name"] === "string" && part["name"].trim()) {
      const detail = this.extractPartDetail(part);
      return {
        id: `${message.id}:${messageIndex}:${partIndex}:step`,
        kind: "step",
        label: part["name"].trim(),
        detail: detail || `执行步骤：${part["name"].trim()}`,
        timestamp,
      };
    }

    const detail = this.extractPartDetail(part);
    if (!detail) {
      return null;
    }

    return {
      id: `${message.id}:${messageIndex}:${partIndex}:message`,
      kind: "message",
      label: this.shortenText(detail, 48),
      detail,
      timestamp,
    };
  }

  private extractToolName(part: Record<string, unknown>): string | null {
    const type = typeof part["type"] === "string" ? part["type"].toLowerCase() : "";
    const directTool =
      (typeof part["toolName"] === "string" && part["toolName"].trim()) ||
      (typeof part["tool"] === "string" && part["tool"].trim()) ||
      (typeof part["name"] === "string" && part["name"].trim()) ||
      null;

    if (directTool && type.includes("tool")) {
      return directTool;
    }

    const toolRecord = this.asRecord(part["tool"]);
    if (typeof toolRecord["name"] === "string" && toolRecord["name"].trim()) {
      return toolRecord["name"].trim();
    }
    if (typeof toolRecord["id"] === "string" && toolRecord["id"].trim()) {
      return toolRecord["id"].trim();
    }

    const callRecord = this.asRecord(part["call"]);
    if (typeof callRecord["tool"] === "string" && callRecord["tool"].trim()) {
      return callRecord["tool"].trim();
    }
    if (typeof callRecord["name"] === "string" && callRecord["name"].trim()) {
      return callRecord["name"].trim();
    }
    if (typeof callRecord["id"] === "string" && callRecord["id"].trim()) {
      return callRecord["id"].trim();
    }

    return null;
  }

  private extractPartDetail(part: Record<string, unknown>): string {
    const textCandidates = [
      typeof part["summary"] === "string" ? part["summary"] : "",
      typeof part["text"] === "string" ? part["text"] : "",
      typeof part["title"] === "string" ? part["title"] : "",
      typeof part["description"] === "string" ? part["description"] : "",
      this.extractStructuredDetail(part["input"]),
      this.extractStructuredDetail(part["args"]),
      this.extractStructuredDetail(part["arguments"]),
      this.extractStructuredDetail(part["payload"]),
      this.extractStructuredDetail(part["output"]),
    ]
      .map((value) => value.trim())
      .filter(Boolean);

    return textCandidates[0] ?? "";
  }

  private extractReasoningDetail(part: Record<string, unknown>): string {
    const type = typeof part["type"] === "string" ? part["type"].toLowerCase() : "";
    if (type === "reasoning" && typeof part["text"] === "string") {
      return part["text"].trim();
    }
    if (typeof part["reasoning"] === "string") {
      return part["reasoning"].trim();
    }

    return "";
  }

  private extractToolCallDetail(part: Record<string, unknown>): string {
    const callRecord = this.asRecord(part["call"]);
    const toolRecord = this.asRecord(part["tool"]);
    const metadataRecord = this.asRecord(part["metadata"]);
    const stateRecord = this.asRecord(part["state"]);
    const argsValue =
      part["input"] ??
      part["args"] ??
      part["arguments"] ??
      part["payload"] ??
      part["options"] ??
      part["params"] ??
      part["data"] ??
      part["body"] ??
      callRecord["input"] ??
      callRecord["args"] ??
      callRecord["arguments"] ??
      callRecord["payload"] ??
      callRecord["options"] ??
      callRecord["params"] ??
      callRecord["data"] ??
      callRecord["body"] ??
      toolRecord["input"] ??
      toolRecord["args"] ??
      toolRecord["arguments"] ??
      toolRecord["payload"] ??
      toolRecord["options"] ??
      toolRecord["params"] ??
      toolRecord["data"] ??
      toolRecord["body"] ??
      metadataRecord["input"] ??
      metadataRecord["args"] ??
      metadataRecord["arguments"] ??
      metadataRecord["payload"] ??
      metadataRecord["options"] ??
      metadataRecord["params"] ??
      metadataRecord["data"] ??
      metadataRecord["body"] ??
      stateRecord["input"] ??
      stateRecord["args"] ??
      stateRecord["arguments"] ??
      stateRecord["payload"] ??
      stateRecord["options"] ??
      stateRecord["params"] ??
      stateRecord["data"] ??
      stateRecord["body"];
    const summary = this.extractStructuredArgsDetail(argsValue);
    return summary ? `参数: ${summary}` : "";
  }

  private extractStructuredArgsDetail(value: unknown, depth = 0): string {
    if (value == null || depth > 4) {
      return "";
    }

    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) {
        return "";
      }
      if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
        try {
          return this.extractStructuredArgsDetail(JSON.parse(trimmed), depth + 1);
        } catch {
          return this.shortenText(trimmed, 160);
        }
      }
      return this.shortenText(trimmed, 160);
    }

    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }

    if (Array.isArray(value)) {
      const items = value
        .map((item) => this.extractStructuredArgsDetail(item, depth + 1))
        .filter(Boolean)
        .slice(0, 6);
      return items.length > 0 ? this.shortenText(`[${items.join(", ")}]`, 180) : "";
    }

    const record = this.asRecord(value);
    const preferredEntries = Object.entries(record)
      .filter(([key, item]) => {
        if (item == null || item === "") {
          return false;
        }
        return !["output", "result", "response", "summary", "reasoning"].includes(key);
      })
      .slice(0, 6)
      .map(([key, item]) => {
        const summarized = this.extractStructuredArgsDetail(item, depth + 1);
        return summarized ? `${key}=${summarized}` : "";
      })
      .filter(Boolean);

    if (preferredEntries.length > 0) {
      return this.shortenText(preferredEntries.join(", "), 220);
    }

    for (const key of ["input", "args", "arguments", "payload", "options", "params", "data", "body"]) {
      if (key in record) {
        const nested = this.extractStructuredArgsDetail(record[key], depth + 1);
        if (nested) {
          return nested;
        }
      }
    }

    return "";
  }

  private extractStructuredDetail(value: unknown, depth = 0): string {
    if (value == null || depth > 3) {
      return "";
    }

    if (typeof value === "string") {
      return this.shortenText(value, 120);
    }

    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }

    if (Array.isArray(value)) {
      const items = value
        .map((item) => this.extractStructuredDetail(item, depth + 1))
        .filter(Boolean)
        .slice(0, 4);
      return items.length > 0 ? this.shortenText(`[${items.join(", ")}]`, 140) : "";
    }

    const record = this.asRecord(value);
    const direct = [
      typeof record["command"] === "string" ? record["command"] : "",
      typeof record["cmd"] === "string" ? record["cmd"] : "",
      typeof record["path"] === "string" ? record["path"] : "",
      typeof record["file"] === "string" ? record["file"] : "",
      typeof record["pattern"] === "string" ? record["pattern"] : "",
      typeof record["query"] === "string" ? record["query"] : "",
      typeof record["message"] === "string" ? record["message"] : "",
      typeof record["text"] === "string" ? record["text"] : "",
      typeof record["url"] === "string" ? record["url"] : "",
      typeof record["location"] === "string" ? record["location"] : "",
      typeof record["agent"] === "string" ? record["agent"] : "",
      typeof record["name"] === "string" ? record["name"] : "",
    ]
      .map((item) => item.trim())
      .filter(Boolean);

    if (direct[0]) {
      return this.shortenText(direct[0], 120);
    }

    for (const key of ["input", "args", "arguments", "payload", "options", "params", "data"]) {
      if (key in record) {
        const nested = this.extractStructuredDetail(record[key], depth + 1);
        if (nested) {
          return nested;
        }
      }
    }

    const entries = Object.entries(record)
      .filter(([, item]) => item != null && item !== "")
      .slice(0, 4)
      .map(([key, item]) => {
        const summarized = this.extractStructuredDetail(item, depth + 1) || this.shortenText(String(item), 40);
        return summarized ? `${key}=${summarized}` : "";
      })
      .filter(Boolean);

    return entries.length > 0 ? this.shortenText(entries.join(", "), 160) : "";
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  }

  private extractEventError(value: unknown): string | null {
    const record = this.asRecord(value);
    if (typeof record["message"] === "string") {
      return record["message"];
    }
    const data = this.asRecord(record["data"]);
    if (typeof data["message"] === "string") {
      return data["message"];
    }
    return null;
  }

  private toIsoString(value: unknown): string | null {
    if (typeof value === "string") {
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
    }
    if (typeof value === "number") {
      return new Date(value).toISOString();
    }
    return null;
  }

  private async waitForHealthy(baseUrl: string): Promise<boolean> {
    for (let attempt = 0; attempt < 15; attempt += 1) {
      try {
        const response = await fetch(`${baseUrl}/global/health`);
        if (response.ok) {
          return true;
        }
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }

    return false;
  }

  private async waitForServeBaseUrl(
    child: ChildProcessWithoutNullStreams,
    stdoutChunks: string[],
    stderrChunks: string[],
  ): Promise<string> {
    const readCurrent = () => extractOpenCodeServeBaseUrl(`${stdoutChunks.join("")}\n${stderrChunks.join("")}`);
    const existing = readCurrent();
    if (existing) {
      return existing;
    }

    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timeout);
        child.off("error", handleError);
        child.off("exit", handleExit);
        child.stdout.off("data", handleOutput);
        child.stderr.off("data", handleOutput);
      };
      const settle = (next: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        next();
      };
      const tryResolve = () => {
        const baseUrl = readCurrent();
        if (baseUrl) {
          settle(() => resolve(baseUrl));
        }
      };
      const handleOutput = () => {
        tryResolve();
      };
      const handleError = (error: Error) => {
        settle(() => reject(new Error(`OpenCode serve 启动失败: ${error.message}`)));
      };
      const handleExit = () => {
        const baseUrl = readCurrent();
        if (baseUrl) {
          settle(() => resolve(baseUrl));
          return;
        }
        settle(() => reject(new Error("OpenCode serve 启动失败: 未输出可解析的监听地址")));
      };
      const timeout = setTimeout(() => {
        settle(() => reject(new Error("OpenCode serve 启动失败: 等待监听地址输出超时")));
      }, SERVE_BASE_URL_TIMEOUT_MS);

      child.on("error", handleError);
      child.on("exit", handleExit);
      child.stdout.on("data", handleOutput);
      child.stderr.on("data", handleOutput);
      tryResolve();
    });
  }

  private buildBaseUrl(port: number): string {
    return `http://${this.host}:${port}`;
  }

  private parsePortFromBaseUrl(baseUrl: string): number {
    const parsed = new URL(baseUrl);
    const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error(`无效的 OpenCode attach 地址：${baseUrl}`);
    }
    return port;
  }

  private truncateLogPayload(value: string, maxLength = 4000): string {
    if (value.length <= maxLength) {
      return value;
    }
    return `${value.slice(0, maxLength)}...(truncated)`;
  }

  private normalizeProcessOutput(value: string | Buffer): string {
    return typeof value === "string" ? value : value.toString("utf8");
  }

  private mergeShutdownReports(reports: OpenCodeShutdownReport[]): OpenCodeShutdownReport {
    return {
      killedPids: [...new Set(reports.flatMap((report) => report.killedPids))],
    };
  }

  private extractVisibleMessageText(parts: Array<Record<string, unknown>>): string {
    const text = parts
      .map((part) => {
        if (part["type"] === "text" && typeof part["text"] === "string") {
          return part["text"];
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");

    return text;
  }

  private shortenText(value: string, limit: number): string {
    const trimmed = value.replace(/\s+/g, " ").trim();
    if (trimmed.length <= limit) {
      return trimmed;
    }
    return `${trimmed.slice(0, limit - 1)}…`;
  }
}
