type AttachSessionState =
  | {
      kind: "present";
      sessionId: string;
    }
  | {
      kind: "absent";
    };

interface AgentAttachButtonState {
  disabled: boolean;
  title: string;
  label: "attach" | "打开中";
}

export function resolveSessionStateFromSessionIdText(sessionIdText: string): AttachSessionState {
  return sessionIdText.length > 0
    ? {
        kind: "present",
        sessionId: sessionIdText,
      }
    : {
        kind: "absent",
      };
}

export function resolveAgentAttachButtonState(input: {
  agentId: string;
  sessionState: AttachSessionState;
  openingState: "idle" | "opening";
}): AgentAttachButtonState {
  const hasSession = input.sessionState.kind === "present";
  const isAttachOpening = input.openingState === "opening";
  return {
    disabled: !hasSession || isAttachOpening,
    title: hasSession
      ? (isAttachOpening ? `正在打开 ${input.agentId} 的 attach 终端` : `attach 到 ${input.agentId}`)
      : `${input.agentId} 当前还没有可 attach 的 OpenCode session。`,
    label: isAttachOpening ? "打开中" : "attach",
  };
}
