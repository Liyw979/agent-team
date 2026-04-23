import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const PACKAGE_JSON = JSON.parse(
  fs.readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as {
  scripts?: Record<string, string>;
};

const AGENTS_MD = fs.readFileSync(new URL("./AGENTS.md", import.meta.url), "utf8");

test("package.json 提供 macOS 打包入口", () => {
  assert.equal(
    PACKAGE_JSON.scripts?.["dist:mac-arm64"],
    "bun run build && bun build --compile --target bun-darwin-arm64 ./src/cli/index.ts --outfile ./dist/agent-team-macos-arm64",
  );
  assert.equal(
    PACKAGE_JSON.scripts?.["dist:mac-x64"],
    "bun run build && bun build --compile --target bun-darwin-x64 ./src/cli/index.ts --outfile ./dist/agent-team-macos-x64",
  );
});

test("AGENTS.md 同步记录 macOS 打包产物", () => {
  assert.match(AGENTS_MD, /bun run dist:mac-arm64/);
  assert.match(AGENTS_MD, /bun run dist:mac-x64/);
  assert.match(AGENTS_MD, /dist\/agent-team-macos-arm64/);
  assert.match(AGENTS_MD, /dist\/agent-team-macos-x64/);
});

test("AGENTS.md 记录前端修改后需要执行 bun run build 刷新最新 UI", () => {
  assert.match(AGENTS_MD, /bun run build/);
  assert.match(AGENTS_MD, /每次修改.*bun run build|修改.*需要执行 `bun run build`/);
  assert.match(AGENTS_MD, /dist\/web/);
});

test("AGENTS.md 记录交付前需要先运行 bun tsc --noEmit", () => {
  assert.match(AGENTS_MD, /bun tsc --noEmit/);
  assert.match(AGENTS_MD, /类型检查通过作为交付前置条件|交付前.*bun tsc --noEmit/);
});

test("AGENTS.md 交付前检查移除旧的 bun test 描述，并改为 bun test --only-failures 与 bun run knip --fix", () => {
  assert.doesNotMatch(
    AGENTS_MD,
    /每次交付前必须在仓库根目录运行 `bun test`，并以测试通过作为交付前置条件。/,
  );
  assert.match(AGENTS_MD, /bun test --only-failures/);
  assert.match(AGENTS_MD, /bun run knip --fix/);
});

test("AGENTS.md 记录漏洞团队线索发现先连漏洞挑战的拓扑设计技巧", () => {
  assert.match(AGENTS_MD, /线索发现.*漏洞挑战/);
  assert.match(AGENTS_MD, /漏洞挑战暴露证据链缺口.*论证与挑战对抗/);
});

test("AGENTS.md 记录漏洞团队结论前必须先阅读代码找支撑", () => {
  assert.match(AGENTS_MD, /先阅读当前项目代码.*作为支撑后才能下结论/);
  assert.match(AGENTS_MD, /不能只根据上游口头材料直接裁定/);
});
