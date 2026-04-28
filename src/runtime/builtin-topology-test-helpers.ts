import fs from "node:fs";
import { parseJson5 } from "@shared/json5";

import { compileTeamDsl, type TeamDslDefinition } from "./team-dsl";

const BUILTIN_TOPOLOGY_DIR = new URL("../../config/team-topologies/", import.meta.url);

export function readBuiltinTopology(fileName: string): TeamDslDefinition {
  return parseJson5<TeamDslDefinition>(
    fs.readFileSync(new URL(fileName, BUILTIN_TOPOLOGY_DIR), "utf8"),
  );
}

export function readBuiltinVulnerabilityTopology(): TeamDslDefinition {
  return readBuiltinTopology("vulnerability-team.topology.json5");
}

export function compileBuiltinTopology(fileName: string) {
  return compileTeamDsl(readBuiltinTopology(fileName));
}

export function compileBuiltinVulnerabilityTopology() {
  return compileBuiltinTopology("vulnerability-team.topology.json5");
}
