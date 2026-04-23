import { toOpenCodeAgentId } from "./opencode-agent-id";

interface SubmitMessageBodyInput {
  agent: string;
  content: string;
  system?: string;
}

export function buildSubmitMessageBody(payload: SubmitMessageBodyInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    agent: toOpenCodeAgentId(payload.agent),
    parts: [
      {
        type: "text",
        text: payload.content,
      },
    ],
  };

  const system = payload.system?.trim();
  if (system) {
    body["system"] = system;
  }

  return body;
}
