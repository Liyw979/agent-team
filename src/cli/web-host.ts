import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { URL } from "node:url";
import type {
  AgentProgressMessageRecord,
  TaskAgentRecord,
  TaskSnapshot,
  SubmitTaskPayload,
  UiSnapshotPayload,
} from "@shared/types";
import type { Orchestrator } from "../runtime/orchestrator";
import type { OpenCodeSessionActivity } from "../runtime/opencode-client";
import { buildTaskLogFilePath } from "../runtime/app-log";
import {
  UI_LOOPBACK_HOST,
  UI_LOOPBACK_IPV6_HOST,
  type UiLoopbackBindHost,
} from "./ui-host-launch";
import { buildUiUrl } from "./ui-host-launch";

interface StartWebHostOptions {
  orchestrator: Orchestrator;
  port: number;
  userDataPath: string;
  bindHosts: UiLoopbackBindHost[];
  staticAssets: StaticAssetsConfig;
}

type StaticAssetsConfig =
  | { kind: "api-only" }
  | { kind: "single-page-app"; webRoot: string };

function json(response: http.ServerResponse, statusCode: number, body: unknown) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function text(response: http.ServerResponse, statusCode: number, body: string, extraHeaders: Record<string, string> = {}) {
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders,
  });
  response.end(body);
}

async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function parseSubmitTaskPayload(body: unknown): SubmitTaskPayload {
  if (!isRecord(body) || !Object.hasOwn(body, "content")) {
    throw new Error("非法请求：content 必须是非空字符串");
  }
  const content = body["content"];
  if (typeof content !== "string" || content.trim() === "") {
    throw new Error("非法请求：content 必须是非空字符串");
  }
  if (!Object.hasOwn(body, "mentionAgentId")) {
    return {
      content,
    };
  }
  const mentionAgentId = body["mentionAgentId"];
  if (
    typeof mentionAgentId !== "string" || mentionAgentId.trim() === ""
  ) {
    throw new Error("非法请求：mentionAgentId 必须是非空字符串");
  }
  return {
    content,
    mentionAgentId,
  };
}

function parseOpenAgentTerminalPayload(body: unknown): string {
  if (!isRecord(body) || !Object.hasOwn(body, "agentId")) {
    throw new Error("非法请求：agentId 必须是非空字符串");
  }
  const agentId = body["agentId"];
  if (typeof agentId !== "string" || agentId.trim() === "") {
    throw new Error("非法请求：agentId 必须是非空字符串");
  }
  return agentId;
}

async function buildUiSnapshotPayload(
  orchestrator: Orchestrator,
  options: Pick<StartWebHostOptions, "port" | "userDataPath">,
): Promise<UiSnapshotPayload> {
  const workspace = await orchestrator.getWorkspaceSnapshot();
  if (workspace.tasks.length === 0) {
    return {
      kind: "workspace",
      workspace,
      launchCwd: workspace.cwd,
      taskUrl: buildUiUrl({
        port: options.port,
      }),
    };
  }

  const task = await withLiveProgressMessages(orchestrator, await orchestrator.getTaskSnapshot());
  return {
    kind: "task",
    workspace,
    task,
    launchCwd: workspace.cwd,
    taskLogFilePath: buildTaskLogFilePath(options.userDataPath, task.task.id),
    taskUrl: buildUiUrl({
      port: options.port,
    }),
  };
}

async function withLiveProgressMessages(
  orchestrator: Orchestrator,
  snapshot: TaskSnapshot,
): Promise<TaskSnapshot> {
  const liveMessages = await listLiveProgressMessages(orchestrator, snapshot);
  if (liveMessages.length === 0) {
    return snapshot;
  }
  return {
    ...snapshot,
    messages: [...snapshot.messages, ...liveMessages].sort((left, right) =>
      left.timestamp.localeCompare(right.timestamp)),
  };
}

async function listLiveProgressMessages(
  orchestrator: Orchestrator,
  snapshot: TaskSnapshot,
): Promise<AgentProgressMessageRecord[]> {
  const grouped = await Promise.all(
    snapshot.agents
      .filter((agent) => agent.status === "running")
      .map(async (agent) => {
        const activities = await orchestrator.opencodeClient.listSessionActivities(agent.opencodeSessionId);
        return activities.map((activity) =>
          createLiveProgressMessage(snapshot.task.id, agent, activity));
      }),
  );
  return grouped.flat();
}

function createLiveProgressMessage(
  taskId: string,
  agent: TaskAgentRecord,
  activity: OpenCodeSessionActivity,
): AgentProgressMessageRecord {
  return {
    id: `live:${agent.id}:${activity.sourceMessageId}:${activity.sourcePartIndex}`,
    taskId,
    content: activity.detail,
    sender: agent.id,
    timestamp: activity.timestamp,
    kind: "agent-progress",
    activityKind: activity.kind,
    label: activity.label,
    detail: activity.detail,
    detailState: "not_applicable",
    sessionId: agent.opencodeSessionId,
    runCount: agent.runCount,
  };
}

function getContentType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".ico":
      return "image/x-icon";
    default:
      return "application/octet-stream";
  }
}

function buildStaticFileHeaders(filePath: string): Record<string, string> {
  return {
    "content-type": getContentType(filePath),
    "cache-control": "no-store",
  };
}

function resolveStaticFilePath(webRoot: string, pathname: string): string {
  const sanitized = pathname === "/" ? "/index.html" : pathname;
  const nextPath = path.normalize(path.join(webRoot, sanitized));
  if (!nextPath.startsWith(path.normalize(webRoot))) {
    return path.join(webRoot, "index.html");
  }
  if (fs.existsSync(nextPath) && fs.statSync(nextPath).isFile()) {
    return nextPath;
  }
  return path.join(webRoot, "index.html");
}

export async function startWebHost(
  options: StartWebHostOptions,
): Promise<{ close: () => Promise<void> }> {
  const requestHandler = async (request: http.IncomingMessage, response: http.ServerResponse) => {
    if (!request.url) {
      text(response, 400, "missing url");
      return;
    }

    const requestHost = typeof request.headers.host === "string" ? request.headers.host : UI_LOOPBACK_HOST;
    const url = new URL(request.url, `http://${requestHost}`);
    try {
      if (request.method === "GET" && url.pathname === "/healthz") {
        json(response, 200, {
          ok: true,
          port: options.port,
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/ui-snapshot") {
        json(response, 200, await buildUiSnapshotPayload(options.orchestrator, options));
        return;
      }


      if (request.method === "POST" && url.pathname === "/api/tasks/submit") {
        const payload = parseSubmitTaskPayload(await readJsonBody(request));
        json(response, 200, await options.orchestrator.submitTask(payload));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/tasks/open-agent-terminal") {
        const payload = parseOpenAgentTerminalPayload(await readJsonBody(request));
        await options.orchestrator.openAgentTerminal(payload);
        json(response, 200, { ok: true });
        return;
      }

      if (request.method !== "GET") {
        text(response, 405, "method not allowed");
        return;
      }

      if (options.staticAssets.kind === "single-page-app") {
        const filePath = resolveStaticFilePath(options.staticAssets.webRoot, url.pathname);
        response.writeHead(200, buildStaticFileHeaders(filePath));
        fs.createReadStream(filePath).pipe(response);
        return;
      }

      text(response, 500, "web assets unavailable");
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("非法请求：")) {
        text(response, 400, error.message);
        return;
      }
      json(response, 500, {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const closeServer = async (server: http.Server) => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  };

  const closeBoundServers = async (servers: readonly http.Server[]) => {
    for (const server of servers) {
      await closeServer(server);
    }
  };

  const teardown = async (servers: readonly http.Server[]) => {
    await closeBoundServers(servers);
  };

  const boundServers: http.Server[] = [];
  for (const host of options.bindHosts) {
    const server = http.createServer(requestHandler);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        if (host === UI_LOOPBACK_IPV6_HOST) {
          server.listen({
            port: options.port,
            host,
            ipv6Only: true,
          }, () => resolve());
          return;
        }
        server.listen(options.port, host, () => resolve());
      });
      boundServers.push(server);
    } catch (error) {
      const listenError =
        error instanceof Error ? error : new Error(String(error));
      try {
        await teardown(boundServers);
      } catch (teardownError) {
        throw new AggregateError(
          [listenError, teardownError],
          "Web Host 监听失败，且回滚失败",
        );
      }
      throw listenError;
    }
  }

  if (boundServers.length === 0) {
    await teardown(boundServers);
    throw new Error("当前机器没有可用的 loopback 地址可用于启动 Web Host。");
  }

  return {
    close: async () => teardown(boundServers),
  };
}
