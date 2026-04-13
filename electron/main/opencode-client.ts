import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

interface ServeHandle {
  process: ChildProcessWithoutNullStreams;
  port: number;
  mock: boolean;
}

interface OpenCodeEvent {
  directory?: string;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SubmitMessagePayload {
  content: string;
  agent: string;
  system: string;
  tools: string[];
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
  fallbackMessage: string | null;
  messageId: string;
  timestamp: string;
  rawMessage: OpenCodeNormalizedMessage;
}

export interface OpenCodeRuntimeActivity {
  id: string;
  kind: "tool" | "message" | "step";
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
const MAX_RUNTIME_ACTIVITIES = 24;

interface SessionWaiter {
  sessionId: string;
  after: number;
  resolve: () => void;
  reject: (error: Error) => void;
}

export class OpenCodeClient {
  private serverHandle: Promise<ServeHandle> | null = null;
  private eventPump: Promise<void> | null = null;
  private readonly port = 4096;
  private readonly runtimeDir: string;
  private readonly sessionIdleAt = new Map<string, number>();
  private readonly sessionErrors = new Map<string, string>();
  private readonly sessionWaiters = new Map<string, SessionWaiter[]>();

  constructor(runtimeRoot?: string) {
    const baseDir = runtimeRoot ? path.resolve(runtimeRoot) : path.join(process.cwd(), ".agentflow");
    this.runtimeDir = path.join(baseDir, "opencode-runtime", "server");
    fs.mkdirSync(this.runtimeDir, { recursive: true });
  }

  async ensureServer(): Promise<ServeHandle> {
    if (this.serverHandle) {
      return this.serverHandle;
    }

    this.serverHandle = this.startServer();
    return this.serverHandle;
  }

  async createSession(projectPath: string, title: string): Promise<string> {
    const server = await this.ensureServer();
    if (server.mock) {
      return `session-${randomUUID()}`;
    }

    try {
      const response = await this.request("/session", {
        method: "POST",
        projectPath,
        body: JSON.stringify({ title }),
      });

      if (!response.ok) {
        server.mock = true;
        return `session-${randomUUID()}`;
      }

      const data = (await response.json()) as { id?: string };
      return data.id ?? `session-${randomUUID()}`;
    } catch {
      server.mock = true;
      return `session-${randomUUID()}`;
    }
  }

  async reloadConfig(projectPath: string): Promise<void> {
    const server = await this.ensureServer();
    if (server.mock) {
      return;
    }

    const attempts: Array<() => Promise<Response>> = [
      () =>
        this.request("/project/reload", {
          method: "POST",
          projectPath,
        }),
      async () => {
        const current = await this.request("/global/config", {
          method: "GET",
          projectPath,
        });
        if (!current.ok) {
          throw new Error(`读取 global/config 失败: ${current.status}`);
        }
        const config = await current.text();
        return this.request("/global/config", {
          method: "PATCH",
          projectPath,
          body: config,
        });
      },
    ];

    for (const attempt of attempts) {
      try {
        const response = await attempt();
        if (response.ok) {
          return;
        }
      } catch {
        continue;
      }
    }
  }

  async connectEvents(onEvent: (event: OpenCodeEvent) => void): Promise<void> {
    const server = await this.ensureServer();
    if (server.mock || this.eventPump) {
      return;
    }

    this.eventPump = this.startEventPump(onEvent, server);
    await this.eventPump;
  }

  async submitMessage(
    projectPath: string,
    sessionId: string,
    payload: SubmitMessagePayload,
  ): Promise<OpenCodeNormalizedMessage> {
    const server = await this.ensureServer();

    if (server.mock) {
      return this.createMockMessage(projectPath, sessionId, payload);
    }

    const body: Record<string, unknown> = {
      agent: payload.agent,
      system: payload.system,
      parts: [
        {
          type: "text",
          text: payload.content,
        },
      ],
    };

    if (payload.tools.length > 0) {
      body.tools = Object.fromEntries(payload.tools.map((tool) => [tool, true]));
    }

    const response = await this.request(`/session/${sessionId}/message`, {
      method: "POST",
      projectPath,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`OpenCode 请求失败: ${response.status}`);
    }

    const raw = await response.text();
    return this.normalizeMessageEnvelope(JSON.parse(raw) as Record<string, unknown>, payload.agent);
  }

  async resolveExecutionResult(
    projectPath: string,
    sessionId: string,
    submitted: OpenCodeNormalizedMessage,
  ): Promise<OpenCodeExecutionResult> {
    const server = await this.ensureServer();
    if (server.mock) {
      return {
        status: submitted.error ? "error" : "completed",
        finalMessage: submitted.content,
        fallbackMessage: submitted.content.trim() || null,
        messageId: submitted.id,
        timestamp: submitted.completedAt ?? submitted.timestamp,
        rawMessage: submitted,
      };
    }

    const submittedAt = Date.parse(submitted.timestamp) || Date.now();
    try {
      await this.waitForSessionSettled(sessionId, submittedAt, 8000);
    } catch {
      // 事件流超时或缺失时退回消息轮询
    }

    const latest =
      (await this.waitForMessageCompletion(projectPath, sessionId, submitted.id, submitted.timestamp, 8000)) ??
      (await this.getLatestAssistantMessage(projectPath, sessionId)) ??
      submitted;

    const runtime = await this.getSessionRuntime(projectPath, sessionId).catch(() => null);

    return {
      status: latest.error ? "error" : "completed",
      finalMessage: latest.content || latest.error || "",
      fallbackMessage: this.pickFallbackMessage(latest.content || latest.error || "", runtime?.activities ?? []),
      messageId: latest.id,
      timestamp: latest.completedAt ?? latest.timestamp,
      rawMessage: latest,
    };
  }

  async getSessionRuntime(
    projectPath: string,
    sessionId: string,
  ): Promise<OpenCodeSessionRuntime> {
    const server = await this.ensureServer();
    if (server.mock) {
      return {
        sessionId,
        messageCount: 0,
        updatedAt: null,
        headline: null,
        activeToolNames: [],
        activities: [],
      };
    }

    const list = await this.listSessionMessages(projectPath, sessionId, MAX_RUNTIME_MESSAGES);
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

  async shutdown(): Promise<void> {
    if (!this.serverHandle) {
      return;
    }

    try {
      const server = await this.serverHandle;
      if (!server.mock && server.process && !server.process.killed) {
        server.process.kill();
      }
    } catch {
      // ignore shutdown errors
    } finally {
      this.serverHandle = null;
      this.eventPump = null;
      this.sessionIdleAt.clear();
      this.sessionErrors.clear();
      this.sessionWaiters.clear();
    }
  }

  private async startServer(): Promise<ServeHandle> {
    const serverEnv = {
      ...process.env,
      OPENCODE_CONFIG_DIR: this.runtimeDir,
      OPENCODE_DB: path.join(this.runtimeDir, "opencode-server.db"),
      OPENCODE_CLIENT: "agentflow-orchestrator",
    };
    const childProcess = spawn(
      "opencode",
      ["serve", "--port", String(this.port), "--hostname", "127.0.0.1"],
      {
        cwd: globalThis.process.cwd(),
        env: serverEnv,
        stdio: "pipe",
      },
    );

    let mock = false;
    childProcess.on("error", () => {
      mock = true;
    });

    childProcess.stderr.on("data", () => undefined);
    childProcess.stdout.on("data", () => undefined);

    const healthy = await this.waitForHealthy(this.port);
    if (!healthy) {
      mock = true;
    }

    return {
      process: childProcess,
      port: this.port,
      mock,
    };
  }

  private async startEventPump(
    onEvent: (event: OpenCodeEvent) => void,
    server: ServeHandle,
  ): Promise<void> {
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/global/event`);
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
      this.eventPump = null;
    }
  }

  private handleEvent(event: OpenCodeEvent) {
    const eventType = typeof event.type === "string" ? event.type : "";
    const properties = this.asRecord(event.properties);

    if (eventType === "session.idle") {
      const sessionId = typeof properties.sessionID === "string" ? properties.sessionID : null;
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
      const sessionId = typeof properties.sessionID === "string" ? properties.sessionID : null;
      if (!sessionId) {
        return;
      }
      const error = this.extractEventError(properties.error) ?? "OpenCode session 发生未知错误";
      this.sessionErrors.set(sessionId, error);
      const waiters = this.sessionWaiters.get(sessionId) ?? [];
      this.sessionWaiters.delete(sessionId);
      for (const waiter of waiters) {
        waiter.reject(new Error(error));
      }
    }
  }

  private async request(
    pathname: string,
    options: {
      method: "GET" | "POST" | "PATCH";
      projectPath?: string;
      body?: string;
    },
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (options.body) {
      headers["content-type"] = "application/json";
    }
    if (options.projectPath) {
      headers["x-opencode-directory"] = options.projectPath;
    }

    return fetch(`http://127.0.0.1:${this.port}${pathname}`, {
      method: options.method,
      headers,
      body: options.body,
    });
  }

  private async waitForSessionSettled(sessionId: string, after: number, timeoutMs: number): Promise<void> {
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

  private async waitForMessageCompletion(
    projectPath: string,
    sessionId: string,
    messageId: string,
    fallbackTimestamp: string,
    timeoutMs: number,
  ): Promise<OpenCodeNormalizedMessage | null> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const message = await this.getSessionMessage(projectPath, sessionId, messageId);
      if (message && (message.completedAt || message.error || message.content.trim())) {
        return message;
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }

    return this.getSessionMessage(projectPath, sessionId, messageId).then(
      (message) =>
        message ?? {
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

  private async getLatestAssistantMessage(
    projectPath: string,
    sessionId: string,
  ): Promise<OpenCodeNormalizedMessage | null> {
    const list = await this.listSessionMessages(projectPath, sessionId);
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const message = this.normalizeMessageEnvelope(list[index], "assistant");
      if (message.sender === "assistant" || message.sender === "system" || message.sender === "unknown") {
        return message;
      }
    }
    return null;
  }

  private async getSessionMessage(
    projectPath: string,
    sessionId: string,
    messageId: string,
  ): Promise<OpenCodeNormalizedMessage | null> {
    const response = await this.request(`/session/${sessionId}/message/${messageId}`, {
      method: "GET",
      projectPath,
    });
    if (!response.ok) {
      return null;
    }
    return this.normalizeMessageEnvelope((await response.json()) as Record<string, unknown>, "assistant");
  }

  private async listSessionMessages(
    projectPath: string,
    sessionId: string,
    limit?: number,
  ): Promise<unknown[]> {
    const pathname = limit
      ? `/session/${sessionId}/message?limit=${limit}`
      : `/session/${sessionId}/message`;
    const response = await this.request(pathname, {
      method: "GET",
      projectPath,
    });
    if (!response.ok) {
      return [];
    }

    const raw = (await response.json()) as unknown;
    return Array.isArray(raw) ? raw : [];
  }

  private createMockMessage(
    projectPath: string,
    _sessionId: string,
    payload: SubmitMessagePayload,
  ): OpenCodeNormalizedMessage {
    const body = this.buildMockReply(payload.agent, payload.content);
    return {
      id: randomUUID(),
      content: body,
      sender: payload.agent,
      timestamp: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      error: null,
      raw: {
        projectPath,
      },
    };
  }

  private normalizeMessageEnvelope(
    raw: unknown,
    fallbackSender: string,
  ): OpenCodeNormalizedMessage {
    const envelope = this.asRecord(raw);
    const info = this.asRecord(envelope.info ?? raw);
    const parts = Array.isArray(envelope.parts) ? (envelope.parts as Array<Record<string, unknown>>) : [];
    const time = this.asRecord(info.time);
    const created =
      this.toIsoString(time.created) ??
      this.toIsoString(info.createdAt) ??
      new Date().toISOString();
    const completed =
      this.toIsoString(time.completed) ??
      this.toIsoString(info.completedAt) ??
      null;
    const sender =
      typeof info.role === "string"
        ? info.role
        : typeof envelope.sender === "string"
          ? envelope.sender
          : fallbackSender;
    const content =
      parts.length > 0
        ? this.partsToText(parts)
        : typeof envelope.content === "string"
          ? envelope.content
          : typeof envelope.text === "string"
            ? envelope.text
            : "";

    return {
      id:
        (typeof info.id === "string" ? info.id : null) ??
        (typeof envelope.id === "string" ? envelope.id : null) ??
        randomUUID(),
      content,
      sender,
      timestamp: created,
      completedAt: completed,
      error: this.extractEventError(info.error ?? envelope.error),
      raw,
    };
  }

  private buildRuntimeSnapshot(sessionId: string, messages: unknown[]): OpenCodeSessionRuntime {
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
      const parts = Array.isArray(record.parts) ? (record.parts as Array<Record<string, unknown>>) : [];
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

    const recentActivities = activities.slice(-MAX_RUNTIME_ACTIVITIES);
    const latestActivity = recentActivities.at(-1) ?? null;
    const recentToolNames = recentActivities
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
      activities: recentActivities,
    };
  }

  private extractRuntimeActivities(
    parts: Array<Record<string, unknown>>,
    message: OpenCodeNormalizedMessage,
    messageIndex: number,
  ): OpenCodeRuntimeActivity[] {
    const activities: OpenCodeRuntimeActivity[] = [];

    for (let partIndex = parts.length - 1; partIndex >= 0 && activities.length < 4; partIndex -= 1) {
      const activity = this.partToRuntimeActivity(parts[partIndex], message, messageIndex, partIndex);
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
    const type = typeof part.type === "string" ? part.type : "";
    const timestamp = message.completedAt ?? message.timestamp;
    const toolName = this.extractToolName(part);
    const detail = this.extractPartDetail(part);

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

    if (type === "step-start" && typeof part.name === "string" && part.name.trim()) {
      return {
        id: `${message.id}:${messageIndex}:${partIndex}:step`,
        kind: "step",
        label: part.name.trim(),
        detail: detail || `执行步骤：${part.name.trim()}`,
        timestamp,
      };
    }

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

  private pickFallbackMessage(finalMessage: string, activities: OpenCodeRuntimeActivity[]): string | null {
    const normalizedFinal = finalMessage.trim();
    if (normalizedFinal && !/^【DECISION】/u.test(normalizedFinal)) {
      return normalizedFinal;
    }

    for (const activity of activities) {
      if (activity.kind === "tool") {
        continue;
      }
      const detail = activity.detail.trim();
      if (!detail) {
        continue;
      }
      if (/^【DECISION】/u.test(detail)) {
        continue;
      }
      return detail;
    }

    return null;
  }

  private extractToolName(part: Record<string, unknown>): string | null {
    const type = typeof part.type === "string" ? part.type.toLowerCase() : "";
    const directTool =
      (typeof part.toolName === "string" && part.toolName.trim()) ||
      (typeof part.tool === "string" && part.tool.trim()) ||
      (typeof part.name === "string" && part.name.trim()) ||
      null;

    if (directTool && (type.includes("tool") || type === "step-start")) {
      return directTool;
    }

    const toolRecord = this.asRecord(part.tool);
    if (typeof toolRecord.name === "string" && toolRecord.name.trim()) {
      return toolRecord.name.trim();
    }

    const callRecord = this.asRecord(part.call);
    if (typeof callRecord.tool === "string" && callRecord.tool.trim()) {
      return callRecord.tool.trim();
    }
    if (typeof callRecord.name === "string" && callRecord.name.trim()) {
      return callRecord.name.trim();
    }

    return null;
  }

  private extractPartDetail(part: Record<string, unknown>): string {
    const textCandidates = [
      typeof part.summary === "string" ? part.summary : "",
      typeof part.text === "string" ? part.text : "",
      typeof part.title === "string" ? part.title : "",
      typeof part.description === "string" ? part.description : "",
      typeof part.reasoning === "string" ? part.reasoning : "",
      this.extractStructuredDetail(part.input),
      this.extractStructuredDetail(part.args),
      this.extractStructuredDetail(part.arguments),
      this.extractStructuredDetail(part.payload),
      this.extractStructuredDetail(part.output),
    ]
      .map((value) => value.trim())
      .filter(Boolean);

    return textCandidates[0] ?? "";
  }

  private extractToolCallDetail(part: Record<string, unknown>): string {
    const callRecord = this.asRecord(part.call);
    const toolRecord = this.asRecord(part.tool);
    const metadataRecord = this.asRecord(part.metadata);
    const stateRecord = this.asRecord(part.state);
    const argsValue =
      part.input ??
      part.args ??
      part.arguments ??
      part.payload ??
      part.options ??
      part.params ??
      part.data ??
      part.body ??
      callRecord.input ??
      callRecord.args ??
      callRecord.arguments ??
      callRecord.payload ??
      callRecord.options ??
      callRecord.params ??
      callRecord.data ??
      callRecord.body ??
      toolRecord.input ??
      toolRecord.args ??
      toolRecord.arguments ??
      toolRecord.payload ??
      toolRecord.options ??
      toolRecord.params ??
      toolRecord.data ??
      toolRecord.body ??
      metadataRecord.input ??
      metadataRecord.args ??
      metadataRecord.arguments ??
      metadataRecord.payload ??
      metadataRecord.options ??
      metadataRecord.params ??
      metadataRecord.data ??
      metadataRecord.body ??
      stateRecord.input ??
      stateRecord.args ??
      stateRecord.arguments ??
      stateRecord.payload ??
      stateRecord.options ??
      stateRecord.params ??
      stateRecord.data ??
      stateRecord.body;
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
      typeof record.command === "string" ? record.command : "",
      typeof record.cmd === "string" ? record.cmd : "",
      typeof record.path === "string" ? record.path : "",
      typeof record.file === "string" ? record.file : "",
      typeof record.pattern === "string" ? record.pattern : "",
      typeof record.query === "string" ? record.query : "",
      typeof record.message === "string" ? record.message : "",
      typeof record.text === "string" ? record.text : "",
      typeof record.url === "string" ? record.url : "",
      typeof record.location === "string" ? record.location : "",
      typeof record.agent === "string" ? record.agent : "",
      typeof record.name === "string" ? record.name : "",
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
    if (typeof record.message === "string") {
      return record.message;
    }
    const data = this.asRecord(record.data);
    if (typeof data.message === "string") {
      return data.message;
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

  private buildMockReply(agent: string, content: string): string {
    const cleaned = content
      .replace(/\bSESSION_REF:\s*.+$/gim, "")
      .replace(/在你完成本轮所有工作后[\s\S]*$/m, "")
      .trim();
    const revisionFeedback =
      "【DECISION】需要修改\n具体修改意见：请补齐缺失实现、补充验证步骤，并确保最终回复只保留对用户有意义的高层结果。";
    const passed = "【DECISION】检查通过";

    const withDecision = (body: string, decision: string = passed) => `${body}\n${decision}`;

    if (/需要修改|返工|rework|revise/i.test(cleaned)) {
      return withDecision(
        "我已重新检查当前上下文，确认这一轮需要继续返工后再继续推进。",
        revisionFeedback,
      );
    }

    switch (agent) {
      case "BA":
        if (/验收|review|审查|复核/i.test(cleaned)) {
          return withDecision("我已经完成业务验收与体验复核，当前交付满足主流程要求。");
        }
        return withDecision("我已整理当前 Task 的目标、范围与交付标准，并给出可执行的实现方案。");
      case "Code":
      case "build":
        return withDecision(
          "我已完成主要实现与本地自检，当前代码、验证步骤和交付说明已经整理完成。",
        );
      case "UnitTest":
        return withDecision("单元测试覆盖与结构检查完成，未发现阻塞问题。");
      case "IntegrationTest":
        return withDecision("集成测试链路检查完成，关键流程可以继续进入业务复核。");
      case "CodeReview":
        return withDecision("代码审查完成，当前实现没有发现需要阻塞交付的缺陷。");
      case "DocsReview":
        return withDecision("文档审查完成，README.md 与 AGENTS.md 的同步情况已经核对。");
      default:
        return withDecision("当前阶段处理完成。");
    }
  }

  private async waitForHealthy(port: number): Promise<boolean> {
    for (let attempt = 0; attempt < 15; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/global/health`);
        if (response.ok) {
          return true;
        }
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }

    return false;
  }

  private partsToText(parts: Array<Record<string, unknown>>): string {
    const text = parts
      .map((part) => {
        if (typeof part.text === "string") {
          return part.text;
        }
        if (typeof part.summary === "string") {
          return part.summary;
        }
        if (typeof part.title === "string") {
          return part.title;
        }
        if (part.type === "step-start" && typeof part.name === "string") {
          return `执行步骤: ${part.name}`;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");

    return text || "[OpenCode 返回了非文本 parts，请查看原始消息结构]";
  }

  private shortenText(value: string, limit: number): string {
    const trimmed = value.replace(/\s+/g, " ").trim();
    if (trimmed.length <= limit) {
      return trimmed;
    }
    return `${trimmed.slice(0, limit - 1)}…`;
  }
}
