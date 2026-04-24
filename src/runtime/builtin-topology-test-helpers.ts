import fs from "node:fs";

import { compileTeamDsl, type TeamDslDefinition } from "./team-dsl";

const BUILTIN_TOPOLOGY_DIR = new URL("../../config/team-topologies/", import.meta.url);

export function readBuiltinTopology(fileName: string): TeamDslDefinition {
  return JSON.parse(
    fs.readFileSync(new URL(fileName, BUILTIN_TOPOLOGY_DIR), "utf8"),
  ) as TeamDslDefinition;
}

export function readBuiltinVulnerabilityTopology(): TeamDslDefinition {
  return readBuiltinTopology("vulnerability-team.topology.json");
}

export function compileBuiltinTopology(fileName: string) {
  return compileTeamDsl(readBuiltinTopology(fileName));
}

export function compileBuiltinVulnerabilityTopology() {
  return compileBuiltinTopology("vulnerability-team.topology.json");
}
