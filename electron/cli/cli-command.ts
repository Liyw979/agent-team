import { Command, CommanderError } from "commander";

export type ParsedCliCommand =
  | { kind: "help" }
  | {
      kind: "task.run";
      cwd?: string;
      file?: string;
      message?: string;
      ui: boolean;
    }
  | {
      kind: "task.show";
      taskId: string;
      ui: boolean;
    }
  | {
      kind: "task.chat";
      cwd?: string;
      file?: string;
      taskId?: string;
      message?: string;
      ui: boolean;
    }
  | {
      kind: "task.attach";
      cwd?: string;
      agentName: string;
      printOnly: boolean;
    };

function configureProgram(program: Command) {
  return program
    .name("agentflow")
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
    .command("run")
    .description("运行新 task，任务完成后退出 CLI")
    .option("--cwd <path>", "指定工作目录")
    .option("--file <topology-json>", "团队拓扑 JSON 文件路径")
    .option("--message <message>", "首条消息")
    .option("--ui", "同步启动前端界面")
    .action((options) => {
      emit({
        kind: "task.run",
        cwd: options.cwd,
        file: options.file,
        message: options.message,
        ui: Boolean(options.ui),
      });
    });

  task
    .command("show <taskId>")
    .description("显示已有 task 的群聊记录")
    .option("--ui", "同步启动前端界面")
    .action((taskId, options) => {
      emit({
        kind: "task.show",
        taskId,
        ui: Boolean(options.ui),
      });
    });

  task
    .command("chat")
    .description("运行新 task 或恢复已有 task，完成后继续进入命令行对话")
    .option("--cwd <path>", "指定工作目录")
    .option("--file <topology-json>", "团队拓扑 JSON 文件路径")
    .option("--task <taskId>", "恢复已有 task")
    .option("--message <message>", "首条或恢复后的补发消息")
    .option("--ui", "同步启动前端界面")
    .action((options) => {
      emit({
        kind: "task.chat",
        cwd: options.cwd,
        file: options.file,
        taskId: options.task,
        message: options.message,
        ui: Boolean(options.ui),
      });
    });

  task
    .command("attach <agentName>")
    .description("attach 到当前工作目录最新 task 的指定 Agent")
    .option("--cwd <path>", "指定工作目录")
    .option("--print-only", "仅打印 attach 命令")
    .action((agentName, options) => {
      emit({
        kind: "task.attach",
        cwd: options.cwd,
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
