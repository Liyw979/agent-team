/// <reference types="vite/client" />

import type {
  AgentRuntimeSnapshot,
  AgentFlowEvent,
  GetTaskRuntimePayload,
  SubmitTaskPayload,
  TaskSnapshot,
  UiBootstrapPayload,
  OpenAgentTerminalPayload,
} from "@shared/types";

declare global {
  interface Window {
    agentFlow: {
      bootstrap: () => Promise<UiBootstrapPayload>;
      submitTask: (payload: SubmitTaskPayload) => Promise<TaskSnapshot>;
      openAgentTerminal: (payload: OpenAgentTerminalPayload) => Promise<void>;
      getTaskRuntime: (payload: GetTaskRuntimePayload) => Promise<AgentRuntimeSnapshot[]>;
      onAgentFlowEvent: (listener: (event: AgentFlowEvent) => void) => () => void;
    };
  }
}

export {};
