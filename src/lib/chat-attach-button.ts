import type { TaskAgentRecord } from "@shared/types";

interface ResolveChatMessageAttachButtonStateInput {
  sender: string;
  taskAgents: ReadonlyArray<Pick<TaskAgentRecord, "id" | "opencodeSessionId">>;
  openingAgentTerminalId: string | null;
}

type HiddenChatMessageAttachButtonState = {
  visible: false;
};

type VisibleChatMessageAttachButtonState = {
  visible: true;
  agentId: string;
  disabled: boolean;
  title: string;
  label: "attach" | "打开中";
};

type ChatMessageAttachButtonState =
  | HiddenChatMessageAttachButtonState
  | VisibleChatMessageAttachButtonState;

export function resolveChatMessageAttachButtonState(
  input: ResolveChatMessageAttachButtonStateInput,
): ChatMessageAttachButtonState {
  if (input.sender === "user" || input.sender === "system") {
    return {
      visible: false,
    };
  }

  const taskAgent = input.taskAgents.find((agent) => agent.id === input.sender);
  if (!taskAgent) {
    return {
      visible: false,
    };
  }

  const isAttachOpening = input.openingAgentTerminalId === input.sender;
  return {
    visible: true,
    agentId: input.sender,
    disabled: !taskAgent.opencodeSessionId || isAttachOpening,
    title: taskAgent.opencodeSessionId
      ? (isAttachOpening ? `正在打开 ${input.sender} 的 attach 终端` : `attach 到 ${input.sender}`)
      : `${input.sender} 当前还没有可 attach 的 OpenCode session。`,
    label: isAttachOpening ? "打开中" : "attach",
  };
}
