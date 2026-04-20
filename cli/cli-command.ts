import { Command, CommanderError } from "commander";

export type ParsedCliCommand =
  | { kind: "help" }
  | {
      kind: "task.headless";
      cwd?: string;
      file?: string;
      message?: string;
    }
  | {
      kind: "task.ui";
      cwd?: string;
      file?: string;
      taskId?: string;
      message?: string;
    }
  | {
      kind: "task.attach";
      taskId: string;
      agentName: string;
      printOnly: boolean;
    };

function configureProgram(program: Command) {
  return program
    .name("agent-team")
    .description("OpenCode Code Agent CLI")
    .showHelpAfterError()
    .allowExcessArguments(false)
    .exitOverride()
    .configureOutput({
      writeOut: () => undefined,
      writeErr: () => undefined,
    });
}

export function buildCliProgram(onCommand?: (command: ParsedCliCommand) => void) {
  const emit = onCommand ?? (() => undefined);
  const program = configureProgram(new Command());

  const task = program.command("task").description("Task 会话相关命令");
  task
    .command("headless")
    .description("运行新 task，任务完成后退出 CLI")
    .option("--cwd <path>", "指定工作目录")
    .option("--file <topology-json>", "团队拓扑 JSON 文件路径")
    .option("--message <message>", "首条消息")
    .action((options) => {
      emit({
        kind: "task.headless",
        cwd: options.cwd,
        file: options.file,
        message: options.message,
      });
    });

  task
    .command("ui [taskId]")
    .description("新建或恢复 task，并在浏览器中打开网页界面")
    .option("--cwd <path>", "指定工作目录")
    .option("--file <topology-json>", "团队拓扑 JSON 文件路径")
    .option("--task <taskId>", "恢复已有 task")
    .option("--message <message>", "新建 task 时的首条消息")
    .action((taskId, options) => {
      if (taskId && options.task && taskId !== options.task) {
        throw new Error("task ui 的位置参数 taskId 与 --task <taskId> 不一致。");
      }
      emit({
        kind: "task.ui",
        cwd: options.cwd,
        file: options.file,
        taskId: taskId ?? options.task,
        message: options.message,
      });
    });

  task
    .command("attach <taskId> <agentName>")
    .description("attach 到指定 task 的目标 Agent")
    .option("--print-only", "仅打印 attach 命令")
    .action((taskId, agentName, options) => {
      emit({
        kind: "task.attach",
        taskId,
        agentName,
        printOnly: Boolean(options.printOnly),
      });
    });

  return program;
}

export function parseCliCommand(argv: string[]): ParsedCliCommand {
  if (argv.length === 0 || argv[0] === "help") {
    return { kind: "help" };
  }

  let parsed: ParsedCliCommand | null = null;
  const program = buildCliProgram((command) => {
    parsed = command;
  });

  try {
    program.parse(argv, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError && error.code === "commander.helpDisplayed") {
      return { kind: "help" };
    }
    throw error;
  }

  return parsed ?? { kind: "help" };
}
