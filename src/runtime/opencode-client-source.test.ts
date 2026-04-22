import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const OPENCODE_CLIENT_SOURCE = fs.readFileSync(new URL("./opencode-client.ts", import.meta.url), "utf8");

test("OpenCode serve 启动进程时会把目标工作区作为 cwd 传入", () => {
  assert.match(OPENCODE_CLIENT_SOURCE, /spawn\(\s*[\s\S]*?\{\s*cwd: state\.projectPath,/);
});

test("OpenCode serve 启动进程时不再注入 OPENCODE_CONFIG_DIR，避免 /session 卡死", () => {
  assert.doesNotMatch(OPENCODE_CLIENT_SOURCE, /serverEnv\.OPENCODE_CONFIG_DIR\s*=/);
});

test("OpenCode serve 启动进程时不再注入 OPENCODE_DB，避免 agent-team 额外落盘 runtime 数据库", () => {
  assert.doesNotMatch(OPENCODE_CLIENT_SOURCE, /serverEnv\.OPENCODE_DB\s*=/);
});

test("OpenCode serve 启动进程时不再显式传入 --port，改为解析实际监听地址", () => {
  assert.doesNotMatch(OPENCODE_CLIENT_SOURCE, /["']--port["']/);
});

test("OpenCode serve 在 Windows 不再硬编码 cmd.exe，而是走可解析的系统 shell 路径", () => {
  assert.doesNotMatch(OPENCODE_CLIENT_SOURCE, /command:\s*"cmd\.exe"/);
});

test("配置变化时不再触发 scheduleShutdown 重启链路", () => {
  assert.doesNotMatch(OPENCODE_CLIENT_SOURCE, /scheduleShutdown\s*\(/);
});

test("createSession 超时后不再 shutdown 后自动重试", () => {
  assert.doesNotMatch(OPENCODE_CLIENT_SOURCE, /create_session_timed_out/);
  assert.doesNotMatch(OPENCODE_CLIENT_SOURCE, /await this\.shutdown\(normalized\.runtimeKey\)/);
  assert.doesNotMatch(OPENCODE_CLIENT_SOURCE, /isRequestTimeoutError\s*\(/);
});
