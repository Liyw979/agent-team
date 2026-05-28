// 用户要求：submit message 的每次重试前必须先调用 abort，避免旧 OpenCode session 运行状态导致再次提交卡死。
// 2026-05-26: 用户要求每次发送 OpenCode 请求都必须记录到当前 Task log 文件。
// 2026-05-26: 用户要求网络日志只写入文件，不输出到控制台。
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { parseDecision } from "./decision-parser";
import { toOpenCodeAgentId } from "./opencode-agent-id";
import { appendAppLog } from "./app-log";
import { extractOpenCodeServeBaseUrl } from "./opencode-serve-launch";
import {
  getOpenCodeRequestTimeoutMs,
  type ResolveOpenCodeRequestTimeoutInput,
} from "./opencode-request-timeout";
import { resolveWindowsCmdPath } from "./windows-shell";
import type { OpenCodeInjectedAgentConfig } from "./project-agent-source";
import { toUtcIsoTimestamp, type UtcIsoTimestamp } from "@shared/types";

export interface ServeHandle {
  commandName: string;
  process: ChildProcessWithoutNullStreams;
  port: number;
}

interface SubmitMessagePayload {
  content: string;
  agent: string;
  runtimeAgent: string;
  allowedDecisionTriggers: string[];
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
  finalMessage: string;
  messageId: string;
  timestamp: UtcIsoTimestamp;
  rawMessage: OpenCodeNormalizedMessage;
}

export interface OpenCodeSessionActivity {
  sourceMessageId: string;
  sourcePartIndex: number;
  kind: "tool" | "message" | "thinking" | "step";
  label: string;
  detail: string;
  timestamp: UtcIsoTimestamp;
}

const MAX_SESSION_ACTIVITY_MESSAGES = 100;
const SERVE_BASE_URL_TIMEOUT_MS = 10_000;
const RETRYABLE_CLIENT_INTERVAL_MS = 120_000;

type RequestOptions =
  | {
      method: "GET";
    }
  | {
      method: "POST";
      body: string;
    };

class RetryableExecutionResultError extends Error {}

export function buildOpenCodeServeSpawnSpec(
  cwd: string,
  commandName: string,
  serverEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  const launchArgs = ["serve"];
  if (platform === "win32") {
    return {
      command: resolveWindowsCmdPath(serverEnv),
      args: [
        "/d",
        "/s",
        "/c",
        `cd /d ${cwd} && ${commandName} ${launchArgs.join(" ")}`,
      ],
    };
  }
  return {
    command: commandName,
    args: launchArgs,
  };
}

export class OpenCodeClient {
  readonly host = "127.0.0.1";
  readonly commandName: string;
  private readonly runningServe: ServeHandle;

  constructor(input: { server: ServeHandle }) {
    this.runningServe = input.server;
    this.commandName = input.server.commandName;
  }

  async createSession(
    title: string,
  ): Promise<string> {
    const response = await this.request("/session", {
      method: "POST",
      body: JSON.stringify({ title }),
    }, "OpenCode 创建 session 失败");

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

  async submitMessage(
    sessionId: string,
    payload: SubmitMessagePayload,
  ): Promise<OpenCodeExecutionResult> {
    const opencodeAgent = toOpenCodeAgentId(payload.agent);
    const runtimeAgent = payload.runtimeAgent;
    const attempt = async (
      content: string,
      retryCount: number,
    ): Promise<OpenCodeExecutionResult> => {
      try {
        await this.abortSessionOnce(sessionId);
        const response = await this.requestOnce(`/session/${sessionId}/message`, {
          method: "POST",
          body: JSON.stringify({
            agent: opencodeAgent,
            parts: [
              {
                type: "text",
                text: content,
              },
            ],
          }),
        }, "OpenCode 请求失败").catch((error) => {
          throw new RetryableExecutionResultError(error instanceof Error ? error.message : String(error));
        });
        const message = await this.readJsonResponse(response)
          .then((raw) => this.parseMessageEnvelope(raw, opencodeAgent, "OpenCode 提交消息响应"))
          .catch(() => {
            throw new Error("OpenCode 提交消息响应缺少有效的消息实体");
          });
        const result = this.buildExecutionResult(sessionId, message);
        if (payload.allowedDecisionTriggers.length > 0) {
          const parsedDecision = parseDecision(
            result.finalMessage,
            payload.allowedDecisionTriggers,
          );
          if (parsedDecision.kind !== "valid") {
            throw new RetryableExecutionResultError("OpenCode 未返回需要的 trigger");
          }
        }
        return result;
      } catch (error) {
        if (!(error instanceof RetryableExecutionResultError)) {
          throw error;
        }
        const retryReason = error.message;
        const nextContent = "生成完整回复";
        this.logRetriedMessageResend(sessionId, opencodeAgent, runtimeAgent, retryReason, retryCount, nextContent);
        if (retryCount > 0) {
          await new Promise((resolve) => setTimeout(resolve, RETRYABLE_CLIENT_INTERVAL_MS));
        }
        return attempt(nextContent, retryCount + 1);
      }
    };

    return attempt(payload.content, 0);
  }
  async listSessionActivities(sessionId: string): Promise<OpenCodeSessionActivity[]> {
    const response = await this.request(`/session/${sessionId}/message?limit=${MAX_SESSION_ACTIVITY_MESSAGES}`, {
      method: "GET",
    }, "OpenCode 会话消息查询失败");
    const parsed = await this.readJsonResponse(response);
    if (!Array.isArray(parsed)) {
      throw new Error("OpenCode 会话消息响应必须是数组");
    }
    return this.buildSessionActivities(sessionId, parsed);
  }

  private async abortSessionOnce(sessionId: string): Promise<void> {
    await this.request(`/session/${sessionId}/abort`, {
      method: "POST",
      body: "",
    }, "OpenCode 中止 session 失败");
  }

  private buildExecutionResult(
    sessionId: string,
    message: OpenCodeNormalizedMessage,
  ): OpenCodeExecutionResult {
    const finalMessage = this.messageHasError(message.raw)
      ? this.readMessageError(message.raw, `OpenCode session ${sessionId} 最终消息`)
      : message.content;
    if (!finalMessage.trim()) {
      throw new RetryableExecutionResultError("OpenCode 返回了空的 assistant 结果");
    }
    if (this.messageHasError(message.raw)) {
      throw new RetryableExecutionResultError("OpenCode 最终消息包含错误");
    }

    return {
      finalMessage,
      messageId: message.id,
      timestamp: message.timestamp,
      rawMessage: message,
    };
  }

  private logRetriedMessageResend(
    sessionId: string,
    agent: string,
    runtimeAgent: string,
    reason: string,
    retryCount: number,
    nextContent: string,
    ) {
    const message = `Agent ${runtimeAgent}: ${reason}异常，将重新发送消息`;
    appendAppLog("warn", "opencode.submit_message_retried", {
      sessionId,
      agent,
      runtimeAgent,
      retryCount,
      nextRetryCount: retryCount + 1,
      nextContent,
      reason,
      message,
    });
  }

  async shutdown(): Promise<number[]> {
    let killedPids: number[] = [];
    try {
      killedPids = await this.terminateServeHandle();
    } catch {
      // ignore shutdown errors
    } finally {
      this.clearSessionState();
    }
    return killedPids;
  }

  private clearSessionState() {
  }

  private async terminateServeHandle(): Promise<number[]> {
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

    return [...new Set(killedPids)];
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

  static async startServer(
    cwd: string,
    agent: Record<string, OpenCodeInjectedAgentConfig>,
    commandName: string,
  ): Promise<ServeHandle> {
    // 2026-05-28: 用户要求 CLI 支持通过 --cmd 替换默认命令名，serve 启动与进程回收必须沿用同一个命令名。
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
    if (Object.keys(agent).length > 0) {
      serverEnv["OPENCODE_CONFIG_CONTENT"] = JSON.stringify({ agent });
    }
    const spawnSpec = buildOpenCodeServeSpawnSpec(cwd, commandName, serverEnv);
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

    return {
      commandName,
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
        return output.toLowerCase().includes(this.commandName.toLowerCase());
      }

      const command = execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      return command.includes(this.commandName) && command.includes("serve");
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

  protected async request(
    pathname: string,
    options: RequestOptions,
    errorPrefix = "OpenCode 请求失败",
  ): Promise<Response> {
    try {
      return await this.requestOnce(pathname, options, errorPrefix);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, RETRYABLE_CLIENT_INTERVAL_MS));
      return this.request(pathname, options, errorPrefix);
    }
  }

  private async requestOnce(
    pathname: string,
    options: RequestOptions,
    errorPrefix = "OpenCode 请求失败",
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (options.method === "POST" && options.body.length > 0) {
      headers["content-type"] = "application/json";
    }

    const url = `${this.buildBaseUrl(this.runningServe.port)}${pathname}`;
    const requestInit: RequestInit = {
      method: options.method,
      headers,
    };
    if (options.method === "POST" && options.body.length > 0) {
      requestInit.body = options.body;
    }
    appendAppLog("info", "opencode.request_sent", {
      method: options.method,
      url,
    }, "file-only");
    const response = await this.fetchWithTimeout(url, requestInit, {
        pathname,
        method: options.method,
      }).catch(async (error) => {
      appendAppLog("error", "opencode.request_failed", {
        method: options.method,
        url,
        message: error instanceof Error ? error.message : String(error),
      }, "file-only");
      throw error;
    });
    if (response.ok) {
      return response;
    }
    const message = `${errorPrefix}: ${response.status}`;
    appendAppLog("error", "opencode.request_failed", {
      status: response.status,
      statusText: response.statusText,
      message,
    }, "file-only");
    throw new Error(message);
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutInput: ResolveOpenCodeRequestTimeoutInput,
  ): Promise<Response> {
    const timeoutMs = getOpenCodeRequestTimeoutMs(timeoutInput);
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

  private buildSessionActivities(sessionId: string, messages: unknown[]): OpenCodeSessionActivity[] {
    const seen = new Set<string>();
    return messages.flatMap((raw) => {
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
        return [];
      }

      const activities = this.extractSessionActivities(parts, normalized);
      const resolved = activities.length === 0 && normalized.content.trim()
        ? [{
            sourceMessageId: normalized.id,
            sourcePartIndex: 0,
            kind: "message" as const,
            label: this.shortenText(normalized.content, 48),
            detail: normalized.content.trim(),
            timestamp: normalized.timestamp,
          }]
        : activities;

      return resolved.filter((activity) => {
        const signature = `${activity.kind}:${activity.label}:${activity.detail}:${activity.timestamp}`;
        if (seen.has(signature)) {
          return false;
        }
        seen.add(signature);
        return true;
      });
    });
  }

  private extractSessionActivities(
    parts: Array<Record<string, unknown>>,
    message: OpenCodeNormalizedMessage,
  ): OpenCodeSessionActivity[] {
    return parts.flatMap((part, partIndex): OpenCodeSessionActivity[] => {
      const timestamp = message.timestamp;
      const toolName = this.collectToolNameCandidates(part)[0];
      if (toolName) {
        const detail = this.resolveToolActivityDetail(part, toolName);
        return [{
          sourceMessageId: message.id,
          sourcePartIndex: partIndex,
          kind: "tool" as const,
          label: toolName,
          detail,
          timestamp,
        } satisfies OpenCodeSessionActivity];
      }

      const reasoningDetail = this.collectReasoningDetails(part)[0];
      if (reasoningDetail) {
        return [{
          sourceMessageId: message.id,
          sourcePartIndex: partIndex,
          kind: "thinking" as const,
          label: this.shortenText(reasoningDetail, 48),
          detail: reasoningDetail,
          timestamp,
        } satisfies OpenCodeSessionActivity];
      }

      if (typeof part["type"] === "string" && part["type"] === "step-start" && typeof part["name"] === "string") {
        const stepName = part["name"].trim();
        if (stepName) {
          const detail = this.collectPartDetailCandidates(part)[0] || stepName;
          return [{
            sourceMessageId: message.id,
            sourcePartIndex: partIndex,
            kind: "step" as const,
            label: stepName,
            detail,
            timestamp,
          } satisfies OpenCodeSessionActivity];
        }
      }

      const detail = this.collectPartDetailCandidates(part)[0];
      if (detail) {
        return [{
          sourceMessageId: message.id,
          sourcePartIndex: partIndex,
          kind: "message" as const,
          label: this.shortenText(detail, 48),
          detail,
          timestamp,
        } satisfies OpenCodeSessionActivity];
      }

      return [];
    });
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

  private resolveToolActivityDetail(part: Record<string, unknown>, toolName: string): string {
    const input = this.readToolActivityInput(part["state"]) || this.readToolActivityInput(part);
    return input ? `参数: ${input}` : toolName;
  }

  private readToolActivityInput(value: unknown): string {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return "";
    }
    const record = value as Record<string, unknown>;
    for (const key of ["input", "args", "arguments"]) {
      const detail = this.summarizeToolActivityValue(record[key]);
      if (detail) {
        return detail;
      }
    }
    return "";
  }

  // 需求记录：工具参数展示直接输出 JSON 字符串并移除换行，禁止再做摘要拼接或出现 [object Object]。
  private summarizeToolActivityValue(value: unknown): string {
    const serializedValue = JSON.stringify(value);
    if (typeof serializedValue !== "string" || serializedValue === "{}" || serializedValue === "[]" || serializedValue === "\"\"") {
      return "";
    }
    return serializedValue.replace(/\s*\n\s*/gu, " ");
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
