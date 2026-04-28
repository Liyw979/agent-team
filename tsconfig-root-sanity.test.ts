import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { parseJson5 } from "./src/shared/json5";

const ROOT_TSCONFIG = parseJson5<{
  compilerOptions?: {
    allowUnreachableCode?: boolean;
    allowUnusedLabels?: boolean;
    exactOptionalPropertyTypes?: boolean;
    noFallthroughCasesInSwitch?: boolean;
    noImplicitOverride?: boolean;
    noImplicitReturns?: boolean;
    noPropertyAccessFromIndexSignature?: boolean;
    noUncheckedIndexedAccess?: boolean;
    noUnusedLocals?: boolean;
    noUnusedParameters?: boolean;
    strict?: boolean;
    types?: string[];
  };
  include?: string[];
  references?: Array<{ path?: string }>;
}>(
  fs.readFileSync(new URL("./tsconfig.json", import.meta.url), "utf8"),
);

test("根 tsconfig 同时承担 node 与 web 类型检查", () => {
  assert.deepEqual(ROOT_TSCONFIG.compilerOptions?.types ?? [], [
    "node",
    "vite/client",
  ]);
});

test("根 tsconfig 开启严格类型检查选项，避免常见运行时问题漏过编译期", () => {
  assert.equal(ROOT_TSCONFIG.compilerOptions?.strict, true);
  assert.equal(ROOT_TSCONFIG.compilerOptions?.noUnusedLocals, true);
  assert.equal(ROOT_TSCONFIG.compilerOptions?.noUnusedParameters, true);
  assert.equal(ROOT_TSCONFIG.compilerOptions?.noImplicitReturns, true);
  assert.equal(ROOT_TSCONFIG.compilerOptions?.noFallthroughCasesInSwitch, true);
  assert.equal(ROOT_TSCONFIG.compilerOptions?.noUncheckedIndexedAccess, true);
  assert.equal(ROOT_TSCONFIG.compilerOptions?.exactOptionalPropertyTypes, true);
  assert.equal(ROOT_TSCONFIG.compilerOptions?.noPropertyAccessFromIndexSignature, true);
  assert.equal(ROOT_TSCONFIG.compilerOptions?.noImplicitOverride, true);
  assert.equal(ROOT_TSCONFIG.compilerOptions?.allowUnusedLabels, false);
  assert.equal(ROOT_TSCONFIG.compilerOptions?.allowUnreachableCode, false);
});

test("根 tsconfig 直接包含仓库源码与测试", () => {
  assert.notDeepEqual(ROOT_TSCONFIG.include ?? [], []);
});

test("仓库不再依赖拆分的 node/web tsconfig references", () => {
  assert.deepEqual(ROOT_TSCONFIG.references ?? [], []);
});

test("仓库不再保留 tsconfig.node.json 与 tsconfig.web.json", () => {
  assert.equal(fs.existsSync(new URL("./tsconfig.node.json", import.meta.url)), false);
  assert.equal(fs.existsSync(new URL("./tsconfig.web.json", import.meta.url)), false);
});
