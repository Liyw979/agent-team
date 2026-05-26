// 2026-05-26: 用户要求将非 session message 长请求的默认短超时从 12 秒调整为 30 秒。
// 用户要求：submit message 的每次重试前必须先调用 abort，避免旧 OpenCode session 运行状态导致再次提交卡死。
// 2026-05-26: 用户要求每次发送 OpenCode 请求都必须记录到当前 Task log 文件。
// 2026-05-26: 用户要求网络日志只写入文件，不输出到控制台。
import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { bindCurrentTaskLog, buildTaskLogFilePath, initAppFileLogger } from "./app-log";
import { OpenCodeClient, type OpenCodeSessionActivity, type ServeHandle } from "./opencode-client";

class TestOpenCodeClient extends OpenCodeClient {
  declare request: OpenCodeClient["request"];
}

type TestRequestPathname = Parameters<TestOpenCodeClient["request"]>[0];
type TestRequestOptions = Parameters<TestOpenCodeClient["request"]>[1];
type TestRequestResult = ReturnType<TestOpenCodeClient["request"]>;

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-opencode-client-"));
}

function createDetachedServeHandle(port: number) {
  return {
    process: {
      pid: 0,
      killed: true,
      kill() {
        return true;
      },
      on() {
        return this;
      },
      off() {
        return this;
      },
      stderr: {
        on() {
          return this;
        },
      },
      stdout: {
        on() {
          return this;
        },
      },
    },
    port,
  } as unknown as ServeHandle;
}

function createClient(cwd = createTempDir()) {
  const normalizedCwd = path.resolve(cwd);
  const client = new OpenCodeClient({
    server: createDetachedServeHandle(43127),
  }) as OpenCodeClient & {
    request: (pathname: TestRequestPathname, options: TestRequestOptions) => TestRequestResult;
  };
  return {
    client,
    cwd: normalizedCwd,
  };
}

async function withFastForwardedTimeouts<T>(
  callback: () => Promise<T>,
  stepMs = 400,
): Promise<T> {
  const originalDateNow = Date.now;
  const originalSetTimeout = globalThis.setTimeout;
  let nowMs = originalDateNow();

  Date.now = () => nowMs;
  globalThis.setTimeout = (((handler: (...args: unknown[]) => void, _timeout: number, ...args: unknown[]) => {
    return originalSetTimeout(() => {
      nowMs += stepMs;
      handler(...args);
    }, 0);
  }) as typeof setTimeout);

  try {
    return await callback();
  } finally {
    Date.now = originalDateNow;
    globalThis.setTimeout = originalSetTimeout;
  }
}

async function captureStdout<T>(action: () => Promise<T>): Promise<{ stdout: string; result: T }> {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const stdoutMessages: string[] = [];
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutMessages.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;

  try {
    const result = await action();
    return {
      stdout: stdoutMessages.join(""),
      result,
    };
  } finally {
    process.stdout.write = originalStdoutWrite;
  }
}

async function withMockedFetch<T>(
  mockedFetch: typeof fetch,
  action: () => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockedFetch;
  try {
    return await action();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function readTaskEventRecords(userDataPath: string, taskId: string, event: string): Record<string, unknown>[] {
  return readTaskRecords(userDataPath, taskId)
    .filter((record) => record["event"] === event);
}

function readTaskRecords(userDataPath: string, taskId: string): Record<string, unknown>[] {
  const logFilePath = buildTaskLogFilePath(userDataPath, taskId);
  return fs.existsSync(logFilePath)
    ? fs.readFileSync(logFilePath, "utf8")
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    : [];
}

function createOpenCodeMessageResponse(input: {
  id: string;
  role: string;
  text: string;
}) {
  return new Response(JSON.stringify({
    info: {
      id: input.id,
      role: input.role,
      time: {
        created: Date.parse("2026-05-07T00:00:00.000Z"),
        completed: Date.parse("2026-05-07T00:00:01.000Z"),
      },
      sessionID: "session-1",
      finish: "stop",
    },
    parts: [{ type: "text", text: input.text }],
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("request 会跟随当前 serverHandle 的实际端口", async () => {
  const userDataPath = createTempDir();
  initAppFileLogger(userDataPath);
  bindCurrentTaskLog("task-request-port");
  const { client } = createClient();
  const typed = client as OpenCodeClient & {
    request: (pathname: TestRequestPathname, options: TestRequestOptions) => TestRequestResult;
  };
  let requestedUrl = "";
  await withMockedFetch((async (input: string | URL | Request) => {
    requestedUrl = String(input);
    return new Response("", { status: 200 });
  }) as unknown as typeof fetch, () =>
    withFastForwardedTimeouts(async () => {
      await typed.request("/session", {
        method: "GET",
      });
    }, 1));
  assert.equal(requestedUrl, "http://127.0.0.1:43127/session");
  const [record] = readTaskEventRecords(userDataPath, "task-request-port", "opencode.request_sent") as [
    Record<string, unknown>,
  ];
  assert.equal(record["method"], "GET");
  assert.equal(record["url"], "http://127.0.0.1:43127/session");
});

test("request 失败时会写入 task 级失败日志", async () => {
  const userDataPath = createTempDir();
  initAppFileLogger(userDataPath);
  bindCurrentTaskLog("task-request-failed");
  const { client } = createClient();
  const typed = client as OpenCodeClient & {
    request: (pathname: TestRequestPathname, options: TestRequestOptions) => TestRequestResult;
  };
  let requestCount = 0;
  const response = await withMockedFetch((async () => {
    requestCount += 1;
    if (requestCount === 1) {
      throw new Error("boom task-request-failed");
    }
    return new Response("", { status: 200 });
  }) as unknown as typeof fetch, () =>
    withFastForwardedTimeouts(() => typed.request("/session", {
        method: "GET",
      }), 120_000));
  assert.equal(response.status, 200);

  const records = readTaskRecords(userDataPath, "task-request-failed");
  assert.deepEqual(records.map((record) => record["event"]), [
    "opencode.request_sent",
    "opencode.request_failed",
    "opencode.request_sent",
  ]);
  const [latestRecord] = readTaskEventRecords(userDataPath, "task-request-failed", "opencode.request_failed");
  assert.equal(latestRecord?.["taskId"], "task-request-failed");
});

test("submitMessage 在响应体缺少有效消息实体时直接失败", async () => {
  const userDataPath = createTempDir();
  const taskId = "task-submit-empty-response";
  initAppFileLogger(userDataPath);
  bindCurrentTaskLog(taskId);
  const { client } = createClient();
  let requestCount = 0;
  await withMockedFetch((async () => {
    requestCount += 1;
    return new Response("", { status: 200 });
  }) as unknown as typeof fetch, async () =>
    assert.rejects(
      withFastForwardedTimeouts(() => client.submitMessage("session-1", {
        agent: "BA",
        runtimeAgent: "BA-1",
        content: "请整理需求",
        allowedDecisionTriggers: [],
      })),
      /OpenCode 提交消息响应缺少有效的消息实体/,
    ));
  assert.equal(requestCount, 2);
  assert.equal(readTaskEventRecords(userDataPath, taskId, "opencode.submit_message_retried").length, 0);
  assert.deepEqual(
    readTaskRecords(userDataPath, taskId).map((record) => record["event"]),
    ["opencode.request_sent", "opencode.request_sent"],
  );
});

test("submitMessage 请求级失败由 submit 重试接管且每次重试前先 abort", async () => {
  const userDataPath = createTempDir();
  const taskId = "task-submit-request-failed";
  initAppFileLogger(userDataPath);
  bindCurrentTaskLog(taskId);
  const { client } = createClient();
  let requestCount = 0;
  const requestAt: number[] = [];
  const requestPathnames: string[] = [];
  const { result, stdout } = await captureStdout(() => withMockedFetch((async (input: string | URL | Request) => {
    const url = String(input);
    const pathname = new URL(url).pathname;
    requestPathnames.push(pathname);
    if (pathname === "/session/session-1/abort") {
      return new Response("", { status: 200 });
    }
    requestCount += 1;
    requestAt.push(Date.now());
    if (requestCount === 1) {
      return new Response("server error", { status: 500 });
    }
    if (requestCount === 2) {
      throw new Error("fetch failed");
    }
    return createOpenCodeMessageResponse({
      role: "assistant",
      id: "msg-2",
      text: "已恢复提交",
    });
  }) as unknown as typeof fetch, () =>
    withFastForwardedTimeouts(() => client.submitMessage("session-1", {
        agent: "BA",
        runtimeAgent: "BA-1",
        content: "请整理需求",
        allowedDecisionTriggers: [],
      }), 120_000)));

  assert.equal(result.finalMessage, "已恢复提交");
  assert.equal(requestCount, 3);
  const requestRetryAt = requestAt as [number, number, number];
  assert.deepEqual([requestRetryAt[1] - requestRetryAt[0], requestRetryAt[2] - requestRetryAt[1]], [0, 120_000]);
  assert.deepEqual(requestPathnames, [
    "/session/session-1/abort",
    "/session/session-1/message",
    "/session/session-1/abort",
    "/session/session-1/message",
    "/session/session-1/abort",
    "/session/session-1/message",
  ]);
  const stdoutRecords = stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(stdoutRecords.some((record) => record["event"] === "opencode.request_sent"), false);
  assert.equal(stdoutRecords.some((record) => record["event"] === "opencode.request_failed"), false);
  assert.deepEqual(
    stdoutRecords
      .filter((record) => record["event"] === "opencode.submit_message_retried")
      .map((record) => record["reason"]),
    ["OpenCode 请求失败: 500", "fetch failed"],
  );
  const records = readTaskEventRecords(userDataPath, taskId, "opencode.submit_message_retried");
  assert.equal(records.length, 2);
  assert.equal(readTaskEventRecords(userDataPath, taskId, "opencode.request_sent").length, 6);
  const [firstRequestFailure, secondRequestFailure] = readTaskEventRecords(userDataPath, taskId, "opencode.request_failed") as [
    Record<string, unknown>,
    Record<string, unknown>,
  ];
  assert.equal(firstRequestFailure["status"], 500);
  assert.equal(firstRequestFailure["message"], "OpenCode 请求失败: 500");
  assert.equal("status" in secondRequestFailure, false);
  assert.equal(secondRequestFailure["message"], "fetch failed");
});

test("submitMessage 重试前会先调用 session abort 接口", async () => {
  const userDataPath = createTempDir();
  initAppFileLogger(userDataPath);
  bindCurrentTaskLog("task-submit-abort-before-retry");
  const { client } = createClient();
  const requestPathnames: string[] = [];
  const submittedContents: string[] = [];
  let messageRequestCount = 0;
  const result = await withMockedFetch((async (...args: Parameters<typeof fetch>) => {
    const url = args[0] instanceof Request ? args[0].url : String(args[0]);
    const pathname = new URL(url).pathname;
    const options = args[1];
    requestPathnames.push(pathname);
    if (pathname === "/session/session-1/abort") {
      if (!options || options.method !== "POST") {
        throw new Error("submitMessage abort 请求必须是 POST");
      }
      assert.equal("body" in options, false);
      return new Response("", { status: 200 });
    }

    messageRequestCount += 1;
    if (!options || options.method !== "POST" || typeof options.body !== "string") {
      throw new Error("submitMessage 不应发起非 POST 请求");
    }
    const body = JSON.parse(options.body) as { parts: [{ text: string }] };
    submittedContents.push(body.parts[0].text);
    return messageRequestCount === 1
      ? new Response(JSON.stringify({
          info: {
            id: "msg-empty",
            role: "assistant",
            time: {
              created: Date.parse("2026-05-07T00:00:00.000Z"),
              completed: Date.parse("2026-05-07T00:00:01.000Z"),
            },
            sessionID: "session-1",
            finish: "stop",
          },
          parts: [
            { type: "step-start" },
            { type: "step-finish", reason: "stop" },
          ],
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      : createOpenCodeMessageResponse({
          role: "assistant",
          id: "msg-2",
          text: "已恢复提交",
        });
  }) as unknown as typeof fetch, () =>
    withFastForwardedTimeouts(() => client.submitMessage("session-1", {
        agent: "BA",
        runtimeAgent: "BA-1",
        content: "请整理需求",
        allowedDecisionTriggers: [],
      })));

  assert.equal(result.finalMessage, "已恢复提交");
  assert.deepEqual(requestPathnames, [
    "/session/session-1/abort",
    "/session/session-1/message",
    "/session/session-1/abort",
    "/session/session-1/message",
  ]);
  assert.deepEqual(submittedContents, ["请整理需求", "生成完整回复"]);
});

test("request 会在 abort 请求异常后持续重试直到成功", async () => {
  const userDataPath = createTempDir();
  const taskId = "task-abort-request-retry";
  initAppFileLogger(userDataPath);
  bindCurrentTaskLog(taskId);
  const { client } = createClient();
  const typed = client as OpenCodeClient & {
    request: (pathname: TestRequestPathname, options: TestRequestOptions) => TestRequestResult;
  };
  const requestedUrls: string[] = [];
  const requestAt: number[] = [];
  let abortCount = 0;
  await withMockedFetch((async (input: string | URL | Request) => {
    const url = String(input);
    requestedUrls.push(url);
    requestAt.push(Date.now());
    abortCount += 1;
    if (abortCount === 1) {
      throw new Error("abort fetch failed");
    }
    return new Response("", { status: 200 });
  }) as unknown as typeof fetch, () =>
    withFastForwardedTimeouts(() => typed.request("/session/session-1/abort", {
      method: "POST",
      body: "",
    }, "OpenCode 中止 session 失败"), 120_000));

  assert.deepEqual(requestedUrls, [
    "http://127.0.0.1:43127/session/session-1/abort",
    "http://127.0.0.1:43127/session/session-1/abort",
  ]);
  const retryAt = requestAt as [number, number];
  assert.deepEqual([retryAt[1] - retryAt[0]], [120_000]);
  assert.equal(readTaskEventRecords(userDataPath, taskId, "opencode.request_sent").length, 2);
});

test("request 会在 createSession 请求超时后持续重试直到拿到成功响应", async () => {
  const userDataPath = createTempDir();
  const taskId = "task-create-session-retry-target";
  initAppFileLogger(userDataPath);
  bindCurrentTaskLog(taskId);
  const { client } = createClient();
  const typed = client as OpenCodeClient & {
    request: (pathname: TestRequestPathname, options: TestRequestOptions) => TestRequestResult;
  };
  let requestCount = 0;
  const requestAt: number[] = [];
  const response = await withMockedFetch((async () => {
    requestCount += 1;
    requestAt.push(Date.now());
    if (requestCount === 1) {
      throw new Error("OpenCode 请求超时: POST http://127.0.0.1:43127/session 超过 30000ms");
    }
    return new Response(JSON.stringify({ id: "session-recovered" }), { status: 200 });
  }) as unknown as typeof fetch, () =>
    withFastForwardedTimeouts(() => typed.request("/session", {
        method: "POST",
        body: JSON.stringify({ title: "demo" }),
      }, "OpenCode 创建 session 失败"), 120_000));
  assert.equal(response.status, 200);

  assert.equal(requestCount, 2);
  const retryAt = requestAt as [number, number];
  assert.deepEqual([retryAt[1] - retryAt[0]], [120_000]);
});

test("createSession 在响应格式无效时直接失败", async () => {
  const userDataPath = createTempDir();
  const taskId = "task-create-session-invalid-response";
  initAppFileLogger(userDataPath);
  bindCurrentTaskLog(taskId);
  const { client } = createClient();
  let requestCount = 0;
  await withMockedFetch((async () => {
    requestCount += 1;
    return new Response("", { status: 200 });
  }) as unknown as typeof fetch, () =>
    assert.rejects(
      client.createSession("demo"),
      /OpenCode 创建 session 响应缺少有效的 session id/,
    ));

  assert.equal(requestCount, 1);
  assert.deepEqual(
    readTaskEventRecords(userDataPath, taskId, "opencode.create_session_invalid_response")
      .map((record) => [record["title"], record["status"]]),
    [["demo", 200]],
  );
});

test("submitMessage 首次发送 5 分钟超时后会立刻重试", async () => {
  const userDataPath = createTempDir();
  const taskId = "task-submit-message-timeout";
  initAppFileLogger(userDataPath);
  bindCurrentTaskLog(taskId);
  const { client } = createClient();
  const requestPathnames: string[] = [];
  let messageCount = 0;
  const result = await withMockedFetch((async (...args: Parameters<typeof fetch>) => {
    const url = args[0] instanceof Request ? args[0].url : String(args[0]);
    const pathname = new URL(url).pathname;
    requestPathnames.push(pathname);
    if (pathname === "/session/session-1/abort") {
      return new Response("", { status: 200 });
    }
    messageCount += 1;
    if (pathname === "/session/session-1/message" && messageCount === 1) {
      const requestInit = args[1];
      const signal = typeof requestInit === "object"
        && requestInit
        && "signal" in requestInit
        && requestInit.signal instanceof AbortSignal
        ? requestInit.signal
        : new AbortController().signal;
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason));
      });
    }
    return createOpenCodeMessageResponse({
      role: "assistant",
      id: "msg-2",
      text: "已恢复提交",
    });
  }) as unknown as typeof fetch, () =>
    withFastForwardedTimeouts(() => client.submitMessage("session-1", {
      agent: "BA",
      runtimeAgent: "BA-1",
      content: "请整理需求",
      allowedDecisionTriggers: [],
    }), 300_000));

  assert.equal(result.finalMessage, "已恢复提交");
  assert.deepEqual(requestPathnames, [
    "/session/session-1/abort",
    "/session/session-1/message",
    "/session/session-1/abort",
    "/session/session-1/message",
  ]);
  assert.equal(readTaskEventRecords(userDataPath, taskId, "opencode.submit_message_retried").length, 1);
  assert.equal(readTaskEventRecords(userDataPath, taskId, "opencode.request_sent").length, 4);
  assert.deepEqual(
    readTaskEventRecords(userDataPath, taskId, "opencode.request_failed")
      .map((record) => record["message"]),
    ["OpenCode 请求超时: POST http://127.0.0.1:43127/session/session-1/message 超过 300000ms"],
  );
});

test("submitMessage 正常完成时不打印网络日志，且最终请求体不注入 system 字段", async () => {
  const userDataPath = createTempDir();
  const taskId = "task-submit-success";
  initAppFileLogger(userDataPath);
  bindCurrentTaskLog(taskId);
  const { client } = createClient();
  let capturedBody = "";

  const { stdout } = await captureStdout(() => withMockedFetch((async (...args: Parameters<typeof fetch>) => {
    const pathname = new URL(String(args[0])).pathname;
    if (pathname === "/session/session-1/abort") {
      return new Response("", { status: 200 });
    }
    const options = args[1] as RequestInit;
    capturedBody = options.body as string;
    return createOpenCodeMessageResponse({
      role: "assistant",
      id: "msg-1",
      text: "已完成",
    });
  }) as unknown as typeof fetch, () => client.submitMessage("session-1", {
      agent: "TaskReview",
      runtimeAgent: "TaskReview",
      content: "请继续判定",
      allowedDecisionTriggers: [],
    })));

  assert.equal(stdout, "");
  assert.deepEqual(readTaskRecords(userDataPath, taskId).map((record) => record["event"]), [
    "opencode.request_sent",
    "opencode.request_sent",
  ]);
  assert.notEqual(capturedBody, "");
  assert.equal(capturedBody.includes("\"system\""), false);
  assert.deepEqual(JSON.parse(capturedBody), {
    agent: "TaskReview",
    parts: [{ type: "text", text: "请继续判定" }],
  });
});

test("submitMessage 正常发送前会先调用 session abort 接口", async () => {
  const { client } = createClient();
  const requestPathnames: string[] = [];
  const result = await withMockedFetch((async (input: string | URL | Request) => {
    const pathname = new URL(String(input)).pathname;
    requestPathnames.push(pathname);
    return pathname === "/session/session-1/abort"
      ? new Response("", { status: 200 })
      : createOpenCodeMessageResponse({
          role: "assistant",
          id: "msg-1",
          text: "已完成",
        });
  }) as unknown as typeof fetch, () => client.submitMessage("session-1", {
    agent: "BA",
    runtimeAgent: "BA-1",
    content: "请整理需求",
    allowedDecisionTriggers: [],
  }));

  assert.equal(result.finalMessage, "已完成");
  assert.deepEqual(requestPathnames, [
    "/session/session-1/abort",
    "/session/session-1/message",
  ]);
});

test("submitMessage 在空 assistant final 后会重新发消息", async () => {
  const userDataPath = createTempDir();
  const taskId = "task-submit-empty-final";
  initAppFileLogger(userDataPath);
  bindCurrentTaskLog(taskId);
  const { client } = createClient();
  const submittedContents: string[] = [];
  let postCount = 0;
  const result = await withMockedFetch((async (...args: Parameters<typeof fetch>) => {
    const pathname = new URL(String(args[0])).pathname;
    if (pathname === "/session/session-1/abort") {
      return new Response("", { status: 200 });
    }

    const options = args[1] as RequestInit;
    assert.equal(options.method, "POST");
    postCount += 1;
    const body = JSON.parse(options.body as string) as { parts: [{ text: string }] };
    assert.equal(body.parts.length, 1);
    submittedContents.push(body.parts[0].text);
    if (postCount === 1) {
      return new Response(JSON.stringify({
        info: {
          id: "msg-empty",
          role: "assistant",
          time: {
            created: Date.parse("2026-05-07T00:00:00.000Z"),
            completed: Date.parse("2026-05-07T00:00:01.000Z"),
          },
          sessionID: "session-1",
          finish: "stop",
        },
        parts: [
          { type: "step-start" },
          { type: "step-finish", reason: "stop" },
        ],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return createOpenCodeMessageResponse({
      id: `msg-${postCount}`,
      role: "assistant",
      text: "已恢复正式回复",
    });
  }) as unknown as typeof fetch, () =>
    withFastForwardedTimeouts(() => client.submitMessage("session-1", {
      agent: "BA",
      runtimeAgent: "BA-1",
      content: "请整理需求",
      allowedDecisionTriggers: [],
    })));

  assert.equal(result.finalMessage, "已恢复正式回复");
  assert.deepEqual(submittedContents, ["请整理需求", "生成完整回复"]);
  const [record] = readTaskEventRecords(userDataPath, taskId, "opencode.submit_message_retried") as [Record<string, unknown>];
  assert.equal(record["retryCount"], 0);
  assert.equal(record["reason"], "OpenCode 返回了空的 assistant 结果");
});

test("submitMessage 在 final 缺少 trigger 后会重新发完整回复要求", async () => {
  const userDataPath = createTempDir();
  const taskId = "task-submit-missing-trigger";
  initAppFileLogger(userDataPath);
  bindCurrentTaskLog(taskId);
  const { client } = createClient();
  const submittedContents: string[] = [];
  let postCount = 0;
  const result = await withMockedFetch((async (...args: Parameters<typeof fetch>) => {
    const pathname = new URL(String(args[0])).pathname;
    if (pathname === "/session/session-1/abort") {
      return new Response("", { status: 200 });
    }

    const options = args[1] as RequestInit;
    assert.equal(options.method, "POST");
    postCount += 1;
    const body = JSON.parse(options.body as string) as { parts: [{ text: string }] };
    assert.equal(body.parts.length, 1);
    submittedContents.push(body.parts[0].text);
    return createOpenCodeMessageResponse({
      id: `msg-${postCount}`,
      role: "assistant",
      text: postCount === 1 ? "<456> 非法判定" : "<continue>第三次恢复</continue>",
    });
  }) as unknown as typeof fetch, () =>
    withFastForwardedTimeouts(() => client.submitMessage("session-1", {
      agent: "TaskReview",
      runtimeAgent: "TaskReview-2",
      content: "请继续判定",
      allowedDecisionTriggers: ["<continue>", "<complete>"],
    })));

  assert.equal(result.finalMessage, "<continue>第三次恢复</continue>");
  assert.deepEqual(submittedContents, [
    "请继续判定",
    "生成完整回复",
  ]);
  const [record] = readTaskEventRecords(userDataPath, taskId, "opencode.submit_message_retried") as [Record<string, unknown>];
  assert.equal(record["agent"], "TaskReview");
  assert.equal(record["runtimeAgent"], "TaskReview-2");
  assert.equal(record["retryCount"], 0);
  assert.equal(record["reason"], "OpenCode 未返回需要的 trigger");
});

test("submitMessage 在 OpenCode error 消息后会记录错误并重新发消息", async () => {
  const userDataPath = createTempDir();
  const taskId = "task-submit-error-message";
  initAppFileLogger(userDataPath);
  bindCurrentTaskLog(taskId);
  const { client } = createClient();
  let postCount = 0;
  const result = await withMockedFetch((async (input: string | URL | Request) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname === "/session/session-1/abort") {
      return new Response("", { status: 200 });
    }

    postCount += 1;
    if (postCount === 1) {
      return new Response(JSON.stringify({
        info: {
          id: "msg-error",
          role: "assistant",
          time: {
            created: Date.parse("2026-05-07T00:00:00.000Z"),
            completed: Date.parse("2026-05-07T00:00:01.000Z"),
          },
          sessionID: "session-1",
          finish: "error",
          error: { message: "模型执行失败" },
        },
        parts: [{ type: "text", text: "不可用" }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return createOpenCodeMessageResponse({
      id: "msg-ok",
      role: "assistant",
      text: "已恢复",
    });
  }) as unknown as typeof fetch, () =>
    withFastForwardedTimeouts(() => client.submitMessage("session-1", {
      agent: "BA",
      runtimeAgent: "BA-1",
      content: "请整理需求",
      allowedDecisionTriggers: [],
    })));

  assert.equal(result.finalMessage, "已恢复");
  const [record] = readTaskEventRecords(userDataPath, taskId, "opencode.submit_message_retried") as [Record<string, unknown>];
  assert.equal(record["reason"], "OpenCode 最终消息包含错误");
});

test("session message 请求注入 5 分钟 AbortSignal，确保首次发送卡住后进入重试", async () => {
  const userDataPath = createTempDir();
  initAppFileLogger(userDataPath);
  bindCurrentTaskLog("task-message-timeout-signal");
  const { client } = createClient();
  const typed = client as OpenCodeClient & {
    request: (pathname: TestRequestPathname, options: TestRequestOptions) => TestRequestResult;
  };

  const fallbackSignal = new AbortController().signal;
  let capturedSignal: AbortSignal = fallbackSignal;
  await withMockedFetch((async (...args: Parameters<typeof fetch>) => {
    const requestInit = args[1];
    capturedSignal = typeof requestInit === "object"
      && requestInit
      && "signal" in requestInit
      && requestInit.signal instanceof AbortSignal
      ? requestInit.signal
      : fallbackSignal;
    return new Response("", { status: 200 });
  }) as unknown as typeof fetch, async () => {
    await typed.request("/session/session-1/message", {
      method: "POST",
      body: JSON.stringify({ parts: [] }),
    });
  });

  assert.notEqual(capturedSignal, fallbackSignal);
});

test("listSessionActivities 会保留工具参数中的 0 和 false", async () => {
  const { client } = createClient();
  client.request = async (pathname) => {
    assert.equal(pathname, "/session/session-1/message?limit=100");
    return new Response(JSON.stringify([{
      id: "msg-tool",
      role: "assistant",
      createdAt: "2026-04-21T12:52:26.000Z",
      completedAt: "2026-04-21T12:52:26.000Z",
      parts: [{
        type: "tool",
        tool: "grep",
        state: {
          input: {
            emptyObject: {},
            emptyValue: null,
            offset: 0,
            recursive: false,
            pattern: "TODO",
          },
        },
      }],
    }]), { status: 200 });
  };

  const activities = await client.listSessionActivities("session-1");

  assert.equal(activities.length, 1);
  const [activity] = activities as [OpenCodeSessionActivity];
  assert.equal(activity.kind, "tool");
  assert.equal(activity.detail, "参数: offset=0, recursive=false, pattern=TODO");
});

test("listSessionActivities 会重试直到拿到消息数组", async () => {
  const userDataPath = createTempDir();
  initAppFileLogger(userDataPath);
  bindCurrentTaskLog("task-list-activities-retry");
  const { client } = createClient();
  let requestCount = 0;
  const requestAt: number[] = [];
  const activities = await withMockedFetch((async () => {
    requestCount += 1;
    requestAt.push(Date.now());
    if (requestCount === 1) {
      throw new Error("OpenCode 请求超时: GET http://127.0.0.1:43127/session/session-1/message?limit=100 超过 30000ms");
    }
    return new Response(JSON.stringify([{
      id: "msg-tool-retry",
      role: "assistant",
      createdAt: "2026-04-21T12:52:26.000Z",
      completedAt: "2026-04-21T12:52:26.000Z",
      parts: [{
        type: "tool",
        tool: "grep",
        state: {
          input: {
            pattern: "TODO",
          },
        },
      }],
    }]), { status: 200 });
  }) as unknown as typeof fetch, () =>
    withFastForwardedTimeouts(() => client.listSessionActivities("session-1"), 120_000));

  assert.equal(activities.length, 1);
  const [activity] = activities as [OpenCodeSessionActivity];
  assert.equal(activity.kind, "tool");
  assert.equal(requestCount, 2);
  const retryAt = requestAt as [number, number];
  assert.deepEqual([retryAt[1] - retryAt[0]], [120_000]);
});

test("createSession 超时后不重启 runtime，并持续重试直到拿到 session id", async () => {
  const userDataPath = createTempDir();
  initAppFileLogger(userDataPath);
  bindCurrentTaskLog("task-create-session-timeout-retry");
  const { client } = createClient();
  let requestCount = 0;
  const sessionId = await withMockedFetch((async () => {
    requestCount += 1;
    if (requestCount === 1) {
      throw new Error("OpenCode 请求超时: POST http://127.0.0.1:43127/session 超过 30000ms");
    }
    return new Response(JSON.stringify({ id: "session-after-timeout" }), { status: 200 });
  }) as unknown as typeof fetch, () =>
    withFastForwardedTimeouts(() => client.createSession("demo"), 120_000));

  assert.equal(sessionId, "session-after-timeout");
  assert.equal(requestCount, 2);
});

test("getAttachBaseUrl 只读取已经启动的 serve 地址", async () => {
  const client = new OpenCodeClient({
    server: createDetachedServeHandle(43128),
  });
  const baseUrl = await client.getAttachBaseUrl();

  assert.equal(baseUrl, "http://127.0.0.1:43128");
});
