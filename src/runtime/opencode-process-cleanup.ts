export function isOpenCodeServeCommand(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  return normalized.includes("opencode") && normalized.includes("serve");
}
