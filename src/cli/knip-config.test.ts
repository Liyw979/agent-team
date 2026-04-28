import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { parseJson5 } from "@shared/json5";

const KNIP_CONFIG_PATH = new URL("../../knip.json", import.meta.url);

test("knip 配置会把所有 .test.tsx 文件纳入入口，避免 React 测试被误判为未使用文件", () => {
  const config = parseJson5<{
    entry?: string[];
  }>(fs.readFileSync(KNIP_CONFIG_PATH, "utf8"));

  assert.deepEqual(config.entry?.includes("src/**/*.test.tsx"), true);
});
