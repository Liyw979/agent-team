import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { bindCurrentTaskLog, buildTaskLogFilePath, initAppFileLogger } from "./app-log";
import { OpenCodeClient, type ServeHandle } from "./opencode-client";

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

function readTaskEventRecords(userDataPath: string, taskId: string, event: string): Record<string, unknown>[] {
  return fs.readFileSync(buildTaskLogFilePath(userDataPath, taskId), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
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
  await withFastForwardedTimeouts(async () => {
    const { client } = createClient();
    const typed = client as OpenCodeClient & {
      request: (pathname: TestRequestPathname, options: TestRequestOptions) => TestRequestResult;
    };

    const originalFetch = globalThis.fetch;
    let requestedUrl = "";
    globalThis.fetch = (async (input: string | URL | Request) => {
      requestedUrl = String(input);
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;

    try {
      await typed.request("/session", {
        method: "GET",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(requestedUrl, "http://127.0.0.1:43127/session");
  }, 1);
});

test("request 失败时会写入 task 级失败日志", async () => {
  const userDataPath = createTempDir();
  initAppFileLogger(userDataPath);
  bindCurrentTaskLog("task-request-failed");
  const { client } = createClient();
  const typed = client as OpenCodeClient & {
    request: (pathname: TestRequestPathname, options: TestRequestOptions) => TestRequestResult;
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("boom task-request-failed");
  }) as unknown as typeof fetch;

  try {
    await assert.rejects(
      typed.request("/session", {
        method: "GET",
      }),
      /boom task-request-failed/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  const logFilePath = buildTaskLogFilePath(userDataPath, "task-request-failed");
  const records = fs.readFileSync(logFilePath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(records.length, 1);
  const latestRecord = records[0]!;
  assert.equal(latestRecord["event"], "opencode.request_failed");
  assert.equal(latestRecord["taskId"], "task-request-failed");
});

test("submitMessage 在空响应体或空对象响应时会在原地重试直到拿到有效消息实体", async () => {
  const userDataPath = createTempDir();
  const taskId = "task-submit-empty-response";
  initAppFileLogger(userDataPath);
  bindCurrentTaskLog(taskId);
  const { client } = createClient();
  let requestCount = 0;
  client.request = async (pathname) => {
    if (pathname === "/session/session-1/abort") {
      return new Response("", { status: 200 });
    }

    requestCount += 1;
    return requestCount === 1
      ? new Response("", { status: 200 })
      : requestCount === 2
        ? new Response(JSON.stringify({ info: {}, }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
      : createOpenCodeMessageResponse({
          role: "assistant",
          id: "msg-1",
          text: "已发送",
        });
  };
  const { result, stdout } = await captureStdout(() =>
    withFastForwardedTimeouts(() => client.submitMessage("session-1", {
      agent: "BA",
      runtimeAgent: "BA-1",
      content: "请整理需求",
      allowedDecisionTriggers: [],
    })),
  );
  assert.equal(result.finalMessage, "已发送");
  assert.equal(requestCount, 3);
  const stdoutRecords = stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(
    stdoutRecords
      .filter((record) => record["event"] === "opencode.submit_message_retried")
      .map((record) => record["reason"]),
    ["OpenCode 提交消息响应缺少有效的消息实体", "OpenCode 提交消息响应缺少有效的消息实体"],
  );
  const records = readTaskEventRecords(userDataPath, taskId, "opencode.submit_message_retried");
  assert.equal(records.length, 2);
  const [firstRetryRecord, secondRetryRecord] = records;
  assert.ok(firstRetryRecord);
  assert.ok(secondRetryRecord);
  assert.equal(firstRetryRecord["level"], "warn");
  assert.equal(firstRetryRecord["agent"], "BA");
  assert.equal(firstRetryRecord["runtimeAgent"], "BA-1");
  assert.equal(firstRetryRecord["retryCount"], 0);
  assert.equal(firstRetryRecord["nextRetryCount"], 1);
  assert.equal(firstRetryRecord["nextContent"], "生成完整回复");
  assert.equal(firstRetryRecord["reason"], "OpenCode 提交消息响应缺少有效的消息实体");
  assert.equal(secondRetryRecord["reason"], "OpenCode 提交消息响应缺少有效的消息实体");
});

test("submitMessage 失败后会先立刻重试一次，再按 2 分钟间隔继续重试", async () => {
  const userDataPath = createTempDir();
  const taskId = "task-submit-request-failed";
  initAppFileLogger(userDataPath);
  bindCurrentTaskLog(taskId);
  const { client } = createClient();
  let requestCount = 0;
  const requestAt: number[] = [];
  client.request = async (pathname) => {
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
  };
  const { result, stdout } = await captureStdout(() =>
    withFastForwardedTimeouts(() => client.submitMessage("session-1", {
      agent: "BA",
      runtimeAgent: "BA-1",
      content: "请整理需求",
      allowedDecisionTriggers: [],
    }), 120_000),
  );

  assert.equal(result.finalMessage, "已恢复提交");
  assert.equal(requestCount, 3);
  const requestRetryAt = requestAt as [number, number, number];
  assert.deepEqual([requestRetryAt[1] - requestRetryAt[0], requestRetryAt[2] - requestRetryAt[1]], [0, 120_000]);
  const stdoutRecords = stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(
    stdoutRecords
      .filter((record) => record["event"] === "opencode.submit_message_retried")
      .map((record) => record["reason"]),
    ["OpenCode 请求失败: 500", "Error: fetch failed"],
  );
  const records = readTaskEventRecords(userDataPath, taskId, "opencode.submit_message_retried");
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((record) => record["reason"]), ["OpenCode 请求失败: 500", "Error: fetch failed"]);
  assert.deepEqual(records.map((record) => record["runtimeAgent"]), ["BA-1", "BA-1"]);
  assert.deepEqual(records.map((record) => record["retryCount"]), [0, 1]);
  assert.deepEqual(
    readTaskEventRecords(userDataPath, taskId, "opencode.submit_message_failed")
      .map((record) => [record["status"], record["runtimeAgent"], record["retryCount"]]),
    [[500, "BA-1", 0]],
  );
  assert.deepEqual(
    readTaskEventRecords(userDataPath, taskId, "opencode.submit_message_request_error")
      .map((record) => [record["message"], record["runtimeAgent"], record["retryCount"]]),
    [["Error: fetch failed", "BA-1", 1]],
  );
});

test("submitMessage 重试前会先调用 session abort 接口", async () => {
  const { client } = createClient();
  const requestPathnames: string[] = [];
  const submittedContents: string[] = [];
  let messageRequestCount = 0;

  client.request = async (pathname, options) => {
    requestPathnames.push(pathname);
    if (pathname === "/session/session-1/abort") {
      assert.equal(options.method, "POST");
      assert.equal(options.body, "");
      return new Response("", { status: 200 });
    }

    messageRequestCount += 1;
    if (options.method !== "POST") {
      throw new Error("submitMessage 不应发起非 POST 请求");
    }
    const body = JSON.parse(options.body) as { parts: [{ text: string }] };
    submittedContents.push(body.parts[0].text);
    return messageRequestCount === 1
      ? new Response("server error", { status: 500 })
      : createOpenCodeMessageResponse({
          role: "assistant",
          id: "msg-2",
          text: "已恢复提交",
        });
  };

  const result = await withFastForwardedTimeouts(() => client.submitMessage("session-1", {
    agent: "BA",
    runtimeAgent: "BA-1",
    content: "请整理需求",
    allowedDecisionTriggers: [],
  }));

  assert.equal(result.finalMessage, "已恢复提交");
  assert.deepEqual(requestPathnames, [
    "/session/session-1/message",
    "/session/session-1/abort",
    "/session/session-1/message",
  ]);
  assert.deepEqual(submittedContents, ["请整理需求", "生成完整回复"]);
});

test("submitMessage abort 失败时不会继续重试 message", async () => {
  const userDataPath = createTempDir();
  const taskId = "task-submit-abort-failed";
  initAppFileLogger(userDataPath);
  bindCurrentTaskLog(taskId);
  const { client } = createClient();
  const requestPathnames: string[] = [];

  client.request = async (pathname) => {
    requestPathnames.push(pathname);
    return pathname === "/session/session-1/abort"
      ? new Response("abort failed", { status: 500, statusText: "Internal Server Error" })
      : new Response("server error", { status: 500 });
  };

  await assert.rejects(
    withFastForwardedTimeouts(() => client.submitMessage("session-1", {
      agent: "BA",
      runtimeAgent: "BA-1",
      content: "请整理需求",
      allowedDecisionTriggers: [],
    })),
    /OpenCode 中止 session 失败: 500/,
  );

  assert.deepEqual(requestPathnames, [
    "/session/session-1/message",
    "/session/session-1/abort",
  ]);
  assert.deepEqual(
    readTaskEventRecords(userDataPath, taskId, "opencode.abort_session_failed")
      .map((record) => [record["sessionId"], record["status"], record["statusText"]]),
    [["session-1", 500, "Internal Server Error"]],
  );
  assert.equal(readTaskEventRecords(userDataPath, taskId, "opencode.submit_message_retried").length, 0);
});

test("submitMessage abort 请求异常时会记录失败并停止重试", async () => {
  const userDataPath = createTempDir();
  const taskId = "task-submit-abort-error";
  initAppFileLogger(userDataPath);
  bindCurrentTaskLog(taskId);
  const { client } = createClient();
  const requestPathnames: string[] = [];

  client.request = async (pathname) => {
    requestPathnames.push(pathname);
    if (pathname === "/session/session-1/abort") {
      throw new Error("abort fetch failed");
    }
    return new Response("server error", { status: 500 });
  };

  await assert.rejects(
    withFastForwardedTimeouts(() => client.submitMessage("session-1", {
      agent: "BA",
      runtimeAgent: "BA-1",
      content: "请整理需求",
      allowedDecisionTriggers: [],
    })),
    /abort fetch failed/,
  );

  assert.deepEqual(requestPathnames, [
    "/session/session-1/message",
    "/session/session-1/abort",
  ]);
  assert.deepEqual(
    readTaskEventRecords(userDataPath, taskId, "opencode.abort_session_failed")
      .map((record) => [record["sessionId"], record["message"]]),
    [["session-1", "abort fetch failed"]],
  );
  assert.equal(readTaskEventRecords(userDataPath, taskId, "opencode.submit_message_retried").length, 0);
});

test("submitMessage 首次发送 5 分钟超时后会立刻重试", async () => {
  const userDataPath = createTempDir();
  const taskId = "task-submit-message-timeout";
  initAppFileLogger(userDataPath);
  bindCurrentTaskLog(taskId);
  const { client } = createClient();
  const requestPathnames: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const url = args[0] instanceof Request ? args[0].url : String(args[0]);
    const pathname = new URL(url).pathname;
    requestPathnames.push(pathname);
    if (pathname === "/session/session-1/message" && requestPathnames.length === 1) {
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
  }) as unknown as typeof fetch;

  try {
    const result = await withFastForwardedTimeouts(() => client.submitMessage("session-1", {
      agent: "BA",
      runtimeAgent: "BA-1",
      content: "请整理需求",
      allowedDecisionTriggers: [],
    }), 300_000);

    assert.equal(result.finalMessage, "已恢复提交");
    assert.deepEqual(requestPathnames, [
      "/session/session-1/message",
      "/session/session-1/abort",
      "/session/session-1/message",
    ]);
    assert.deepEqual(
      readTaskEventRecords(userDataPath, taskId, "opencode.submit_message_retried")
        .map((record) => [record["runtimeAgent"], record["retryCount"], record["nextRetryCount"]]),
      [["BA-1", 0, 1]],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("submitMessage 正常完成时不打印 submitMessage 日志，且最终请求体不注入 system 字段", async () => {
  const userDataPath = createTempDir();
  const taskId = "task-submit-success";
  initAppFileLogger(userDataPath);
  bindCurrentTaskLog(taskId);
  const { client } = createClient();
  let capturedBody = "";
  client.request = async (_pathname, options) => {
    capturedBody = options.method === "POST" ? options.body : "";
    return createOpenCodeMessageResponse({
      role: "assistant",
      id: "msg-1",
      text: "已完成",
    });
  };

  const { stdout } = await captureStdout(() => client.submitMessage("session-1", {
    agent: "TaskReview",
    runtimeAgent: "TaskReview",
    content: "请继续判定",
    allowedDecisionTriggers: [],
  }));

  assert.equal(stdout, "");
  assert.deepEqual(readTaskRecords(userDataPath, taskId), []);
  assert.notEqual(capturedBody, "");
  assert.equal(capturedBody.includes("\"system\""), false);
  assert.deepEqual(JSON.parse(capturedBody), {
    agent: "TaskReview",
    parts: [{ type: "text", text: "请继续判定" }],
  });
});

test("submitMessage 在空 assistant final 后会重新发消息", async () => {
  const userDataPath = createTempDir();
  const taskId = "task-submit-empty-final";
  initAppFileLogger(userDataPath);
  bindCurrentTaskLog(taskId);
  const { client } = createClient();
  const submittedContents: string[] = [];
  let postCount = 0;
  client.request = async (pathname, options) => {
    if (pathname === "/session/session-1/abort") {
      return new Response("", { status: 200 });
    }

    if (options.method === "POST") {
      postCount += 1;
      const body = JSON.parse(options.body) as { parts: [{ text: string }] };
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
    }
    throw new Error("不应该发起 GET final 请求");
  };

  const result = await withFastForwardedTimeouts(() => client.submitMessage("session-1", {
    agent: "BA",
    runtimeAgent: "BA-1",
    content: "请整理需求",
    allowedDecisionTriggers: [],
  }));

  assert.equal(result.finalMessage, "已恢复正式回复");
  assert.deepEqual(submittedContents, ["请整理需求", "生成完整回复"]);
  const records = readTaskEventRecords(userDataPath, taskId, "opencode.execution_empty_final");
  assert.equal(records.length, 1);
  assert.equal(records[0]?.["messageId"], "msg-empty");
});

test("submitMessage 在 final 缺少 trigger 后会重新发完整回复要求", async () => {
  const userDataPath = createTempDir();
  const taskId = "task-submit-missing-trigger";
  initAppFileLogger(userDataPath);
  bindCurrentTaskLog(taskId);
  const { client } = createClient();
  const submittedContents: string[] = [];
  let postCount = 0;
  client.request = async (pathname, options) => {
    if (pathname === "/session/session-1/abort") {
      return new Response("", { status: 200 });
    }

    if (options.method === "POST") {
      postCount += 1;
      const body = JSON.parse(options.body) as { parts: [{ text: string }] };
      assert.equal(body.parts.length, 1);
      submittedContents.push(body.parts[0].text);
      return createOpenCodeMessageResponse({
        id: `msg-${postCount}`,
        role: "assistant",
        text: postCount === 1 ? "<456> 非法判定" : "<continue>第三次恢复</continue>",
      });
    }
    throw new Error("不应该发起 GET final 请求");
  };

  const result = await withFastForwardedTimeouts(() => client.submitMessage("session-1", {
    agent: "TaskReview",
    runtimeAgent: "TaskReview-2",
    content: "请继续判定",
    allowedDecisionTriggers: ["<continue>", "<complete>"],
  }));

  assert.equal(result.finalMessage, "<continue>第三次恢复</continue>");
  assert.deepEqual(submittedContents, [
    "请继续判定",
    "生成完整回复",
  ]);
  const records = readTaskEventRecords(userDataPath, taskId, "opencode.submit_message_missing_trigger");
  assert.equal(records.length, 1);
  assert.equal(records[0]?.["agent"], "TaskReview");
  assert.equal(records[0]?.["runtimeAgent"], "TaskReview-2");
  assert.equal(records[0]?.["retryCount"], 0);
  assert.equal(records[0]?.["messageId"], "msg-1");
  assert.deepEqual(records[0]?.["allowedDecisionTriggers"], ["<continue>", "<complete>"]);
});

test("submitMessage 在 OpenCode error 消息后会记录错误并重新发消息", async () => {
  const userDataPath = createTempDir();
  const taskId = "task-submit-error-message";
  initAppFileLogger(userDataPath);
  bindCurrentTaskLog(taskId);
  const { client } = createClient();
  let postCount = 0;
  client.request = async (pathname) => {
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
  };

  const result = await withFastForwardedTimeouts(() => client.submitMessage("session-1", {
    agent: "BA",
    runtimeAgent: "BA-1",
    content: "请整理需求",
    allowedDecisionTriggers: [],
  }));

  assert.equal(result.finalMessage, "已恢复");
  const records = readTaskEventRecords(userDataPath, taskId, "opencode.execution_error_message");
  assert.equal(records.length, 1);
  assert.equal(records[0]?.["messageId"], "msg-error");
  assert.equal(records[0]?.["reason"], "模型执行失败");
});

test("createSession throws when the response is missing a session id", async () => {
  const { client } = createClient();
  client.request = async () => new Response("", { status: 200 });

  await assert.rejects(
    client.createSession("demo"),
    /session id/,
  );
});

test("createSession logs invalid responses into the task log file", async () => {
  const userDataPath = createTempDir();
  const taskId = "task-123";
  initAppFileLogger(userDataPath);
  bindCurrentTaskLog(taskId);

  const client = new OpenCodeClient({
    server: createDetachedServeHandle(43127),
  }) as OpenCodeClient & {
    request: (pathname: TestRequestPathname, options: TestRequestOptions) => TestRequestResult;
  };
  client.request = async () => new Response("", { status: 200 });

  await assert.rejects(
    client.createSession("demo"),
    /session id/,
  );

  const lines = fs.readFileSync(buildTaskLogFilePath(userDataPath, taskId), "utf8").trim().split("\n");
  const record = JSON.parse(lines.at(-1) || "{}") as Record<string, unknown>;
  assert.equal(record["event"], "opencode.create_session_invalid_response");
  assert.equal(record["taskId"], taskId);
});

test("createSession 在响应体不是合法 JSON 时仍走 invalid response 分支并记录日志", async () => {
  const userDataPath = createTempDir();
  const taskId = "task-malformed";
  initAppFileLogger(userDataPath);
  bindCurrentTaskLog(taskId);

  const client = new OpenCodeClient({
    server: createDetachedServeHandle(43127),
  }) as OpenCodeClient & {
    request: (pathname: TestRequestPathname, options: TestRequestOptions) => TestRequestResult;
  };
  client.request = async () => new Response("oops", { status: 200 });

  await assert.rejects(
    client.createSession("demo"),
    /session id/,
  );

  const lines = fs.readFileSync(buildTaskLogFilePath(userDataPath, taskId), "utf8").trim().split("\n");
  const record = JSON.parse(lines.at(-1) || "{}") as Record<string, unknown>;
  assert.equal(record["event"], "opencode.create_session_invalid_response");
  assert.equal(record["taskId"], taskId);
});

test("session message 请求注入 5 分钟 AbortSignal，确保首次发送卡住后进入重试", async () => {
  const { client } = createClient();
  const typed = client as OpenCodeClient & {
    request: (pathname: TestRequestPathname, options: TestRequestOptions) => TestRequestResult;
  };

  const originalFetch = globalThis.fetch;
  const fallbackSignal = new AbortController().signal;
  let capturedSignal: AbortSignal = fallbackSignal;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const requestInit = args[1];
    capturedSignal = typeof requestInit === "object"
      && requestInit
      && "signal" in requestInit
      && requestInit.signal instanceof AbortSignal
      ? requestInit.signal
      : fallbackSignal;
    return new Response("", { status: 200 });
  }) as unknown as typeof fetch;

  try {
    await typed.request("/session/session-1/message", {
      method: "POST",
      body: JSON.stringify({ parts: [] }),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

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
  assert.equal(activities[0]?.kind, "tool");
  assert.equal(activities[0]?.detail, "参数: offset=0, recursive=false, pattern=TODO");
});

test("createSession 超时后不应重启 runtime，也不应自动重试", async () => {
  const { client } = createClient();
  const typed = client as OpenCodeClient & {
    request: (pathname: TestRequestPathname, options: TestRequestOptions) => TestRequestResult;
  };

  let requestCount = 0;
  typed.request = async () => {
    requestCount += 1;
    throw new Error("OpenCode 请求超时: POST http://127.0.0.1:43127/session 超过 12000ms");
  };

  await assert.rejects(
    client.createSession("demo"),
    /请求超时/,
  );
  assert.equal(requestCount, 1);
});

test("getAttachBaseUrl 只读取已经启动的 serve 地址", async () => {
  const client = new OpenCodeClient({
    server: createDetachedServeHandle(43128),
  });
  const baseUrl = await client.getAttachBaseUrl();

  assert.equal(baseUrl, "http://127.0.0.1:43128");
});
