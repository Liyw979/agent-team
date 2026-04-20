#!/usr/bin/env node

const { spawn } = require("node:child_process");
const path = require("node:path");
const { buildCliLauncherSpec } = require("./launcher-spec.cjs");

const repoRoot = path.resolve(__dirname, "../..");
const spec = buildCliLauncherSpec({
  nodeBinary: process.execPath,
  repoRoot,
  argv: process.argv.slice(2),
  env: process.env,
});

const child = spawn(spec.command, spec.args, {
  cwd: spec.cwd,
  env: spec.env,
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
