// 2026-05-29: 用户要求从业务入口消灭 mention 与 agentId 缺失态的二义性；统一在共享层完成规范化与提取。
export function normalizeAgentId(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

// 2026-05-29: 用户要求 mention 解析只有一个事实来源；未命中时返回空字符串，不再向调用方传播可空值。
export function extractMentionAgentId(content: string): string {
  const match = content.match(/@([^\s]+)/u);
  if (!match) {
    return "";
  }
  return normalizeAgentId(match[1]);
}
