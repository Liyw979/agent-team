export interface AgentPromptDialogState {
  agentName: string;
  promptSourceLabel: string;
  content: string;
}

export function buildAgentPromptDialogState(input: {
  agentName: string;
  prompt: string;
}): AgentPromptDialogState {
  const normalizedPrompt = input.prompt.trim();

  if (normalizedPrompt) {
    return {
      agentName: input.agentName,
      promptSourceLabel: "System Prompt",
      content: normalizedPrompt,
    };
  }

  return {
    agentName: input.agentName,
    promptSourceLabel: "OpenCode 加载",
    content: "Prompt为空或者由opencode加载",
  };
}
