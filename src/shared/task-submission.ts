import { extractMentionAgentId, normalizeAgentId } from "./agent-id";

type TaskSubmissionResolution =
  | {
      ok: true;
      targetAgentId: string;
    }
  | {
      ok: false;
      code: "missing_agents" | "missing_start_agent" | "missing_target_agent";
      message: string;
    };

export function resolveTaskSubmissionTarget(input: {
  content: string;
  availableAgents: string[];
  defaultTargetAgentId?: string;
}): TaskSubmissionResolution {
  // 2026-05-29: 用户要求提交入口直接消灭 mention 缺失态二义性；只允许确定的 agentId 继续参与路由。
  const explicitMention = extractMentionAgentId(input.content);
  if (explicitMention) {
    if (input.availableAgents.includes(explicitMention)) {
      return {
        ok: true,
        targetAgentId: explicitMention,
      };
    }

    return {
      ok: false,
      code: "missing_target_agent",
      message:
        explicitMention.toLowerCase() === "build"
          ? "当前 Project 尚未写入 Build Agent，@Build 不可用。"
          : `未找到被 @ 的 Agent：${explicitMention}`,
    };
  }

  const defaultTargetAgentId = normalizeAgentId(input.defaultTargetAgentId);
  if (defaultTargetAgentId && input.availableAgents.includes(defaultTargetAgentId)) {
    return {
      ok: true,
      targetAgentId: defaultTargetAgentId,
    };
  }

  if (input.availableAgents.length === 0) {
    return {
      ok: false,
      code: "missing_agents",
      message: "当前 Project 还没有可用 Agent，请先配置团队成员。",
    };
  }

  return {
    ok: false,
    code: "missing_start_agent",
    message: "当前拓扑缺少 start node，请使用 @ 指定一个已写入 Agent 后再发送。",
  };
}
