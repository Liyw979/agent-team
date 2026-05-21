import * as childProcess from "node:child_process";

type ProcessOutput =
  | {
      kind: "present";
      message: string;
    }
  | {
      kind: "absent";
    };

function readProcessOutput(value: unknown): ProcessOutput {
  if (typeof value === "string" && value.trim().length > 0) {
    return {
      kind: "present",
      message: value.trim(),
    };
  }
  return {
    kind: "absent",
  };
}

function collectProcessOutputMessages(outputs: ProcessOutput[]): string[] {
  return outputs.flatMap((output) => output.kind === "present" ? [output.message] : []);
}

export async function ensureOpencodePreflightPassed() {
  const result = childProcess.spawnSync("opencode", ["--help"], {
    encoding: "utf8",
    windowsHide: true,
    shell: true,
    env: process.env,
  });

  const exitStatus = typeof result.status === "number" ? result.status : -1;
  if (!result.error && exitStatus === 0) {
    return;
  }
  const outputMessages = collectProcessOutputMessages([
    readProcessOutput(result.stderr),
    readProcessOutput(result.stdout),
  ]);
  const errorMessage = result.error
    ? result.error.message.trim()
    : outputMessages.length > 0
      ? outputMessages.join("\n")
      : `退出码 ${exitStatus}`;
  throw new Error(`\`opencode --help\` 执行失败（${errorMessage}），说明 opencode 无法正常使用，无法启动本应用`);
}
