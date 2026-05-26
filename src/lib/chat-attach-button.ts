import type { TaskSnapshot } from "@shared/types";
import {
  resolveAgentAttachButtonState,
  resolveSessionStateFromSessionIdText,
} from "./agent-attach-state";

type ChatTaskAgentEntry = Pick<TaskSnapshot["agents"][number], "id" | "opencodeSessionId">;

type VisibleChatAttachButtonState = {
  visible: true;
  agentId: string;
  disabled: boolean;
  title: string;
  label: "attach";
};

type ChatAttachButtonState =
  | false
  | VisibleChatAttachButtonState;

export function resolveChatMessageAttachButtonState(input: {
  sender: string;
  taskAgents: ReadonlyArray<ChatTaskAgentEntry>;
}): ChatAttachButtonState {
  if (input.sender === "user" || input.sender === "system") {
    return false;
  }

  const taskAgent = input.taskAgents.find((entry) => entry.id === input.sender);
  const attachState = resolveAgentAttachButtonState({
    agentId: input.sender,
    sessionState: taskAgent
      ? resolveSessionStateFromSessionIdText(taskAgent.opencodeSessionId)
      : {
          kind: "absent",
        },
  });

  return {
    visible: true,
    agentId: input.sender,
    disabled: attachState.disabled,
    title: attachState.title,
    label: attachState.label,
  };
}
