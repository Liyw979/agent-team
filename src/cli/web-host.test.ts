import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import type { SubmitTaskPayload, TaskSnapshot, WorkspaceSnapshot } from "@shared/types";

import {
  reserveLoopbackPort,
  resolveAvailableLoopbackBindHosts,
} from "./loopback-bindings";
import { startWebHost } from "./web-host";
import {
  UI_LOOPBACK_IPV6_HOST,
} from "./ui-host-launch";

const UI_LOOPBACK_IPV4_HOST = "127.0.0.1";
const createNoopUnsubscribe = () => {};

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
  tasks: WorkspaceSnapshot["tasks"];
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
    messages: [],
    tasks: input.tasks,
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

test("startWebHost 会按 JSON 解析 /api/tasks/submit 请求体", async () => {
  const port = await reservePort();
  const capturedPayloads: SubmitTaskPayload[] = [];
  const host = await startWebHost({
    orchestrator: {
      subscribe: () => createNoopUnsubscribe,
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
      getTaskRuntime: async () => {
        throw new Error("unexpected getTaskRuntime");
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
  const taskSnapshot = buildTaskSnapshot({
    id: "task-123",
    cwd: "/tmp/demo",
  });
  const host = await startWebHost({
    orchestrator: {
      subscribe: () => createNoopUnsubscribe,
      submitTask: async () => {
        throw new Error("unexpected submitTask");
      },
      getWorkspaceSnapshot: async () => buildWorkspaceSnapshot({
        cwd: "/tmp/demo",
        name: "demo",
        tasks: [taskSnapshot],
      }),
      getTaskRuntime: async () => {
        throw new Error("unexpected getTaskRuntime");
      },
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
      subscribe: () => createNoopUnsubscribe,
      submitTask: async () => {
        throw new Error("unexpected submitTask");
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
    tasks: [],
  });
  const idleHost = await startWebHost({
    orchestrator: {
      subscribe: () => createNoopUnsubscribe,
      submitTask: async () => {
        throw new Error("unexpected submitTask");
      },
      getTaskSnapshot: async () => {
        idleTaskSnapshotCalls += 1;
        throw new Error("unexpected getTaskSnapshot");
      },
      getWorkspaceSnapshot: async () => idleWorkspace,
      getTaskRuntime: async () => {
        throw new Error("unexpected getTaskRuntime");
      },
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
    assert.equal(payload.workspace.tasks.length, 0);
    assert.equal("task" in payload, false);
    assert.equal("taskLogFilePath" in payload, false);
    assert.equal(payload.launchCwd, "/tmp/idle");
    assert.equal(payload.taskUrl, `http://localhost:${idlePort}/`);
    assert.equal(idleTaskSnapshotCalls, 0);
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
      subscribe: () => createNoopUnsubscribe,
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
        tasks: [activeTaskSnapshot],
      }),
      getTaskRuntime: async () => {
        throw new Error("unexpected getTaskRuntime");
      },
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
    assert.equal(payload.workspace.tasks.length, 1);
    assert.deepEqual(payload.task, activeTaskSnapshot);
    assert.equal(payload.taskLogFilePath, "/tmp/user-data/logs/tasks/task-active.log");
    assert.equal(payload.launchCwd, "/tmp/active");
    assert.equal(payload.taskUrl, `http://localhost:${activePort}/`);
    assert.equal(activeTaskSnapshotCalls, 1);
  } finally {
    await activeHost.close();
  }
});

test("startWebHost 的 /api/tasks/runtime 始终绑定当前进程 task，不接受查询参数覆盖", async () => {
  const port = await reservePort();
  let runtimeCallCount = 0;
  const taskSnapshot = buildTaskSnapshot({
    id: "task-123",
    cwd: "/tmp/demo",
  });
  const host = await startWebHost({
    orchestrator: {
      subscribe: () => createNoopUnsubscribe,
      submitTask: async () => {
        throw new Error("unexpected submitTask");
      },
      getWorkspaceSnapshot: async () => buildWorkspaceSnapshot({
        cwd: "/tmp/demo",
        name: "demo",
        tasks: [taskSnapshot],
      }),
      getTaskRuntime: async () => {
        runtimeCallCount += 1;
        return [];
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
    const response = await fetch(`http://localhost:${port}/api/tasks/runtime?taskId=task-overridden`);
    assert.equal(response.status, 200);
    assert.equal(runtimeCallCount, 1);
  } finally {
    await host.close();
  }
});

test("startWebHost 的 /api/tasks/open-agent-terminal 只透传 agentId", async () => {
  const port = await reservePort();
  const capturedPayloads: Array<{ agentId: string }> = [];
  const host = await startWebHost({
    orchestrator: {
      subscribe: () => createNoopUnsubscribe,
      submitTask: async () => {
        throw new Error("unexpected submitTask");
      },
      getWorkspaceSnapshot: async () => {
        throw new Error("unexpected getWorkspaceSnapshot");
      },
      getTaskRuntime: async () => {
        throw new Error("unexpected getTaskRuntime");
      },
      openAgentTerminal: async (payload: { agentId: string }) => {
        capturedPayloads.push(payload);
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
        taskId: "task-overridden",
      }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(capturedPayloads, [{ agentId: "Build" }]);
  } finally {
    await host.close();
  }
});

test("startWebHost 在 submit 请求缺少有效 content 时返回 400", async () => {
  const port = await reservePort();
  const host = await startWebHost({
    orchestrator: {
      subscribe: () => createNoopUnsubscribe,
      submitTask: async () => {
        throw new Error("unexpected submitTask");
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
      subscribe: () => createNoopUnsubscribe,
      submitTask: async () => {
        throw new Error("unexpected submitTask");
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
      subscribe: () => createNoopUnsubscribe,
      submitTask: async () => {
        throw new Error("unexpected submitTask");
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

test("startWebHost 任一 bind host 监听失败时会关闭已监听 server 并取消订阅", async () => {
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

  let unsubscribeCallCount = 0;
  try {
    await assert.rejects(
      startWebHost({
        orchestrator: {
          subscribe: () => {
            return () => {
              unsubscribeCallCount += 1;
            };
          },
          submitTask: async () => {
            throw new Error("unexpected submitTask");
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

  assert.equal(unsubscribeCallCount, 1);
  const taskSnapshot = buildTaskSnapshot({
    id: "task-123",
    cwd: "/tmp/demo",
  });
  const reusedHost = await startWebHost({
    orchestrator: {
      subscribe: () => createNoopUnsubscribe,
      submitTask: async () => {
        throw new Error("unexpected submitTask");
      },
      getWorkspaceSnapshot: async () => buildWorkspaceSnapshot({
        cwd: "/tmp/demo",
        name: "demo",
        tasks: [taskSnapshot],
      }),
      getTaskRuntime: async () => {
        throw new Error("unexpected getTaskRuntime");
      },
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
