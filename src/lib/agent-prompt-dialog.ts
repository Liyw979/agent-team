import { usesOpenCodeBuiltinPrompt } from "@shared/types";

export interface AgentPromptDialogState {
  agentName: string;
  promptSourceLabel: string;
  content: string;
}

export function buildAgentPromptDialogState(input: {
  agentName: string;
  prompt: string | null | undefined;
}): AgentPromptDialogState {
  const normalizedPrompt = (input.prompt ?? "").trim();

  if (normalizedPrompt) {
    return {
      agentName: input.agentName,
      promptSourceLabel: "System Prompt",
      content: normalizedPrompt,
    };
  }

  if (usesOpenCodeBuiltinPrompt(input.agentName)) {
    return {
      agentName: input.agentName,
      promptSourceLabel: "OpenCode 内置",
      content: "当前 Agent 使用 OpenCode 内置 prompt，运行时不会在工作区拓扑里展开具体正文。",
    };
  }

  return {
    agentName: input.agentName,
    promptSourceLabel: "未配置",
    content: "当前 Agent 还没有可展示的 prompt。",
  };
}
