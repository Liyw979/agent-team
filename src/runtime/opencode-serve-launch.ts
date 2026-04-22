export function extractOpenCodeServeBaseUrl(output: string): string | null {
  const match = output.match(/opencode server listening on (https?:\/\/\S+)/iu);
  return match?.[1] ?? null;
}
