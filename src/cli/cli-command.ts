import { Command, CommanderError } from "commander";

export type ParsedCliCommand =
  | { kind: "help" }
  | {
      kind: "task.ui";
      cmd: string;
      cwd: string;
      file: string;
      message: string;
    };

function configureProgram(program: Command) {
  return program
    .name("agent-team")
    .description("OpenCode Code Agent CLI")
    .showHelpAfterError()
    .allowExcessArguments(false)
    .exitOverride()
    .configureOutput({
      writeOut: () => {},
      writeErr: () => {},
    });
}

interface TaskCommandOptions {
  cmd: string;
  cwd: string;
  file: string;
  message: string;
}

export function isCliCommandNameSupported(commandName: string): boolean {
  const trimmed = commandName.trim();
  return trimmed.length > 0 && /^[A-Za-z0-9_./:\\-]+$/u.test(trimmed);
}

function buildCliProgram(): readonly [Command, Command] {
  const program = configureProgram(new Command());

  const task = program.command("task").description("Task 会话相关命令");
  const taskUi = task
    .command("ui")
    .description("新建 task，并在浏览器中打开网页界面")
    .option("--cmd <command>", "底层命令名", "opencode")
    .option("--cwd <path>", "指定工作目录", "")
    .option("--file <topology-file>", "团队拓扑 YAML 文件路径", "")
    .option("--message <message>", "新建 task 时的首条消息", "");

  return [program, taskUi];
}

export function buildCliHelpText(): string {
  const [program] = buildCliProgram();
  const commanderHelp = program.helpInformation().trimEnd();
  const appendix = [
    "",
    "补充命令示例：",
    "  task ui --file <topology-file> --message <message> [--cmd <command>] [--cwd <path>]",
    "",
    "说明：",
    "  - `task ui` 会打印诊断信息与 attach 调试命令，并在当前 CLI 进程里启动本地 Web Host、打开浏览器页面。",
    "  - `task ui` 命令会保持驻留，按 Ctrl+C 后才清理并退出。",
    "  - `--cmd` 默认值为 `opencode`，表示底层命令名；传 `--cmd nga` 时会把底层命令切换为 `nga serve` 与 `nga attach ...`。",
    "  - 新建任务时必须传 `--file` 和 `--message`；`--file` 必须是 `.yaml` 或 `.yml`。",
  ].join("\n");
  return `${commanderHelp}\n${appendix}`;
}

export function parseCliCommand(argv: string[]): ParsedCliCommand {
  if (argv.length === 0 || argv[0] === "help") {
    return { kind: "help" };
  }

  const [program, taskUi] = buildCliProgram();

  try {
    program.parse(argv, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError && error.code === "commander.helpDisplayed") {
      return { kind: "help" };
    }
    throw error;
  }

  if (argv[0] === "task" && argv[1] === "ui") {
    const options = taskUi.opts<TaskCommandOptions>();
    return {
      kind: "task.ui",
      cmd: options.cmd,
      cwd: options.cwd,
      file: options.file,
      message: options.message,
    };
  }

  throw new Error("CLI 内部错误：命令解析未产生有效结果。");
}
