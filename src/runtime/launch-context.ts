import path from "node:path";

interface ResolveLaunchContextInput {
  argv: string[];
  env: NodeJS.ProcessEnv;
  defaultCwd: string;
}

interface LaunchContext {
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

function readLaunchEnv(env: NodeJS.ProcessEnv, key: "AGENT_TEAM_TASK_ID" | "AGENT_TEAM_CWD"): string | null {
  const value = env[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function resolveLaunchContext(input: ResolveLaunchContextInput): LaunchContext {
  const launchTaskId =
    readLaunchArgument(input.argv, "--agent-team-task-id")
    ?? readLaunchEnv(input.env, "AGENT_TEAM_TASK_ID");
  const launchCwdRaw =
    readLaunchArgument(input.argv, "--agent-team-cwd")
    ?? readLaunchEnv(input.env, "AGENT_TEAM_CWD")
    ?? input.defaultCwd;

  return {
    launchTaskId,
    launchCwd: path.resolve(launchCwdRaw),
  };
}
