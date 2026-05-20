import { Command, CommanderError } from "commander";

export type ParsedCliCommand =
  | { kind: "help" }
  | {
      kind: "task.headless";
      cwd: string;
      file: string;
      message: string;
      showMessage: boolean;
    }
  | {
      kind: "task.ui";
      cwd: string;
      file: string;
      message: string;
      showMessage: boolean;
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
  cwd: string;
  file: string;
  message: string;
  showMessage: boolean;
}

function buildCliProgram(): readonly [Command, Command, Command] {
  const program = configureProgram(new Command());

  const task = program.command("task").description("Task 会话相关命令");
  const taskHeadless = task
    .command("headless")
    .description("运行新 task，任务完成后退出 CLI")
    .option("--cwd <path>", "指定工作目录", "")
    .option("--file <topology-file>", "团队拓扑 YAML 文件路径", "")
    .option("--message <message>", "首条消息", "")
    .option("--show-message", "展示完整消息记录", false);

  const taskUi = task
    .command("ui")
    .description("新建 task，并在浏览器中打开网页界面")
    .option("--cwd <path>", "指定工作目录", "")
    .option("--file <topology-file>", "团队拓扑 YAML 文件路径", "")
    .option("--message <message>", "新建 task 时的首条消息", "")
    .option("--show-message", "展示完整消息记录", false);

  return [program, taskHeadless, taskUi];
}

export function buildCliHelpText(): string {
  const [program] = buildCliProgram();
  const commanderHelp = program.helpInformation().trimEnd();
  const appendix = [
    "",
    "补充命令示例：",
    "  task headless --file <topology-file> --message <message> [--cwd <path>] [--show-message]",
    "  task ui --file <topology-file> --message <message> [--cwd <path>] [--show-message]",
    "",
    "说明：",
    "  - `task headless` 默认打印诊断信息与 attach 调试命令；传 `--show-message` 后再额外展示完整消息记录。",
    "  - `task ui` 默认打印诊断信息与 attach 调试命令；传 `--show-message` 后再额外展示完整消息记录，同时保持网页界面照常打开。",
    "  - `task ui` 会在当前 CLI 进程里启动本地 Web Host，并打开浏览器；命令本身会保持驻留，按 Ctrl+C 后才清理并退出。",
    "  - 新建任务时必须传 `--file` 和 `--message`；`--file` 必须是 `.yaml` 或 `.yml`。",
  ].join("\n");
  return `${commanderHelp}\n${appendix}`;
}

export function parseCliCommand(argv: string[]): ParsedCliCommand {
  if (argv.length === 0 || argv[0] === "help") {
    return { kind: "help" };
  }

  const [program, taskHeadless, taskUi] = buildCliProgram();

  try {
    program.parse(argv, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError && error.code === "commander.helpDisplayed") {
      return { kind: "help" };
    }
    throw error;
  }

  if (argv[0] === "task" && argv[1] === "headless") {
    const options = taskHeadless.opts<TaskCommandOptions>();
    return {
      kind: "task.headless",
      cwd: options.cwd,
      file: options.file,
      message: options.message,
      showMessage: options.showMessage,
    };
  }
  if (argv[0] === "task" && argv[1] === "ui") {
    const options = taskUi.opts<TaskCommandOptions>();
    return {
      kind: "task.ui",
      cwd: options.cwd,
      file: options.file,
      message: options.message,
      showMessage: options.showMessage,
    };
  }

  throw new Error("CLI 内部错误：命令解析未产生有效结果。");
}
