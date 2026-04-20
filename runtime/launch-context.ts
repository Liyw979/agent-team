import path from "node:path";

export interface ResolveLaunchContextInput {
  argv: string[];
  env: NodeJS.ProcessEnv;
  defaultCwd: string;
}

export interface LaunchContext {
  launchTaskId: string | null;
  launchCwd: string;
}

function readLaunchArgument(argv: string[], flag: string): string | null {
  const index = argv.findIndex((value) => value === flag);
  if (index < 0) {
    return null;
  }
  const next = argv[index + 1];
  return typeof next === "string" && next.trim().length > 0 ? next : null;
}

function readLaunchEnv(env: NodeJS.ProcessEnv, key: "AGENTFLOW_TASK_ID" | "AGENTFLOW_CWD"): string | null {
  const value = env[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function resolveLaunchContext(input: ResolveLaunchContextInput): LaunchContext {
  const launchTaskId =
    readLaunchArgument(input.argv, "--agentflow-task-id")
    ?? readLaunchEnv(input.env, "AGENTFLOW_TASK_ID");
  const launchCwdRaw =
    readLaunchArgument(input.argv, "--agentflow-cwd")
    ?? readLaunchEnv(input.env, "AGENTFLOW_CWD")
    ?? input.defaultCwd;

  return {
    launchTaskId,
    launchCwd: path.resolve(launchCwdRaw),
  };
}
