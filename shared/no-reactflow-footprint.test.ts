import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function collectReactFlowFootprints(input: {
  packageJson: string;
  mainEntry: string;
}) {
  const issues: string[] = [];

  if (/"@xyflow\/react"\s*:/.test(input.packageJson)) {
    issues.push("package.json 仍声明 @xyflow/react 依赖");
  }

  if (/xyflow\/react\/dist\/style\.css/.test(input.mainEntry)) {
    issues.push("src/main.tsx 仍导入 React Flow 样式");
  }

  return issues;
}

test("仓库不再残留 React Flow 足迹", () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const packageJson = fs.readFileSync(path.join(repoRoot, "package.json"), "utf8");
  const mainEntry = fs.readFileSync(path.join(repoRoot, "src", "main.tsx"), "utf8");

  assert.deepEqual(
    collectReactFlowFootprints({
      packageJson,
      mainEntry,
    }),
    [],
  );
});
