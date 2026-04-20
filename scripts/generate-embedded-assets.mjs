import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = path.join(repoRoot, "dist", "web");
const outputPath = path.join(repoRoot, "cli", "generated-embedded-assets.ts");

function walkFiles(rootDir) {
  const queue = [rootDir];
  const files = [];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const nextPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(nextPath);
        continue;
      }
      files.push(nextPath);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

if (!fs.existsSync(path.join(webRoot, "index.html"))) {
  throw new Error(`网页构建产物不存在：${webRoot}`);
}

const webAssets = walkFiles(webRoot).map((filePath) => ({
  relativePath: path.relative(webRoot, filePath).replace(/\\/g, "/"),
  base64: fs.readFileSync(filePath).toString("base64"),
}));

const lines = [
  "export interface EmbeddedWebAsset {",
  "  relativePath: string;",
  "  base64: string;",
  "}",
  "",
];

lines.push("export const EMBEDDED_WEB_ASSETS: EmbeddedWebAsset[] = [");
for (const asset of webAssets) {
  lines.push("  {");
  lines.push(`    relativePath: ${JSON.stringify(asset.relativePath)},`);
  lines.push(`    base64: ${JSON.stringify(asset.base64)},`);
  lines.push("  },");
}
lines.push("];");
lines.push("");

fs.writeFileSync(outputPath, `${lines.join("\n")}`, "utf8");
