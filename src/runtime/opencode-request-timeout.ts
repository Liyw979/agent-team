const SESSION_CREATE_TIMEOUT_MS = 12_000;
const SESSION_MESSAGE_TIMEOUT_MS = 300_000;

export interface ResolveOpenCodeRequestTimeoutInput {
  pathname: string;
  method: "GET" | "POST";
}

export function getOpenCodeRequestTimeoutMs(
  input: ResolveOpenCodeRequestTimeoutInput,
): number {
  return input.method === "POST" && /^\/session\/[^/]+\/message$/.test(input.pathname)
    ? SESSION_MESSAGE_TIMEOUT_MS
    : SESSION_CREATE_TIMEOUT_MS;
}
