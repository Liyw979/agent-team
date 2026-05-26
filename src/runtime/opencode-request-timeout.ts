// 2026-05-26: 用户要求将非 session message 长请求的默认短超时从 12 秒调整为 30 秒。
const SESSION_CREATE_TIMEOUT_MS = 30_000;
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
