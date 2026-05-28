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

export async function ensureOpencodePreflightPassed(
  commandName: string,
  spawnSyncImpl: typeof childProcess.spawnSync = childProcess.spawnSync,
) {
  // 2026-05-28: 用户要求 CLI 支持通过 --cmd 替换默认命令名，预检查必须与 serve/attach 使用同一个命令名。
  const result = spawnSyncImpl(commandName, ["--help"], {
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
  throw new Error(`\`${commandName} --help\` 执行失败（${errorMessage}），说明 ${commandName} 无法正常使用，无法启动本应用`);
}
