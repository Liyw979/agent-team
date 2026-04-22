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
    "bun run build && bun build --compile --target bun-darwin-arm64 ./cli/index.ts --outfile ./dist/agent-team-macos-arm64",
  );
  assert.equal(
    PACKAGE_JSON.scripts?.["dist:mac-x64"],
    "bun run build && bun build --compile --target bun-darwin-x64 ./cli/index.ts --outfile ./dist/agent-team-macos-x64",
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

test("AGENTS.md 记录漏洞团队初筛先连反方的拓扑设计技巧", () => {
  assert.match(AGENTS_MD, /初筛.*反方/);
  assert.match(AGENTS_MD, /先质疑.*再进入正反对抗|先由反方挑战.*再进入正反对抗/);
});

test("AGENTS.md 记录漏洞团队结论前必须先阅读代码找支撑", () => {
  assert.match(AGENTS_MD, /先阅读当前项目代码.*作为支撑后才能下结论/);
  assert.match(AGENTS_MD, /不能只根据上游口头材料直接裁定/);
});
