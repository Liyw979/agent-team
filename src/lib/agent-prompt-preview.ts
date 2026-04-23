export function buildAgentPromptPreviewText(input: {
  agentName: string;
  prompt: string;
}): string {
  const normalizedPrompt = input.prompt.trim();
  if (normalizedPrompt) {
    return normalizedPrompt;
  }

  return "Prompt为空或者由opencode加载";
}
