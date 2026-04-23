export interface AgentPromptDialogState {
  agentId: string;
  promptSourceLabel: string;
  content: string;
}

export function buildAgentPromptDialogState(input: {
  agentId: string;
  prompt: string;
}): AgentPromptDialogState {
  const normalizedPrompt = input.prompt.trim();

  if (normalizedPrompt) {
    return {
      agentId: input.agentId,
      promptSourceLabel: "System Prompt",
      content: normalizedPrompt,
    };
  }

  return {
    agentId: input.agentId,
    promptSourceLabel: "OpenCode 加载",
    content: "Prompt为空或者由opencode加载",
  };
}
