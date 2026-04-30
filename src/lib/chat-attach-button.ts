import type { TaskSnapshot } from "@shared/types";
import {
  resolveAgentAttachButtonState,
  resolveSessionStateFromSessionIdText,
} from "./agent-attach-state";

type ChatTaskAgentEntry = Pick<TaskSnapshot["agents"][number], "id" | "opencodeSessionId">;

type HiddenChatAttachButtonState = {
  visible: false;
};

type VisibleChatAttachButtonState = {
  visible: true;
  agentId: string;
  disabled: boolean;
  title: string;
  label: "attach" | "打开中";
};

type ChatAttachButtonState =
  | HiddenChatAttachButtonState
  | VisibleChatAttachButtonState;

export function resolveChatMessageAttachButtonState(input: {
  sender: string;
  taskAgents: ReadonlyArray<ChatTaskAgentEntry>;
  openingAgentTerminalId: string;
}): ChatAttachButtonState {
  if (input.sender === "user" || input.sender === "system") {
    return {
      visible: false,
    };
  }

  const taskAgent = input.taskAgents.find((entry) => entry.id === input.sender);
  const attachState = resolveAgentAttachButtonState({
    agentId: input.sender,
    sessionState: resolveSessionStateFromSessionIdText(taskAgent?.opencodeSessionId ?? ""),
    openingState: input.openingAgentTerminalId === input.sender ? "opening" : "idle",
  });

  return {
    visible: true,
    agentId: input.sender,
    disabled: attachState.disabled,
    title: attachState.title,
    label: attachState.label,
  };
}
