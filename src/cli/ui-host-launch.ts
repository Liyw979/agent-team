export const UI_LOOPBACK_HOST = "localhost";

export function buildUiUrl(input: {
  port: number;
  taskId: string;
}): string {
  const query = new URLSearchParams({
    taskId: input.taskId,
  });
  return `http://${UI_LOOPBACK_HOST}:${input.port}/?${query.toString()}`;
}
