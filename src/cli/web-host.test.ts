import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import type { SubmitTaskPayload, TaskSnapshot, WorkspaceSnapshot } from "@shared/types";
import { toUtcIsoTimestamp } from "@shared/types";

import {
  reserveLoopbackPort,
  resolveAvailableLoopbackBindHosts,
} from "./loopback-bindings";
import { startWebHost } from "./web-host";
import {
  UI_LOOPBACK_IPV6_HOST,
} from "./ui-host-launch";

const UI_LOOPBACK_IPV4_HOST = "127.0.0.1";

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

function createStaticWebRoot() {
  const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-web-host-"));
  fs.writeFileSync(path.join(webRoot, "index.html"), "<!doctype html><html><body>ui-index</body></html>");
  fs.mkdirSync(path.join(webRoot, "assets"));
  fs.writeFileSync(path.join(webRoot, "assets", "app.js"), "console.log('web-host-test');");
  return webRoot;
}

function buildWorkspaceSnapshot(input: {
  cwd: string;
  name: string;
}): WorkspaceSnapshot {
  return {
    cwd: input.cwd,
    name: input.name,
    agents: [],
    topology: {
      nodes: [],
      edges: [],
      flow: {
        start: { id: "__start__", targets: [] },
        end: { id: "__end__", sources: [], incoming: [] },
      },
      nodeRecords: [],
    },
  };
}

function buildTaskSnapshot(input: { id: string; cwd: string }): TaskSnapshot {
  return {
    task: {
      id: input.id,
      title: "demo",
      status: "running",
      cwd: input.cwd,
      agentCount: 0,
      createdAt: "2026-04-28T00:00:00.000Z",
      completedAt: "",
      initializedAt: "",
    },
    agents: [],
    messages: [],
    topology: {
      nodes: [],
      edges: [],
      flow: {
        start: { id: "__start__", targets: [] },
        end: { id: "__end__", sources: [], incoming: [] },
      },
      nodeRecords: [],
    },
  };
}

function buildRunningTaskSnapshot(input: { id: string; cwd: string }): TaskSnapshot {
  return {
    ...buildTaskSnapshot(input),
    agents: [{
      id: "BA",
      opencodeSessionId: "session-ba",
      opencodeAttachBaseUrl: "http://127.0.0.1:43127",
      status: "running",
      runCount: 1,
    }],
  };
}

test("startWebHost 会按 JSON 解析 /api/tasks/submit 请求体", async () => {
  const port = await reservePort();
  const capturedPayloads: SubmitTaskPayload[] = [];
  const host = await startWebHost({
    orchestrator: {
      submitTask: async (payload: SubmitTaskPayload) => {
        capturedPayloads.push(payload);
        return {
          task: {
            id: "task-123",
            title: "demo",
            status: "running",
            cwd: "/tmp/demo",
            agentCount: 0,
            createdAt: "2026-04-28T00:00:00.000Z",
            completedAt: "",
            initializedAt: "",
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
      openAgentTerminal: async () => {
        throw new Error("unexpected openAgentTerminal");
      },
    } as never,
    port,
    staticAssets: { kind: "api-only" },
    userDataPath: "/tmp",
    bindHosts: [UI_LOOPBACK_IPV4_HOST],
  });

  try {
    const response = await fetch(`http://localhost:${port}/api/tasks/submit`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        content: "请开始执行",
        newTaskId: "task-123",
      }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(capturedPayloads, [{
      content: "请开始执行",
    }]);
  } finally {
    await host.close();
  }
});

test("startWebHost 会同时监听 IPv4 和 IPv6 loopback，避免 localhost 命中其他进程", async () => {
  const port = await reservePort();
  const host = await startWebHost({
    orchestrator: {
      submitTask: async () => {
        throw new Error("unexpected submitTask");
      },
      getWorkspaceSnapshot: async () => buildWorkspaceSnapshot({
        cwd: "/tmp/demo",
        name: "demo",
      }),
      openAgentTerminal: async () => {
        throw new Error("unexpected openAgentTerminal");
      },
    } as never,
    port,
    staticAssets: { kind: "api-only" },
    userDataPath: "/tmp",
    bindHosts: await resolveAvailableLoopbackBindHosts(),
  });

  try {
    const availableBindHosts = await resolveAvailableLoopbackBindHosts();
    const ipv4Response = await fetch(`http://${UI_LOOPBACK_IPV4_HOST}:${port}/healthz`);

    assert.equal(ipv4Response.status, 200);
    assert.deepEqual(await ipv4Response.json(), {
      ok: true,
      port,
    });
    if (availableBindHosts.includes(UI_LOOPBACK_IPV6_HOST)) {
      const ipv6Response = await fetch(`http://[${UI_LOOPBACK_IPV6_HOST}]:${port}/healthz`);
      assert.equal(ipv6Response.status, 200);
      assert.deepEqual(await ipv6Response.json(), {
        ok: true,
        port,
      });
    }
  } finally {
    await host.close();
  }
});

test("startWebHost 在 single-page-app 模式下返回静态入口与资源文件", async () => {
  const port = await reservePort();
  const webRoot = createStaticWebRoot();
  const host = await startWebHost({
    orchestrator: {
      submitTask: async () => {
        throw new Error("unexpected submitTask");
      },
      getWorkspaceSnapshot: async () => {
        throw new Error("unexpected getWorkspaceSnapshot");
      },
      openAgentTerminal: async () => {
        throw new Error("unexpected openAgentTerminal");
      },
    } as never,
    port,
    staticAssets: { kind: "single-page-app", webRoot },
    userDataPath: "/tmp",
    bindHosts: [UI_LOOPBACK_IPV4_HOST],
  });

  try {
    const entryResponse = await fetch(`http://localhost:${port}/`);
    assert.equal(entryResponse.status, 200);
    assert.equal(await entryResponse.text(), "<!doctype html><html><body>ui-index</body></html>");

    const assetResponse = await fetch(`http://localhost:${port}/assets/app.js`);
    assert.equal(assetResponse.status, 200);
    assert.equal(await assetResponse.text(), "console.log('web-host-test');");
  } finally {
    await host.close();
    fs.rmSync(webRoot, { recursive: true, force: true });
  }
});

test("startWebHost 的 /api/ui-snapshot 会区分 idle 与 active task", async () => {
  const idlePort = await reservePort();
  let idleTaskSnapshotCalls = 0;
  const idleWorkspace = buildWorkspaceSnapshot({
    cwd: "/tmp/idle",
    name: "idle",
  });
  const idleHost = await startWebHost({
    orchestrator: {
      submitTask: async () => {
        throw new Error("unexpected submitTask");
      },
      getTaskSnapshot: async () => {
        idleTaskSnapshotCalls += 1;
        throw new Error("当前没有 Task");
      },
      getWorkspaceSnapshot: async () => idleWorkspace,
      openAgentTerminal: async () => {
        throw new Error("unexpected openAgentTerminal");
      },
    } as never,
    port: idlePort,
    staticAssets: { kind: "api-only" },
    userDataPath: "/tmp/user-data",
    bindHosts: [UI_LOOPBACK_IPV4_HOST],
  });

  try {
    const response = await fetch(`http://localhost:${idlePort}/api/ui-snapshot`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.kind, "workspace");
    assert.equal(payload.workspace.cwd, "/tmp/idle");
    assert.equal("task" in payload, false);
    assert.equal("taskLogFilePath" in payload, false);
    assert.equal(payload.launchCwd, "/tmp/idle");
    assert.equal(payload.taskUrl, `http://localhost:${idlePort}/`);
    assert.equal(idleTaskSnapshotCalls, 1);
  } finally {
    await idleHost.close();
  }

  const activePort = await reservePort();
  let activeTaskSnapshotCalls = 0;
  const activeTaskSnapshot = buildTaskSnapshot({
    id: "task-active",
    cwd: "/tmp/active",
  });
  const activeHost = await startWebHost({
    orchestrator: {
      submitTask: async () => {
        throw new Error("unexpected submitTask");
      },
      getTaskSnapshot: async () => {
        activeTaskSnapshotCalls += 1;
        return activeTaskSnapshot;
      },
      getWorkspaceSnapshot: async () => buildWorkspaceSnapshot({
        cwd: "/tmp/active",
        name: "active",
      }),
      openAgentTerminal: async () => {
        throw new Error("unexpected openAgentTerminal");
      },
    } as never,
    port: activePort,
    staticAssets: { kind: "api-only" },
    userDataPath: "/tmp/user-data",
    bindHosts: [UI_LOOPBACK_IPV4_HOST],
  });

  try {
    const response = await fetch(`http://localhost:${activePort}/api/ui-snapshot`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.kind, "task");
    assert.equal(payload.workspace.cwd, "/tmp/active");
    assert.deepEqual(payload.task, activeTaskSnapshot);
    assert.equal(payload.taskLogFilePath, path.join("/tmp/user-data", "logs", "tasks", "task-active.log"));
    assert.equal(payload.launchCwd, "/tmp/active");
    assert.equal(payload.taskUrl, `http://localhost:${activePort}/`);
    assert.equal(activeTaskSnapshotCalls, 1);
  } finally {
    await activeHost.close();
  }
});

test("startWebHost 的 /api/ui-snapshot 会注入非持久化 OpenCode 过程消息", async () => {
  const port = await reservePort();
  const taskSnapshot = {
    ...buildRunningTaskSnapshot({
      id: "task-live-progress",
      cwd: "/tmp/live-progress",
    }),
    agents: [
      {
        id: "BA",
        opencodeSessionId: "session-ba",
        opencodeAttachBaseUrl: "http://127.0.0.1:43127",
        status: "completed" as const,
        runCount: 1,
      },
      {
        id: "TaskReview",
        opencodeSessionId: "session-task-review",
        opencodeAttachBaseUrl: "http://127.0.0.1:43128",
        status: "running" as const,
        runCount: 1,
      },
    ],
    messages: [
      {
        id: "persisted-progress-completed",
        content: "tool",
        sender: "BA",
        timestamp: toUtcIsoTimestamp("2026-04-30T12:00:00.000Z"),
        kind: "agent-progress" as const,
        activityKind: "tool" as const,
        label: "tool",
        detail: "已结束 agent 的过程消息",
        detailState: "complete" as const,
        sessionId: "session-ba",
        runCount: 1,
      },
      {
        id: "persisted-progress-running",
        content: "thinking",
        sender: "TaskReview",
        timestamp: toUtcIsoTimestamp("2026-04-30T12:00:00.500Z"),
        kind: "agent-progress" as const,
        activityKind: "thinking" as const,
        label: "thinking",
        detail: "运行中 agent 的过程消息",
        detailState: "not_applicable" as const,
        sessionId: "session-task-review",
        runCount: 1,
      },
    ],
  };
  const host = await startWebHost({
    orchestrator: {
      submitTask: async () => {
        throw new Error("unexpected submitTask");
      },
      getTaskSnapshot: async () => taskSnapshot,
      getWorkspaceSnapshot: async () => buildWorkspaceSnapshot({
        cwd: "/tmp/live-progress",
        name: "live-progress",
      }),
      opencodeClient: {
        listSessionActivities: async (sessionId: string) =>
          sessionId === "session-task-review"
            ? [{
                sourceMessageId: "msg-tool",
                sourcePartIndex: 0,
                kind: "tool",
                label: "read",
                detail: "参数: filePath=/tmp/demo.txt",
                timestamp: "2026-04-30T12:00:01.000Z",
              }]
            : [],
      },
      openAgentTerminal: async () => {
        throw new Error("unexpected openAgentTerminal");
      },
    } as never,
    port,
    staticAssets: { kind: "api-only" },
    userDataPath: "/tmp/user-data",
    bindHosts: [UI_LOOPBACK_IPV4_HOST],
  });

  try {
    const response = await fetch(`http://localhost:${port}/api/ui-snapshot`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.kind, "task");
    assert.deepEqual(payload.task.messages.map((message: { id: string }) => message.id), [
      "persisted-progress-running",
      "live:TaskReview:msg-tool:0",
    ]);
    assert.deepEqual(payload.task.messages.map((message: { content: string }) => message.content), [
      "thinking",
      "read",
    ]);
  } finally {
    await host.close();
  }
});

test("startWebHost 的 /api/ui-snapshot 遇到非空任务异常时返回 500", async () => {
  const port = await reservePort();
  const host = await startWebHost({
    orchestrator: {
      submitTask: async () => {
        throw new Error("unexpected submitTask");
      },
      getTaskSnapshot: async () => {
        throw new Error("snapshot_failed");
      },
      getWorkspaceSnapshot: async () => buildWorkspaceSnapshot({
        cwd: "/tmp/snapshot-failed",
        name: "snapshot-failed",
      }),
      openAgentTerminal: async () => {
        throw new Error("unexpected openAgentTerminal");
      },
    } as never,
    port,
    staticAssets: { kind: "api-only" },
    userDataPath: "/tmp/user-data",
    bindHosts: [UI_LOOPBACK_IPV4_HOST],
  });

  try {
    const response = await fetch(`http://localhost:${port}/api/ui-snapshot`);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      message: "snapshot_failed",
    });
  } finally {
    await host.close();
  }
});

test("startWebHost 的 /api/tasks/open-agent-terminal 只透传 agentId", async () => {
  const port = await reservePort();
  const capturedAgentIds: string[] = [];
  const host = await startWebHost({
    orchestrator: {
      submitTask: async () => {
        throw new Error("unexpected submitTask");
      },
      getWorkspaceSnapshot: async () => {
        throw new Error("unexpected getWorkspaceSnapshot");
      },
      openAgentTerminal: async (agentId: string) => {
        capturedAgentIds.push(agentId);
      },
    } as never,
    port,
    staticAssets: { kind: "api-only" },
    userDataPath: "/tmp",
    bindHosts: [UI_LOOPBACK_IPV4_HOST],
  });

  try {
    const response = await fetch(`http://localhost:${port}/api/tasks/open-agent-terminal`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        agentId: "Build",
      }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(capturedAgentIds, ["Build"]);
  } finally {
    await host.close();
  }
});

test("startWebHost 在 submit 请求缺少有效 content 时返回 400", async () => {
  const port = await reservePort();
  const host = await startWebHost({
    orchestrator: {
      submitTask: async () => {
        throw new Error("unexpected submitTask");
      },
      getWorkspaceSnapshot: async () => {
        throw new Error("unexpected getWorkspaceSnapshot");
      },
      openAgentTerminal: async () => {
        throw new Error("unexpected openAgentTerminal");
      },
    } as never,
    port,
    staticAssets: { kind: "api-only" },
    userDataPath: "/tmp",
    bindHosts: [UI_LOOPBACK_IPV4_HOST],
  });

  try {
    const response = await fetch(`http://localhost:${port}/api/tasks/submit`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        content: "   ",
      }),
    });

    assert.equal(response.status, 400);
    assert.equal(await response.text(), "非法请求：content 必须是非空字符串");
  } finally {
    await host.close();
  }
});

test("startWebHost 在 submit 请求提供非法 mentionAgentId 时返回 400", async () => {
  const port = await reservePort();
  const host = await startWebHost({
    orchestrator: {
      submitTask: async () => {
        throw new Error("unexpected submitTask");
      },
      getWorkspaceSnapshot: async () => {
        throw new Error("unexpected getWorkspaceSnapshot");
      },
      openAgentTerminal: async () => {
        throw new Error("unexpected openAgentTerminal");
      },
    } as never,
    port,
    staticAssets: { kind: "api-only" },
    userDataPath: "/tmp",
    bindHosts: [UI_LOOPBACK_IPV4_HOST],
  });

  try {
    const response = await fetch(`http://localhost:${port}/api/tasks/submit`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        content: "请开始执行",
        mentionAgentId: "",
      }),
    });

    assert.equal(response.status, 400);
    assert.equal(await response.text(), "非法请求：mentionAgentId 必须是非空字符串");
  } finally {
    await host.close();
  }
});

test("startWebHost 在 open-agent-terminal 请求缺少有效 agentId 时返回 400", async () => {
  const port = await reservePort();
  const host = await startWebHost({
    orchestrator: {
      submitTask: async () => {
        throw new Error("unexpected submitTask");
      },
      getWorkspaceSnapshot: async () => {
        throw new Error("unexpected getWorkspaceSnapshot");
      },
      openAgentTerminal: async () => {
        throw new Error("unexpected openAgentTerminal");
      },
    } as never,
    port,
    staticAssets: { kind: "api-only" },
    userDataPath: "/tmp",
    bindHosts: [UI_LOOPBACK_IPV4_HOST],
  });

  try {
    const response = await fetch(`http://localhost:${port}/api/tasks/open-agent-terminal`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        agentId: "",
      }),
    });

    assert.equal(response.status, 400);
    assert.equal(await response.text(), "非法请求：agentId 必须是非空字符串");
  } finally {
    await host.close();
  }
});

test("startWebHost 任一 bind host 监听失败时会关闭已监听 server", async () => {
  const availableBindHosts = await resolveAvailableLoopbackBindHosts();
  if (availableBindHosts.length < 2) {
    return;
  }
  const blockedHost = availableBindHosts[1];
  if (!blockedHost) {
    assert.fail("测试缺少第二个 loopback host");
  }

  const port = await reservePort();
  const blocker = await reserveLoopbackPort(blockedHost, port);
  if (!blocker.ok) {
    assert.fail("测试未能占住第二个 loopback host 的端口");
  }

  try {
    await assert.rejects(
      startWebHost({
        orchestrator: {
          submitTask: async () => {
            throw new Error("unexpected submitTask");
          },
          getTaskSnapshot: async () => {
            throw new Error("unexpected getTaskSnapshot");
          },
          getWorkspaceSnapshot: async () => {
            throw new Error("unexpected getWorkspaceSnapshot");
          },
          openAgentTerminal: async () => {
            throw new Error("unexpected openAgentTerminal");
          },
        } as never,
        port,
        staticAssets: { kind: "api-only" },
        userDataPath: "/tmp",
        bindHosts: availableBindHosts,
      }),
      /listen|EADDRINUSE|port .* in use/i,
    );
  } finally {
    await blocker.reservation.close();
  }

  const reusedHost = await startWebHost({
    orchestrator: {
      submitTask: async () => {
        throw new Error("unexpected submitTask");
      },
      getWorkspaceSnapshot: async () => buildWorkspaceSnapshot({
        cwd: "/tmp/demo",
        name: "demo",
      }),
      openAgentTerminal: async () => {
        throw new Error("unexpected openAgentTerminal");
      },
    } as never,
    port,
    staticAssets: { kind: "api-only" },
    userDataPath: "/tmp",
    bindHosts: availableBindHosts,
  });
  await reusedHost.close();
});
