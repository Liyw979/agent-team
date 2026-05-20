import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { parseDecision } from "./decision-parser";
import { buildSubmitMessageBody } from "./opencode-request-body";
import { toOpenCodeAgentId } from "./opencode-agent-id";
import { appendAppLog } from "./app-log";
import { extractOpenCodeServeBaseUrl } from "./opencode-serve-launch";
import { getOpenCodeRequestTimeoutMs, shouldTimeboxOpenCodeRequest } from "./opencode-request-timeout";
import { resolveWindowsCmdPath } from "./windows-shell";
import type { OpenCodeInjectedConfig } from "./project-agent-source";
import { toUtcIsoTimestamp, type UtcIsoTimestamp } from "@shared/types";

export interface ServeHandle {
  process: ChildProcessWithoutNullStreams;
  port: number;
}

type OpenCodeEvent = Record<string, unknown>;

export interface SubmitMessagePayload {
  content: string;
  agent: string;
}

interface OpenCodeMessageBase {
  id: string;
  sender: string;
  timestamp: UtcIsoTimestamp;
  raw: unknown;
}

export type OpenCodeNormalizedMessage =
  | (OpenCodeMessageBase & {
      content: string;
    })
  | (OpenCodeMessageBase & {
      content: string;
      error: string;
    });

export interface OpenCodeExecutionResult {
  status: "completed" | "error";
  finalMessage: string;
  messageId: string;
  timestamp: UtcIsoTimestamp;
  rawMessage: OpenCodeNormalizedMessage;
}

export interface OpenCodeRuntimeActivity {
  sourceMessageId: string;
  sourcePartIndex: number;
  kind: "tool" | "message" | "thinking" | "step";
  label: string;
  detail: string;
  detailState: "complete" | "missing" | "not_applicable";
  detailPayloadKeyCount: number;
  detailHasPlaceholderValue: boolean;
  detailParseMode: "structured" | "plain_text" | "missing" | "not_applicable";
  timestamp: UtcIsoTimestamp;
}

export interface OpenCodeSessionRuntime {
  sessionId: string;
  messageCount: number;
  updatedAt: string;
  headline: string;
  activeToolNames: string[];
  activities: OpenCodeRuntimeActivity[];
}

interface OpenCodeToolCallDetail {
  detail: string;
  detailState: OpenCodeRuntimeActivity["detailState"];
  detailPayloadKeyCount: number;
  detailHasPlaceholderValue: boolean;
  detailParseMode: OpenCodeRuntimeActivity["detailParseMode"];
}

const TOOL_CALL_DETAIL_KEYS = [
  "input",
  "args",
  "arguments",
  "payload",
  "options",
  "params",
  "data",
  "body",
] as const;

const TOOL_CALL_DETAIL_CONTAINERS = [
  "state",
  "call",
  "tool",
  "metadata",
] as const;

const MAX_RUNTIME_MESSAGES = 100;
const SERVE_BASE_URL_TIMEOUT_MS = 10_000;
const TRANSPORT_ERROR_RECOVERY_TIMEOUT_MS = 180_000;
const RETRYABLE_CLIENT_INTERVAL_MS = 60_000;
interface SessionWaiter {
  sessionId: string;
  after: number;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface WorkspaceEventState {
  eventPump: Promise<void>;
  eventSubscribers: Set<(event: OpenCodeEvent) => void>;
}

type RequestOptions =
  | {
      method: "GET";
    }
  | {
      method: "POST";
      body: string;
    };

interface RecoveredTransportExecutionResult {
  kind: "recovered";
  result: OpenCodeExecutionResult;
}

interface TimedOutTransportExecutionResult {
  kind: "timed_out";
}

type TransportRecoveryResult =
  | RecoveredTransportExecutionResult
  | TimedOutTransportExecutionResult;

type TransportRecoveryInspection =
  | {
    kind: "empty";
    messageCount: 0;
  }
  | {
    kind: "submitted-message-missing";
    messageCount: number;
  }
  | {
    kind: "waiting-without-related-reply";
    messageCount: number;
  }
  | {
    kind: "waiting-with-related-reply";
    messageCount: number;
    relatedReplyCount: number;
  }
  | {
    kind: "recovered";
    messageCount: number;
    result: OpenCodeExecutionResult;
  };

class RetryableSubmitMessageError extends Error {}

class RetryableExecutionResultError extends Error {}
export interface OpenCodeShutdownReport {
  killedPids: number[];
}

const idleEventPumpPromise = Promise.resolve();

const idleWorkspaceEventState: WorkspaceEventState = {
  eventPump: idleEventPumpPromise,
  eventSubscribers: new Set(),
};

export class OpenCodeClient {
  workspaceEventState: WorkspaceEventState = idleWorkspaceEventState;
  readonly host = "127.0.0.1";
  readonly sessionIdleAt = new Map<string, number>();
  readonly sessionErrors = new Map<string, string>();
  readonly sessionWaiters = new Map<string, SessionWaiter[]>();
  private readonly runningServe: ServeHandle;

  constructor(input: { server: ServeHandle }) {
    this.runningServe = input.server;
  }

  protected getWorkspaceEventState(): WorkspaceEventState {
    if (this.workspaceEventState === idleWorkspaceEventState) {
      this.workspaceEventState = {
        eventPump: idleEventPumpPromise,
        eventSubscribers: new Set(),
      };
    }
    return this.workspaceEventState;
  }

  async createSession(
    title: string,
  ): Promise<string> {
    const response = await this.request("/session", {
      method: "POST",
      body: JSON.stringify({ title }),
    });

    if (!response.ok) {
      appendAppLog("error", "opencode.create_session_failed", {
        title,
        status: response.status,
        statusText: response.statusText,
      });
      throw new Error(`OpenCode 创建 session 失败: ${response.status}`);
    }

    try {
      const data = this.expectRecord(
        await this.readJsonResponse(response),
        "OpenCode 创建 session 响应",
      );
      return this.readRequiredTrimmedString(
        data["id"],
        "OpenCode 创建 session 响应.id",
      );
    } catch {
      appendAppLog("error", "opencode.create_session_invalid_response", {
        title,
        status: response.status,
      });
      throw new Error("OpenCode 创建 session 响应缺少有效的 session id");
    }
  }

  async connectEvents(
    onEvent: (event: OpenCodeEvent) => void,
  ): Promise<void> {
    const state = this.getWorkspaceEventState();
    state.eventSubscribers.add(onEvent);
    if (state.eventPump !== idleEventPumpPromise) {
      return state.eventPump;
    }

    const eventPump = this.startEventPump((event) => {
      for (const subscriber of state.eventSubscribers) {
        subscriber(event);
      }
    }).finally(() => {
      if (state.eventPump === eventPump) {
        state.eventPump = idleEventPumpPromise;
      }
    });
    state.eventPump = eventPump;
    await eventPump;
  }

  disconnectEvents(onEvent: (event: OpenCodeEvent) => void): void {
    this.workspaceEventState.eventSubscribers.delete(onEvent);
  }

  async submitMessage(
    sessionId: string,
    payload: SubmitMessagePayload,
  ): Promise<OpenCodeNormalizedMessage> {
    const opencodeAgent = toOpenCodeAgentId(payload.agent);
    let immediateRetryUsed = false;
    while (true) {
      try {
        const body = buildSubmitMessageBody({
          agent: opencodeAgent,
          content: payload.content,
        });

        const response = await this.request(`/session/${sessionId}/message`, {
          method: "POST",
          body: JSON.stringify(body),
        }).catch((error) => {
          throw new RetryableSubmitMessageError(String(error));
        });

        if (!response.ok) {
          throw new RetryableSubmitMessageError(`OpenCode 请求失败: ${response.status}`);
        }

        try {
          return this.parseMessageEnvelope(
            await this.readJsonResponse(response),
            opencodeAgent,
            "OpenCode 提交消息响应",
          );
        } catch {
          appendAppLog("error", "opencode.submit_message_invalid_response", {
            sessionId,
            agent: opencodeAgent,
            status: response.status,
          });
          throw new RetryableSubmitMessageError("OpenCode 提交消息响应缺少有效的消息实体");
        }
      } catch (error) {
        if (!(error instanceof RetryableSubmitMessageError)) {
          throw error;
        }
        this.logRetriedMessageResend(sessionId, opencodeAgent, error.message);
        if (immediateRetryUsed) {
          await new Promise((resolve) => setTimeout(resolve, RETRYABLE_CLIENT_INTERVAL_MS));
        }
        immediateRetryUsed = true;
      }
    }
  }

  async resolveExecutionResult(
    sessionId: string,
    submitted: OpenCodeNormalizedMessage,
    agentId: string,
    allowedDecisionTriggers: string[],
  ): Promise<OpenCodeExecutionResult> {
    let currentSubmitted = submitted;
    let immediateRetryUsed = false;
    while (true) {
      try {
        const submittedAt = Date.parse(currentSubmitted.timestamp) || Date.now();
        const messageCompletionPromise = this.waitForMessageCompletion(
          sessionId,
          currentSubmitted.id,
          8000,
        );
        let latest: OpenCodeNormalizedMessage;
        try {
          latest = await Promise.race([
            messageCompletionPromise,
            this.waitForSessionSettled(sessionId, submittedAt, 8000).then(() =>
              this.getSessionMessage(sessionId, currentSubmitted.id)),
          ]);
        } catch (error) {
          try {
            latest = await this.getLatestAssistantMessage(sessionId);
          } catch (latestError) {
            if (error instanceof RetryableExecutionResultError) {
              throw error;
            }
            throw latestError;
          }
        }

        const finalMessage = this.messageHasError(latest.raw)
          ? this.readMessageError(latest.raw, `OpenCode session ${sessionId} 最终消息`)
          : latest.content;
        if (!finalMessage.trim()) {
          throw new RetryableExecutionResultError(this.buildEmptyAssistantResultError(sessionId, latest));
        }

        const result: OpenCodeExecutionResult = {
          status: this.messageHasError(latest.raw) ? "error" : "completed",
          finalMessage,
          messageId: latest.id,
          timestamp: latest.timestamp,
          rawMessage: latest,
        };
        if (result.status === "error" || allowedDecisionTriggers.length === 0) {
          return result;
        }

        if (
          parseDecision(
            result.finalMessage,
            true,
            allowedDecisionTriggers.map((trigger) => ({ trigger })),
          ).kind === "valid"
        ) {
          return result;
        }

        this.logRetriedMessageResend(
          sessionId,
          agentId,
          `OpenCode 未返回需要的 trigger: ${allowedDecisionTriggers.join(" / ")}`,
        );
        if (immediateRetryUsed) {
          await new Promise((resolve) => setTimeout(resolve, RETRYABLE_CLIENT_INTERVAL_MS));
        }
        immediateRetryUsed = true;
        currentSubmitted = await this.submitMessage(
          sessionId,
          {
            agent: agentId,
            content: `回复需要包含 ${allowedDecisionTriggers.join(" / ")} 中的一个`,
          },
        );
      } catch (error) {
        if (!(error instanceof RetryableExecutionResultError)) {
          throw error;
        }
        if (immediateRetryUsed) {
          await new Promise((resolve) => setTimeout(resolve, RETRYABLE_CLIENT_INTERVAL_MS));
        }
        immediateRetryUsed = true;
      }
    }
  }

  async recoverExecutionResultAfterTransportError(
    sessionId: string,
    startedAt: string,
    errorMessage: string,
    timeoutMs = TRANSPORT_ERROR_RECOVERY_TIMEOUT_MS,
  ): Promise<TransportRecoveryResult> {
    const startedAtMs = Date.parse(startedAt);
    const lowerBound = Number.isFinite(startedAtMs) ? startedAtMs - 2_000 : Date.now() - 2_000;
    const deadline = Date.now() + timeoutMs;
    appendAppLog("info", "opencode.transport_recovery_started", {
      sessionId,
      startedAt,
      errorMessage,
      timeoutMs,
    });

    while (Date.now() < deadline) {
      const inspection = await this.inspectTransportRecovery(sessionId, lowerBound);
      if (inspection.kind === "recovered") {
        appendAppLog("info", "opencode.transport_recovery_succeeded", {
          sessionId,
          recoveredMessageId: inspection.result.messageId,
          recoveredAt: inspection.result.timestamp,
        });
        return {
          kind: "recovered",
          result: inspection.result,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }

    const finalInspection = await this.inspectTransportRecovery(sessionId, lowerBound);
    if (finalInspection.kind === "recovered") {
      appendAppLog("info", "opencode.transport_recovery_succeeded", {
        sessionId,
        recoveredMessageId: finalInspection.result.messageId,
        recoveredAt: finalInspection.result.timestamp,
      });
      return {
        kind: "recovered",
        result: finalInspection.result,
      };
    }

    appendAppLog("error", "opencode.transport_recovery_timed_out", {
      sessionId,
      startedAt,
      errorMessage,
      timeoutMs,
      ...this.buildTransportRecoveryTimeoutDetails(finalInspection),
    });
    return {
      kind: "timed_out",
    };
  }

  async getSessionRuntime(
    sessionId: string,
  ): Promise<OpenCodeSessionRuntime> {
    const list = await this.listSessionMessages(sessionId, MAX_RUNTIME_MESSAGES);
    if (list.length === 0) {
      return {
        sessionId,
        messageCount: 0,
        updatedAt: "",
        headline: "",
        activeToolNames: [],
        activities: [],
      };
    }
    return this.buildRuntimeSnapshot(sessionId, list);
  }

  private logRetriedMessageResend(sessionId: string, agent: string, reason: string) {
    const message = `Agent ${agent}: ${reason}异常，已重新发送消息`;
    appendAppLog("warn", "opencode.submit_message_retried", {
      sessionId,
      agent,
      reason,
      message,
    });
    process.stdout.write(`${message}\n`);
  }

  async shutdown(): Promise<OpenCodeShutdownReport> {
    let report: OpenCodeShutdownReport = {
      killedPids: [],
    };
    try {
      report = await this.terminateServeHandle();
    } catch {
      // ignore shutdown errors
    } finally {
      this.workspaceEventState.eventPump = idleEventPumpPromise;
      this.workspaceEventState.eventSubscribers.clear();
      this.workspaceEventState = idleWorkspaceEventState;
      this.clearSessionState();
    }
    return report;
  }

  private clearSessionState() {
    this.sessionIdleAt.clear();
    this.sessionErrors.clear();
    this.sessionWaiters.clear();
  }

  private async terminateServeHandle(): Promise<OpenCodeShutdownReport> {
    const server = this.runningServe;
    const killedPids = this.findListeningPids(server.port)
      .filter((pid) => this.isOpenCodeServeProcess(pid));

    await OpenCodeClient.killChildProcessTree(server.process);

    for (const pid of this.findListeningPids(server.port)) {
      if (!this.isOpenCodeServeProcess(pid)) {
        continue;
      }
      OpenCodeClient.killProcess(pid);
      killedPids.push(pid);
    }

    return {
      killedPids: [...new Set(killedPids)],
    };
  }

  private static async killChildProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
    const pid = child.pid;
    if (!pid) {
      if (!child.killed) {
        child.kill();
      }
      return;
    }

    if (process.platform === "win32") {
      OpenCodeClient.killWindowsProcessTree(pid);
      const exited = await OpenCodeClient.waitForChildExit(child, 1500);
      if (!exited && !child.killed) {
        child.kill("SIGKILL");
        await OpenCodeClient.waitForChildExit(child, 1000);
      }
      return;
    }

    const processTree = OpenCodeClient.collectUnixProcessTreePids(pid);
    OpenCodeClient.killUnixPids(processTree, "SIGTERM");
    await OpenCodeClient.waitForChildExit(child, 1500);
    if (OpenCodeClient.findAlivePids(processTree).length === 0) {
      return;
    }

    OpenCodeClient.killUnixPids(processTree, "SIGKILL");
    await OpenCodeClient.waitForChildExit(child, 1000);
  }

  private static waitForChildExit(
    child: ChildProcessWithoutNullStreams,
    timeoutMs: number,
  ): Promise<boolean> {
    if (typeof child.exitCode === "number" || typeof child.signalCode === "string") {
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

  private static killWindowsProcessTree(pid: number) {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch {
      OpenCodeClient.killProcess(pid);
    }
  }

  private static killUnixPids(targets: number[], signal: NodeJS.Signals) {
    for (const targetPid of targets.reverse()) {
      try {
        process.kill(targetPid, signal);
      } catch {
        // ignore
      }
    }
  }

  private static collectUnixProcessTreePids(rootPid: number): number[] {
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
        const current = childPidsByParent.get(parentPid) || [];
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
        for (const childPid of childPidsByParent.get(currentPid) || []) {
          pending.push(childPid);
        }
      }
      return ordered;
    } catch {
      return [rootPid];
    }
  }

  private static findAlivePids(targets: number[]): number[] {
    return targets.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
  }

  static async startServer(cwd: string, config: OpenCodeInjectedConfig): Promise<ServeHandle> {
    // OpenCode serve must still inherit the real workspace directory as its process cwd.
    const serverEnv = { ...process.env };
    // Isolate the embedded runtime from parent OpenCode config injection.
    delete serverEnv["OPENCODE_CONFIG"];
    delete serverEnv["OPENCODE_CONFIG_CONTENT"];
    delete serverEnv["OPENCODE_CONFIG_DIR"];
    delete serverEnv["OPENCODE_DB"];
    delete serverEnv["OPENCODE_CLIENT"];
    serverEnv["OPENCODE_CLIENT"] = "agent-team-orchestrator";
    serverEnv["OPENCODE_DISABLE_PROJECT_CONFIG"] = "true";
    if (Object.keys(config.agent).length > 0) {
      serverEnv["OPENCODE_CONFIG_CONTENT"] = JSON.stringify(config);
    }
    appendAppLog("info", "opencode.serve_starting", { spawnCwd: cwd });
    const launchArgs = ["serve"];
    const spawnSpec = process.platform === "win32"
      ? {
          command: resolveWindowsCmdPath(serverEnv),
          args: [
            "/d",
            "/s",
            "/c",
            `cd /d ${cwd} && opencode ${launchArgs.join(" ")}`,
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
        cwd,
        env: serverEnv,
        stdio: "pipe",
      },
    );

    let spawnErrorMessage = "";
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    childProcess.on("error", (error) => {
      spawnErrorMessage = error instanceof Error ? error.message : String(error);
    });

    childProcess.stderr.on("data", (chunk) => {
      stderrChunks.push(OpenCodeClient.normalizeProcessOutput(chunk));
    });
    childProcess.stdout.on("data", (chunk) => {
      stdoutChunks.push(OpenCodeClient.normalizeProcessOutput(chunk));
    });

    const baseUrl = await OpenCodeClient.waitForServeBaseUrl(childProcess, stdoutChunks, stderrChunks).catch(async (error) => {
      await OpenCodeClient.killChildProcessTree(childProcess).catch(() => "");
      appendAppLog("error", "opencode.serve_start_failed", {
        spawnCwd: cwd,
        pid: childProcess.pid,
        command: spawnSpec.command,
        args: spawnSpec.args,
        message: error instanceof Error ? error.message : String(error),
        stdout: OpenCodeClient.truncateLogPayload(stdoutChunks.join("")),
        stderr: OpenCodeClient.truncateLogPayload(stderrChunks.join("")),
      });
      throw error;
    });
    const port = OpenCodeClient.parsePortFromBaseUrl(baseUrl);
    const healthy = await OpenCodeClient.waitForHealthy(baseUrl);
    if (spawnErrorMessage || !healthy) {
      const message = spawnErrorMessage
        ? `OpenCode serve 启动失败: ${spawnErrorMessage}`
          : `OpenCode serve 健康检查失败: ${baseUrl}/global/health 未在预期时间内返回成功`;
      await OpenCodeClient.killChildProcessTree(childProcess).catch(() => "");
      appendAppLog("error", "opencode.serve_start_failed", {
        spawnCwd: cwd,
        pid: childProcess.pid,
        port,
        baseUrl,
        command: spawnSpec.command,
        args: spawnSpec.args,
        message,
        stdout: OpenCodeClient.truncateLogPayload(stdoutChunks.join("")),
        stderr: OpenCodeClient.truncateLogPayload(stderrChunks.join("")),
      });
      throw new Error(message);
    }

    appendAppLog("info", "opencode.serve_started", {
      spawnCwd: cwd,
      pid: childProcess.pid,
      port,
      baseUrl,
      command: spawnSpec.command,
      args: spawnSpec.args,
    });

    return {
      process: childProcess,
      port,
    };
  }

  async getAttachBaseUrl(): Promise<string> {
    return this.buildBaseUrl(this.runningServe.port);
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

  private static killProcess(pid: number) {
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
  ): Promise<void> {
    const response = await fetch(`${this.buildBaseUrl(this.runningServe.port)}/global/event`);
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
      buffer = chunks.pop() || "";

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
  }

  private handleEvent(event: OpenCodeEvent) {
    const eventType = typeof event["type"] === "string" ? event["type"] : "";
    if (eventType === "session.idle") {
      const properties = this.expectRecord(
        event["properties"],
        "OpenCode 事件 session.idle.properties",
      );
      const sessionId = this.readRequiredTrimmedString(
        properties["sessionID"],
        "OpenCode 事件 session.idle.properties.sessionID",
      );
      this.sessionIdleAt.set(sessionId, Date.now());
      const waiters = this.sessionWaiters.get(sessionId) || [];
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
      const properties = this.expectRecord(
        event["properties"],
        "OpenCode 事件 session.error.properties",
      );
      const sessionId = this.readRequiredTrimmedString(
        properties["sessionID"],
        "OpenCode 事件 session.error.properties.sessionID",
      );
      const error = this.readEventError(
        properties["error"],
        "OpenCode 事件 session.error.properties.error",
      );
      this.sessionErrors.set(sessionId, error);
      const waiters = this.sessionWaiters.get(sessionId) || [];
      this.sessionWaiters.delete(sessionId);
      for (const waiter of waiters) {
        waiter.reject(new Error(error));
      }
    }
  }

  protected async request(
    pathname: string,
    options: RequestOptions,
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (options.method === "POST") {
      headers["content-type"] = "application/json";
    }

    const shouldTimebox = shouldTimeboxOpenCodeRequest({
      pathname,
      method: options.method,
    });
    const url = `${this.buildBaseUrl(this.runningServe.port)}${pathname}`;
    const requestInit: RequestInit = {
      method: options.method,
      headers,
    };
    if (options.method === "POST") {
      requestInit.body = options.body;
    }
    try {
      return await this.fetchWithTimeout(url, requestInit, shouldTimebox);
    } catch (error) {
      appendAppLog("error", "opencode.request_failed", {
        method: options.method,
        url,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async fetchWithTimeout(url: string, init: RequestInit, shouldTimebox: boolean): Promise<Response> {
    if (!shouldTimebox) {
      return fetch(url, init);
    }
    const timeoutMs = getOpenCodeRequestTimeoutMs();
    const controller = new AbortController();
    const method = typeof init.method === "string" ? init.method.toUpperCase() : "GET";
    const timeoutMessage = `OpenCode 请求超时: ${method} ${url} 超过 ${timeoutMs}ms`;
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
        const waiters = this.sessionWaiters.get(sessionId) || [];
        this.sessionWaiters.set(
          sessionId,
          waiters.filter((item) => item !== waiter),
        );
        resolve();
      }, timeoutMs);

      this.sessionWaiters.set(sessionId, [...(this.sessionWaiters.get(sessionId) || []), waiter]);
    });
  }

  async waitForMessageCompletion(
    sessionId: string,
    messageId: string,
    timeoutMs: number,
  ): Promise<OpenCodeNormalizedMessage> {
    const startedAt = Date.now();
    let latestNonEmptyMessage = "";
    while (Date.now() - startedAt < timeoutMs) {
      try {
        const message = await this.getSessionMessage(sessionId, messageId);
        if (message.content.trim()) {
          latestNonEmptyMessage = message.content;
        }
        if (this.isTerminalMessage(message)) {
          return message;
        }
      } catch {
        // keep polling until timeout
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }

    try {
      return await this.getSessionMessage(sessionId, messageId);
    } catch {
      if (latestNonEmptyMessage) {
        throw new RetryableExecutionResultError(
          `OpenCode session ${sessionId} 返回了未完成的 assistant 消息: messageId=${messageId}, preview=${this.shortenText(latestNonEmptyMessage, 48)}`,
        );
      }
      throw new RetryableExecutionResultError(`OpenCode session ${sessionId} 未返回任何有效的 assistant 消息`);
    }
  }

  async getLatestAssistantMessage(
    sessionId: string,
  ): Promise<OpenCodeNormalizedMessage> {
    const list = await this.listSessionMessages(sessionId, 0);
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const message = this.parseMessageEnvelope(
        list[index],
        "assistant",
        `OpenCode session ${sessionId} 最新消息`,
      );
      if (message.sender === "assistant" || message.sender === "system") {
        return message;
      }
    }
    throw new RetryableExecutionResultError(`OpenCode session ${sessionId} 未返回任何有效的 assistant 消息`);
  }

  private async inspectTransportRecovery(
    sessionId: string,
    lowerBoundMs: number,
  ): Promise<TransportRecoveryInspection> {
    const messages = await this.listSessionMessages(sessionId, MAX_RUNTIME_MESSAGES);
    if (messages.length === 0) {
      return {
        kind: "empty",
        messageCount: 0,
      };
    }

    const normalizedRecords = messages.map((raw) => {
      const envelope = this.expectRecord(raw, `OpenCode session ${sessionId} 消息列表项`);
      const info = "info" in envelope
        ? this.expectRecord(envelope["info"], `OpenCode session ${sessionId} 消息列表项.info`)
        : envelope;
      const normalized = this.parseMessageEnvelope(
        raw,
        "assistant",
        `OpenCode session ${sessionId} 消息列表项`,
      );
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
      return {
        kind: "submitted-message-missing",
        messageCount: messages.length,
      };
    }

    const relatedReplies = this.collectRelatedTransportReplies(normalizedRecords, submittedMessage.normalized.id)
      .sort((left, right) => {
        const leftTimestamp = Date.parse(left.normalized.timestamp) || 0;
        const rightTimestamp = Date.parse(right.normalized.timestamp) || 0;
        return rightTimestamp - leftTimestamp;
      });

    const finalReply = relatedReplies
      .filter((record) =>
        this.isRecoverableReplyCandidate(record.info, record.normalized))[0];
    if (!finalReply) {
      if (relatedReplies.length === 0) {
        return {
          kind: "waiting-without-related-reply",
          messageCount: messages.length,
        };
      }

      return {
        kind: "waiting-with-related-reply",
        messageCount: messages.length,
        relatedReplyCount: relatedReplies.length,
      };
    }

    const message = finalReply.normalized;
    const status = this.messageHasError(message.raw) ? "error" : "completed";
    return {
      kind: "recovered",
      result: {
        status,
        finalMessage: status === "error"
          ? this.readMessageError(message.raw, `OpenCode session ${sessionId} 恢复结果`)
          : message.content,
        messageId: message.id,
        timestamp: message.timestamp,
        rawMessage: message,
      },
      messageCount: messages.length,
    };
  }

  private buildTransportRecoveryTimeoutDetails(inspection: Exclude<TransportRecoveryInspection, { kind: "recovered" }>) {
    const baseDetails = {
      observedMessageCount: inspection.messageCount,
      recoveryState: inspection.kind,
    };
    if (inspection.kind === "waiting-with-related-reply") {
      return {
        ...baseDetails,
        relatedReplyCount: inspection.relatedReplyCount,
      };
    }

    return baseDetails;
  }

  private collectRelatedTransportReplies(
    records: Array<{
      raw: unknown;
      info: Record<string, unknown>;
      normalized: OpenCodeNormalizedMessage;
      createdAtMs: number;
    }>,
    rootMessageId: string,
  ) {
    const childrenByParent = new Map<string, typeof records>();
    for (const record of records) {
      if (!("parentID" in record.info)) {
        continue;
      }
      const parentMessageId = this.readRequiredTrimmedString(
        record.info["parentID"],
        "OpenCode 消息 info.parentID",
      );
      const siblings = childrenByParent.get(parentMessageId) || [];
      siblings.push(record);
      childrenByParent.set(parentMessageId, siblings);
    }

    const relatedReplies: typeof records = [];
    const pending = [...(childrenByParent.get(rootMessageId) || [])];
    const seenMessageIds = new Set<string>();

    while (pending.length > 0) {
      const current = pending.shift();
      if (!current) {
        continue;
      }
      const currentMessageId = current.normalized.id;
      if (seenMessageIds.has(currentMessageId)) {
        continue;
      }
      seenMessageIds.add(currentMessageId);
      if (
        current.normalized.sender !== "assistant"
        && current.normalized.sender !== "system"
      ) {
        continue;
      }
      relatedReplies.push(current);
      pending.push(...(childrenByParent.get(currentMessageId) || []));
    }

    return relatedReplies;
  }

  async getSessionMessage(
    sessionId: string,
    messageId: string,
  ): Promise<OpenCodeNormalizedMessage> {
    const response = await this.request(`/session/${sessionId}/message/${messageId}`, {
      method: "GET",
    });
    if (!response.ok) {
      throw new RetryableExecutionResultError(`OpenCode session ${sessionId} 未找到消息 ${messageId}`);
    }
    return this.parseMessageEnvelope(
      await this.readJsonResponse(response),
      "assistant",
      `OpenCode session ${sessionId} 的消息 ${messageId}`,
    );
  }

  async listSessionMessages(
    sessionId: string,
    limit: number,
  ): Promise<unknown[]> {
    const pathname = limit > 0
      ? `/session/${sessionId}/message?limit=${limit}`
      : `/session/${sessionId}/message`;
    const response = await this.request(pathname, {
      method: "GET",
    });
    if (!response.ok) {
      throw new Error(`OpenCode 会话消息查询失败: ${response.status}`);
    }
    const parsed = await this.readJsonResponse(response);
    if (!Array.isArray(parsed)) {
      throw new Error("OpenCode 会话消息响应必须是数组");
    }
    return parsed;
  }

  private async readJsonResponse(response: Response): Promise<unknown> {
    const raw = await response.text();
    const trimmed = raw.trim();
    if (!trimmed) {
      throw new Error("OpenCode 响应体为空");
    }

    try {
      return JSON.parse(trimmed) as unknown;
    } catch (error) {
      throw new Error(
        `OpenCode 响应体不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private parseMessageEnvelope(
    raw: unknown,
    fallbackSender: string,
    context: string,
  ): OpenCodeNormalizedMessage {
    const envelope = this.expectRecord(raw, context);
    const info = "info" in envelope
      ? this.expectRecord(envelope["info"], `${context}.info`)
      : envelope;
    const parts = Array.isArray(envelope["parts"])
      ? envelope["parts"].map((part, index) =>
          this.expectRecord(part, `${context}.parts[${index}]`))
      : [];
    const content = this.readVisibleMessageContent(envelope, parts, context);
    const id = "id" in info
      ? this.readRequiredTrimmedString(info["id"], `${context}.info.id`)
      : this.readRequiredTrimmedString(envelope["id"], `${context}.id`);
    const sender = "role" in info
      ? this.readRequiredTrimmedString(info["role"], `${context}.info.role`)
      : "sender" in envelope
        ? this.readRequiredTrimmedString(envelope["sender"], `${context}.sender`)
        : fallbackSender;
    const timestamp = toUtcIsoTimestamp(this.readMessageTimestamp(info, context));
    if ("error" in info) {
      const error = this.readEventError(info["error"], `${context}.info.error`);
      return {
        id,
        content,
        sender,
        timestamp,
        error,
        raw,
      };
    }
    if ("error" in envelope) {
      const error = this.readEventError(envelope["error"], `${context}.error`);
      return {
        id,
        content,
        sender,
        timestamp,
        error,
        raw,
      };
    }
    return {
      id,
      content,
      sender,
      timestamp,
      raw,
    };
  }

  private isTerminalMessage(message: OpenCodeNormalizedMessage): boolean {
    return this.hasCompletedTimestamp(message.raw) || this.messageHasError(message.raw);
  }

  private messageHasError(raw: unknown): boolean {
    const envelope = this.expectRecord(raw, "OpenCode 消息");
    const info = "info" in envelope
      ? this.expectRecord(envelope["info"], "OpenCode 消息.info")
      : envelope;
    return "error" in info || "error" in envelope;
  }

  private readMessageError(raw: unknown, context: string): string {
    const envelope = this.expectRecord(raw, context);
    const info = "info" in envelope
      ? this.expectRecord(envelope["info"], `${context}.info`)
      : envelope;
    if ("error" in info) {
      return this.readEventError(info["error"], `${context}.info.error`);
    }
    return this.readEventError(envelope["error"], `${context}.error`);
  }

  private readVisibleMessageContent(
    envelope: Record<string, unknown>,
    parts: Array<Record<string, unknown>>,
    context: string,
  ): string {
    if (parts.length > 0) {
      return this.extractVisibleMessageText(parts);
    }
    if ("content" in envelope) {
      return typeof envelope["content"] === "string"
        ? envelope["content"]
        : this.readRequiredTrimmedString(envelope["content"], `${context}.content`);
    }
    if ("text" in envelope) {
      return typeof envelope["text"] === "string"
        ? envelope["text"]
        : this.readRequiredTrimmedString(envelope["text"], `${context}.text`);
    }
    return "";
  }

  private hasCompletedTimestamp(raw: unknown): boolean {
    const envelope = this.expectRecord(raw, "OpenCode 消息");
    const info = "info" in envelope
      ? this.expectRecord(envelope["info"], "OpenCode 消息.info")
      : envelope;
    if ("time" in info) {
      const time = this.expectRecord(info["time"], "OpenCode 消息.info.time");
      if (this.isIsoLikeValue(time["completed"])) {
        return true;
      }
    }
    return this.isIsoLikeValue(info["completedAt"]);
  }

  private buildEmptyAssistantResultError(
    sessionId: string,
    message: OpenCodeNormalizedMessage,
  ): string {
    const record = this.expectRecord(message.raw, `OpenCode session ${sessionId} assistant 消息`);
    const info = "info" in record
      ? this.expectRecord(record["info"], `OpenCode session ${sessionId} assistant 消息.info`)
      : record;
    const parts = Array.isArray(record["parts"])
      ? record["parts"].map((part, index) =>
          this.expectRecord(part, `OpenCode session ${sessionId} assistant 消息.parts[${index}]`))
      : [];
    const finish = typeof info["finish"] === "string" && info["finish"].trim()
      ? info["finish"].trim()
      : "unknown";
    const partTypes = parts
      .map((part) => (typeof part["type"] === "string" ? part["type"].trim() : ""))
      .filter(Boolean);
    const partSummary = partTypes.length > 0 ? partTypes.join(",") : "none";
    return `OpenCode session ${sessionId} 返回了空的 assistant 结果: messageId=${message.id}, finish=${finish}, partTypes=${partSummary}`;
  }

  private isRecoverableReplyCandidate(
    info: Record<string, unknown>,
    message: OpenCodeNormalizedMessage,
  ): boolean {
    if (message.sender !== "assistant" && message.sender !== "system" && message.sender !== "unknown") {
      return false;
    }

    if (this.messageHasError(message.raw)) {
      return true;
    }

    return this.isTerminalRecoverableFinish(info) && message.content.trim().length > 0;
  }

  private isTerminalRecoverableFinish(info: Record<string, unknown>): boolean {
    if (typeof info["finish"] !== "string") {
      return false;
    }

    const finish = info["finish"].trim();
    return finish.length > 0 && finish !== "tool-calls";
  }

  buildRuntimeSnapshot(sessionId: string, messages: unknown[]): OpenCodeSessionRuntime {
    const activities: OpenCodeRuntimeActivity[] = [];
    const toolNames: string[] = [];
    const seen = new Set<string>();

    for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
      const raw = messages[messageIndex];
      const record = this.expectRecord(raw, `OpenCode session ${sessionId} 运行时消息`);
      const parts = Array.isArray(record["parts"])
        ? record["parts"].map((part, index) =>
            this.expectRecord(part, `OpenCode session ${sessionId} 运行时消息.parts[${index}]`))
        : [];
      const normalized = this.parseMessageEnvelope(
        raw,
        "assistant",
        `OpenCode session ${sessionId} 运行时消息`,
      );
      if (normalized.sender === "user") {
        continue;
      }

      const extracted = this.extractRuntimeActivities(parts, normalized);

      if (extracted.length === 0 && normalized.content.trim()) {
        extracted.push({
          sourceMessageId: normalized.id,
          sourcePartIndex: 0,
          kind: "message",
          label: this.shortenText(normalized.content, 48),
          detail: normalized.content.trim(),
          detailState: "not_applicable",
          detailPayloadKeyCount: 0,
          detailHasPlaceholderValue: false,
          detailParseMode: "not_applicable",
          timestamp: normalized.timestamp,
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

    const latestActivity = activities.at(-1);
    if (!latestActivity) {
      return {
        sessionId,
        messageCount: messages.length,
        updatedAt: "",
        headline: "",
        activeToolNames: [],
        activities: [],
      };
    }
    const recentToolNames = activities
      .filter((activity) => activity.kind === "tool")
      .map((activity) => activity.label.replace(/^tool:\s*/i, "").trim())
      .filter((toolName, index, all) => Boolean(toolName) && all.indexOf(toolName) === index)
      .slice(-2)
      .reverse();

    return {
      sessionId,
      messageCount: messages.length,
      updatedAt: latestActivity.timestamp,
      headline: latestActivity.detail,
      activeToolNames: recentToolNames.length > 0 ? recentToolNames : toolNames.slice(-2).reverse(),
      activities,
    };
  }

  private extractRuntimeActivities(
    parts: Array<Record<string, unknown>>,
    message: OpenCodeNormalizedMessage,
  ): OpenCodeRuntimeActivity[] {
    const activities: OpenCodeRuntimeActivity[] = [];

    for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
      const part = parts[partIndex];
      if (!part) {
        continue;
      }
      const timestamp = message.timestamp;
      const toolNames = this.collectToolNameCandidates(part);
      if (toolNames[0]) {
        const toolCallDetail = this.extractToolCallDetail(part);
        activities.push({
          sourceMessageId: message.id,
          sourcePartIndex: partIndex,
          kind: "tool",
          label: toolNames[0],
          detail: toolCallDetail.detail,
          detailState: toolCallDetail.detailState,
          detailPayloadKeyCount: toolCallDetail.detailPayloadKeyCount,
          detailHasPlaceholderValue: toolCallDetail.detailHasPlaceholderValue,
          detailParseMode: toolCallDetail.detailParseMode,
          timestamp,
        });
        continue;
      }

      const reasoningDetails = this.collectReasoningDetails(part);
      if (reasoningDetails[0]) {
        activities.push({
          sourceMessageId: message.id,
          sourcePartIndex: partIndex,
          kind: "thinking",
          label: this.shortenText(reasoningDetails[0], 48),
          detail: reasoningDetails[0],
          detailState: "not_applicable",
          detailPayloadKeyCount: 0,
          detailHasPlaceholderValue: false,
          detailParseMode: "not_applicable",
          timestamp,
        });
        continue;
      }

      if (typeof part["type"] === "string" && part["type"] === "step-start" && typeof part["name"] === "string") {
        const stepName = part["name"].trim();
        if (stepName) {
          const detailCandidates = this.collectPartDetailCandidates(part);
          activities.push({
            sourceMessageId: message.id,
            sourcePartIndex: partIndex,
            kind: "step",
            label: stepName,
            detail: detailCandidates[0] || stepName,
            detailState: "not_applicable",
            detailPayloadKeyCount: 0,
            detailHasPlaceholderValue: false,
            detailParseMode: "not_applicable",
            timestamp,
          });
          continue;
        }
      }

      const detailCandidates = this.collectPartDetailCandidates(part);
      if (detailCandidates[0]) {
        activities.push({
          sourceMessageId: message.id,
          sourcePartIndex: partIndex,
          kind: "message",
          label: this.shortenText(detailCandidates[0], 48),
          detail: detailCandidates[0],
          detailState: "not_applicable",
          detailPayloadKeyCount: 0,
          detailHasPlaceholderValue: false,
          detailParseMode: "not_applicable",
          timestamp,
        });
      }
    }

    return activities;
  }

  private collectToolNameCandidates(part: Record<string, unknown>): string[] {
    const candidates: string[] = [];
    const type = typeof part["type"] === "string" ? part["type"].toLowerCase() : "";
    if (type.includes("tool")) {
      this.appendTrimmedString(candidates, part["toolName"]);
      this.appendTrimmedString(candidates, part["tool"]);
      this.appendTrimmedString(candidates, part["name"]);
    }
    if ("tool" in part && part["tool"] && typeof part["tool"] === "object" && !Array.isArray(part["tool"])) {
      const toolRecord = part["tool"] as Record<string, unknown>;
      this.appendTrimmedString(candidates, toolRecord["name"]);
      this.appendTrimmedString(candidates, toolRecord["id"]);
    }
    if ("call" in part && part["call"] && typeof part["call"] === "object" && !Array.isArray(part["call"])) {
      const callRecord = part["call"] as Record<string, unknown>;
      this.appendTrimmedString(candidates, callRecord["tool"]);
      this.appendTrimmedString(candidates, callRecord["name"]);
      this.appendTrimmedString(candidates, callRecord["id"]);
    }
    return candidates;
  }

  private collectPartDetailCandidates(part: Record<string, unknown>): string[] {
    const candidates: string[] = [];
    this.appendTrimmedString(candidates, part["summary"]);
    this.appendTrimmedString(candidates, part["text"]);
    this.appendTrimmedString(candidates, part["title"]);
    this.appendTrimmedString(candidates, part["description"]);
    this.appendStructuredDetailCandidates(candidates, part["input"]);
    this.appendStructuredDetailCandidates(candidates, part["args"]);
    this.appendStructuredDetailCandidates(candidates, part["arguments"]);
    this.appendStructuredDetailCandidates(candidates, part["payload"]);
    this.appendStructuredDetailCandidates(candidates, part["output"]);
    return candidates;
  }

  private collectReasoningDetails(part: Record<string, unknown>): string[] {
    const candidates: string[] = [];
    if (typeof part["type"] === "string" && part["type"].toLowerCase() === "reasoning") {
      this.appendTrimmedString(candidates, part["text"]);
    }
    this.appendTrimmedString(candidates, part["reasoning"]);
    return candidates;
  }

  private extractToolCallDetail(part: Record<string, unknown>): OpenCodeToolCallDetail {
    const structuredCandidates = [
      ...this.collectStructuredToolCallDetails(part["state"], TOOL_CALL_DETAIL_KEYS),
      ...this.collectStructuredToolCallDetails(part, TOOL_CALL_DETAIL_KEYS),
      ...TOOL_CALL_DETAIL_CONTAINERS.slice(1).flatMap((key) =>
        this.collectStructuredToolCallDetails(part[key], TOOL_CALL_DETAIL_KEYS)),
    ];
    if (structuredCandidates[0]) {
      return this.createStructuredToolCallDetail(structuredCandidates[0]);
    }

    const plainTextCandidates = [
      ...this.collectPlainTextToolCallDetails(part["state"], TOOL_CALL_DETAIL_KEYS),
      ...this.collectPlainTextToolCallDetails(part, TOOL_CALL_DETAIL_KEYS),
      ...TOOL_CALL_DETAIL_CONTAINERS.slice(1).flatMap((key) =>
        this.collectPlainTextToolCallDetails(part[key], TOOL_CALL_DETAIL_KEYS)),
    ];
    if (plainTextCandidates[0]) {
      return this.createPlainTextToolCallDetail(plainTextCandidates[0]);
    }

    return this.createMissingToolCallDetail();
  }

  private createStructuredToolCallDetail(input: { detail: string; payloadKeyCount: number }): OpenCodeToolCallDetail {
    return {
      detail: `参数: ${input.detail}`,
      detailState: "complete",
      detailPayloadKeyCount: input.payloadKeyCount,
      detailHasPlaceholderValue: false,
      detailParseMode: "structured",
    };
  }

  private createPlainTextToolCallDetail(detail: string): OpenCodeToolCallDetail {
    return {
      detail: `参数: ${detail}`,
      detailState: "complete",
      detailPayloadKeyCount: 0,
      detailHasPlaceholderValue: this.isPlaceholderToolCallDetail(detail),
      detailParseMode: "plain_text",
    };
  }

  private createMissingToolCallDetail(): OpenCodeToolCallDetail {
    return {
      detail: "参数暂未提供",
      detailState: "missing",
      detailPayloadKeyCount: 0,
      detailHasPlaceholderValue: false,
      detailParseMode: "missing",
    };
  }

  private collectStructuredToolCallDetails(
    value: unknown,
    keys: readonly string[],
  ): Array<{ detail: string; payloadKeyCount: number }> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return [];
    }

    const details: Array<{ detail: string; payloadKeyCount: number }> = [];
    for (const key of keys) {
      if (!(key in value)) {
        continue;
      }
      this.appendStructuredToolCallCandidates(details, (value as Record<string, unknown>)[key]);
    }
    return details;
  }

  private collectPlainTextToolCallDetails(
    value: unknown,
    keys: readonly string[],
  ): string[] {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return [];
    }

    const details: string[] = [];
    for (const key of keys) {
      if (!(key in value)) {
        continue;
      }
      this.appendPlainTextToolCallCandidates(details, (value as Record<string, unknown>)[key]);
    }
    return details;
  }

  private appendPlainTextToolCallCandidates(
    target: string[],
    value: unknown,
  ) {
    if (typeof value !== "string") {
      return;
    }
    const trimmed = value.trim();
    if (trimmed) {
      target.push(this.shortenText(trimmed, 160));
    }
  }

  private isPlaceholderToolCallDetail(detail: string): boolean {
    return detail.trim().toLowerCase() === "placeholder";
  }

  private appendStructuredToolCallCandidates(
    target: Array<{ detail: string; payloadKeyCount: number }>,
    value: unknown,
    depth = 0,
  ) {
    if ((!value && value !== 0 && value !== false) || depth > 4) {
      return;
    }

    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) {
        return;
      }
      if (
        (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
        (trimmed.startsWith("[") && trimmed.endsWith("]"))
      ) {
        try {
          this.appendStructuredToolCallCandidates(target, JSON.parse(trimmed) as unknown, depth + 1);
        } catch {
        }
        return;
      }
      if (depth > 0) {
        target.push({
          detail: this.shortenText(trimmed, 160),
          payloadKeyCount: 0,
        });
      }
      return;
    }

    if (typeof value === "number" || typeof value === "boolean") {
      target.push({
        detail: String(value),
        payloadKeyCount: 1,
      });
      return;
    }

    if (Array.isArray(value)) {
      const items: Array<{ detail: string; payloadKeyCount: number }> = [];
      for (const item of value) {
        this.appendStructuredToolCallCandidates(items, item, depth + 1);
        if (items.length >= 6) {
          break;
        }
      }
      if (items[0]) {
        target.push({
          detail: this.shortenText(`[${items.slice(0, 6).map((item) => item.detail).join(", ")}]`, 180),
          payloadKeyCount: items.reduce((count, item) => count + item.payloadKeyCount, 0),
        });
      }
      return;
    }

    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return;
    }
    const record = value as Record<string, unknown>;
    const preferredEntries = Object.entries(record).flatMap(([key, item]) => {
        if ((!item && item !== 0 && item !== false) || item === "") {
          return [];
        }
        if (["output", "result", "response", "summary", "reasoning"].includes(key)) {
          return [];
        }
        const summaries: Array<{ detail: string; payloadKeyCount: number }> = [];
        this.appendStructuredToolCallCandidates(summaries, item, depth + 1);
        return summaries[0]
          ? [{
            detail: `${key}=${summaries[0].detail}`,
            payloadKeyCount: summaries[0].payloadKeyCount + 1,
          }]
          : [];
      }).slice(0, 6);

    if (preferredEntries[0]) {
      target.push({
        detail: this.shortenText(preferredEntries.map((entry) => entry.detail).join(", "), 220),
        payloadKeyCount: preferredEntries.reduce((count, entry) => count + entry.payloadKeyCount, 0),
      });
      return;
    }

    for (const key of [
      "input",
      "args",
      "arguments",
      "payload",
      "options",
      "params",
      "data",
      "body",
    ]) {
      if (!(key in record)) {
        continue;
      }
      const nested: Array<{ detail: string; payloadKeyCount: number }> = [];
      this.appendStructuredToolCallCandidates(nested, record[key], depth + 1);
      if (nested[0]) {
        target.push(nested[0]);
        return;
      }
    }
  }

  private appendStructuredDetailCandidates(target: string[], value: unknown, depth = 0) {
    if ((!value && value !== 0 && value !== false) || depth > 3) {
      return;
    }

    if (typeof value === "string") {
      this.appendTrimmedString(target, this.shortenText(value.trim(), 120));
      return;
    }

    if (typeof value === "number" || typeof value === "boolean") {
      target.push(String(value));
      return;
    }

    if (Array.isArray(value)) {
      const items: string[] = [];
      for (const item of value) {
        this.appendStructuredDetailCandidates(items, item, depth + 1);
        if (items.length >= 4) {
          break;
        }
      }
      if (items[0]) {
        target.push(this.shortenText(`[${items.slice(0, 4).join(", ")}]`, 140));
      }
      return;
    }

    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return;
    }
    const record = value as Record<string, unknown>;
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
      target.push(this.shortenText(direct[0], 120));
      return;
    }

    for (const key of ["input", "args", "arguments", "payload", "options", "params", "data"]) {
      if (key in record) {
        const nested: string[] = [];
        this.appendStructuredDetailCandidates(nested, record[key], depth + 1);
        if (nested[0]) {
          target.push(nested[0]);
          return;
        }
      }
    }

    const entries = Object.entries(record)
      .filter(([, item]) => item !== "" && item !== false && item !== 0 && Boolean(item))
      .slice(0, 4)
      .map(([key, item]) => {
        const summaries: string[] = [];
        this.appendStructuredDetailCandidates(summaries, item, depth + 1);
        return summaries[0]
          ? `${key}=${summaries[0]}`
          : this.shortenText(`${key}=${String(item)}`, 40);
      })
      .filter(Boolean);

    if (entries[0]) {
      target.push(this.shortenText(entries.join(", "), 160));
    }
  }

  private appendTrimmedString(target: string[], value: unknown) {
    if (typeof value !== "string") {
      return;
    }
    const trimmed = value.trim();
    if (trimmed) {
      target.push(trimmed);
    }
  }

  private expectRecord(value: unknown, context: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${context} 必须是对象`);
    }
    return value as Record<string, unknown>;
  }

  private readRequiredTrimmedString(value: unknown, context: string): string {
    if (typeof value !== "string") {
      throw new Error(`${context} 必须是非空字符串`);
    }
    const trimmed = value.trim();
    if (!trimmed) {
      throw new Error(`${context} 必须是非空字符串`);
    }
    return trimmed;
  }

  private readEventError(value: unknown, context: string): string {
    const record = this.expectRecord(value, context);
    if ("message" in record) {
      return this.readRequiredTrimmedString(record["message"], `${context}.message`);
    }
    const data = this.expectRecord(record["data"], `${context}.data`);
    return this.readRequiredTrimmedString(data["message"], `${context}.data.message`);
  }

  private toIsoString(value: unknown, context: string): string {
    if (typeof value === "string") {
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
    }
    if (typeof value === "number") {
      return new Date(value).toISOString();
    }
    throw new Error(`${context} 缺少合法时间`);
  }

  private isIsoLikeValue(value: unknown): boolean {
    try {
      this.toIsoString(value, "OpenCode 时间字段");
      return true;
    } catch {
      return false;
    }
  }

  private readMessageTimestamp(info: Record<string, unknown>, context: string): string {
    const time = "time" in info
      ? this.expectRecord(info["time"], `${context}.time`)
      : {};
    if ("completed" in time) {
      return this.readRequiredTrimmedString(
        this.toIsoString(time["completed"], `${context}.time.completed`),
        `${context}.time.completed`,
      );
    }
    if ("completedAt" in info) {
      return this.readRequiredTrimmedString(
        this.toIsoString(info["completedAt"], `${context}.completedAt`),
        `${context}.completedAt`,
      );
    }
    if ("created" in time) {
      return this.readRequiredTrimmedString(
        this.toIsoString(time["created"], `${context}.time.created`),
        `${context}.time.created`,
      );
    }
    if ("createdAt" in info) {
      return this.readRequiredTrimmedString(
        this.toIsoString(info["createdAt"], `${context}.createdAt`),
        `${context}.createdAt`,
      );
    }
    throw new Error(`${context} 缺少合法时间`);
  }

  private static async waitForHealthy(baseUrl: string): Promise<boolean> {
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

  private static async waitForServeBaseUrl(
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

  private static parsePortFromBaseUrl(baseUrl: string): number {
    const parsed = new URL(baseUrl);
    const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error(`无效的 OpenCode attach 地址：${baseUrl}`);
    }
    return port;
  }

  private static truncateLogPayload(value: string, maxLength = 4000): string {
    if (value.length <= maxLength) {
      return value;
    }
    return `${value.slice(0, maxLength)}...(truncated)`;
  }

  private static normalizeProcessOutput(value: string | Buffer): string {
    return typeof value === "string" ? value : value.toString("utf8");
  }

  private extractVisibleMessageText(parts: Array<Record<string, unknown>>): string {
    const text = parts
      .map((part) => part["type"] === "text" && typeof part["text"] === "string"
        ? part["text"]
        : false)
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
