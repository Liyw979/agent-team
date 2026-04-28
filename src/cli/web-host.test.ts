import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import type { SubmitTaskPayload } from "@shared/types";

import { startWebHost } from "./web-host";

async function reservePort() {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("无法分配测试端口"));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

test("startWebHost 会按 JSON5 解析 /api/tasks/submit 请求体", async () => {
  const port = await reservePort();
  let capturedPayload: SubmitTaskPayload | null = null;
  const host = await startWebHost({
    orchestrator: {
      subscribe: () => () => undefined,
      submitTask: async (payload: SubmitTaskPayload) => {
        capturedPayload = payload;
        return {
          task: {
            id: "task-123",
            title: "demo",
            status: "running",
            cwd: payload.cwd ?? "/tmp/demo",
            opencodeSessionId: null,
            agentCount: 0,
            createdAt: "2026-04-28T00:00:00.000Z",
            completedAt: null,
            initializedAt: null,
          },
          agents: [],
          messages: [],
        };
      },
      getTaskSnapshot: async () => {
        throw new Error("unexpected getTaskSnapshot");
      },
      getWorkspaceSnapshot: async () => {
        throw new Error("unexpected getWorkspaceSnapshot");
      },
      getTaskRuntime: async () => {
        throw new Error("unexpected getTaskRuntime");
      },
      openAgentTerminal: async () => {
        throw new Error("unexpected openAgentTerminal");
      },
    } as never,
    cwd: "/tmp/demo",
    taskId: "task-123",
    port,
    webRoot: null,
    userDataPath: "/tmp",
  });

  try {
    const response = await fetch(`http://localhost:${port}/api/tasks/submit`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: `{
        cwd: "/tmp/demo",
        content: "请开始执行",
        newTaskId: "task-123",
      }`,
    });

    assert.equal(response.status, 200);
    assert.deepEqual(capturedPayload, {
      cwd: "/tmp/demo",
      content: "请开始执行",
      newTaskId: "task-123",
    });
  } finally {
    await host.close();
  }
});
