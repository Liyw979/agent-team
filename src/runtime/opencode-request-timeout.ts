const SESSION_CREATE_TIMEOUT_MS = 12_000;

interface ResolveOpenCodeRequestTimeoutInput {
  pathname: string;
  method: "GET" | "POST";
}

export function resolveOpenCodeRequestTimeoutMs(
  input: ResolveOpenCodeRequestTimeoutInput,
): number | null {
  if (
    input.method === "POST"
    && /^\/session\/[^/]+\/message$/.test(input.pathname)
  ) {
    return null;
  }

  return SESSION_CREATE_TIMEOUT_MS;
}
