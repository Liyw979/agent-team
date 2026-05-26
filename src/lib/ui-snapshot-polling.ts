// 2026-05-26: 用户要求 UI 轮询 OpenCode 过程消息的间隔改为 3 秒，避免多 Agent 运行时查询过密。
export function getUiSnapshotPollingIntervalMs(): number {
  return 3000;
}
