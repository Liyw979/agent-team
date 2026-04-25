export function buildAgentPromptSnippetText(input: {
  agentId: string;
  prompt: string;
}): string {
  const normalizedPrompt = input.prompt.trim();
  if (normalizedPrompt) {
    return normalizedPrompt;
  }

  return "Prompt为空或者由opencode加载";
}
