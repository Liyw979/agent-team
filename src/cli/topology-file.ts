import fs from "node:fs";
import path from "node:path";
import { parseJson5 } from "@shared/json5";

const SUPPORTED_TOPOLOGY_FILE_EXTENSIONS = new Set([".json5"]);

export function isSupportedTopologyFile(filePath: string): boolean {
  return SUPPORTED_TOPOLOGY_FILE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function assertSupportedTopologyFile(file: string): string {
  const resolved = path.resolve(file);
  if (!isSupportedTopologyFile(resolved)) {
    throw new Error(`团队拓扑文件必须是 .json5：${resolved}`);
  }
  return resolved;
}

export function loadTeamDslDefinitionFile<T = unknown>(file: string): T {
  const resolved = assertSupportedTopologyFile(file);
  return parseJson5<T>(fs.readFileSync(resolved, "utf8"));
}
