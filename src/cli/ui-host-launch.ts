export const UI_LOOPBACK_HOST = "localhost";
export const UI_LOOPBACK_IPV4_HOST = "127.0.0.1";
export const UI_LOOPBACK_IPV6_HOST = "::1";
export const UI_LOOPBACK_BIND_HOSTS = [
  UI_LOOPBACK_IPV6_HOST,
  UI_LOOPBACK_IPV4_HOST,
] as const;

export type UiLoopbackBindHost = (typeof UI_LOOPBACK_BIND_HOSTS)[number];

export function buildUiUrl(input: {
  port: number;
  taskId: string;
}): string {
  const query = new URLSearchParams({
    taskId: input.taskId,
  });
  return `http://${UI_LOOPBACK_HOST}:${input.port}/?${query.toString()}`;
}
