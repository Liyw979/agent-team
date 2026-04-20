import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { URL } from "node:url";
import type {
  AgentFlowEvent,
  GetTaskRuntimePayload,
  OpenAgentTerminalPayload,
  SubmitTaskPayload,
  UiBootstrapPayload,
} from "@shared/types";
import type { Orchestrator } from "../runtime/orchestrator";

interface StartWebHostOptions {
  orchestrator: Orchestrator;
  cwd: string;
  taskId: string;
  port: number;
  webRoot: string;
}

function json(response: http.ServerResponse, statusCode: number, body: unknown) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function text(response: http.ServerResponse, statusCode: number, body: string, extraHeaders?: Record<string, string>) {
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
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function buildUiBootstrapPayload(
  orchestrator: Orchestrator,
  cwd: string,
  taskId: string,
): Promise<UiBootstrapPayload> {
  const workspace = await orchestrator.getWorkspaceSnapshot(cwd);
  const task = workspace.tasks.find((item) => item.task.id === taskId) ?? null;
  return {
    workspace,
    task,
    launchTaskId: taskId,
    launchCwd: workspace.cwd,
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
  const subscriptions = new Set<http.ServerResponse>();
  const unsubscribe = options.orchestrator.subscribe((event: AgentFlowEvent) => {
    if (event.cwd !== options.cwd) {
      return;
    }

    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const response of subscriptions) {
      response.write(payload);
    }
  });

  const server = http.createServer(async (request, response) => {
    if (!request.url) {
      text(response, 400, "missing url");
      return;
    }

    const url = new URL(request.url, `http://${request.headers.host ?? "127.0.0.1"}`);
    try {
      if (request.method === "GET" && url.pathname === "/healthz") {
        json(response, 200, {
          ok: true,
          cwd: options.cwd,
          taskId: options.taskId,
          port: options.port,
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/bootstrap") {
        const cwd = url.searchParams.get("cwd") ?? options.cwd;
        const taskId = url.searchParams.get("taskId") ?? options.taskId;
        json(response, 200, await buildUiBootstrapPayload(options.orchestrator, cwd, taskId));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/tasks/runtime") {
        const payload: GetTaskRuntimePayload = {
          cwd: url.searchParams.get("cwd") ?? options.cwd,
          taskId: url.searchParams.get("taskId") ?? options.taskId,
        };
        json(response, 200, await options.orchestrator.getTaskRuntime(payload));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/tasks/submit") {
        const payload = await readJsonBody(request) as SubmitTaskPayload;
        json(response, 200, await options.orchestrator.submitTask(payload));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/tasks/open-agent-terminal") {
        const payload = await readJsonBody(request) as OpenAgentTerminalPayload;
        await options.orchestrator.openAgentTerminal(payload);
        json(response, 200, { ok: true });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/events") {
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          connection: "keep-alive",
        });
        response.write(`data: ${JSON.stringify({ type: "connected", cwd: options.cwd })}\n\n`);
        subscriptions.add(response);
        request.on("close", () => {
          subscriptions.delete(response);
          response.end();
        });
        return;
      }

      if (request.method !== "GET") {
        text(response, 405, "method not allowed");
        return;
      }

      const filePath = resolveStaticFilePath(options.webRoot, url.pathname);
      response.writeHead(200, {
        "content-type": getContentType(filePath),
      });
      fs.createReadStream(filePath).pipe(response);
    } catch (error) {
      json(response, 500, {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => resolve());
  });

  return {
    close: async () => {
      unsubscribe();
      for (const response of subscriptions) {
        response.end();
      }
      subscriptions.clear();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}
