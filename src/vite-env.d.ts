/// <reference types="vite/client" />

import type {
  AgentFileRecord,
  AgentRuntimeSnapshot,
  AgentFlowEvent,
  CreateProjectPayload,
  DeleteAgentPayload,
  DeleteTaskPayload,
  GetTaskRuntimePayload,
  OpenTaskSessionPayload,
  ProjectSnapshot,
  ReadAgentFilePayload,
  SaveAgentPromptPayload,
  SubmitTaskPayload,
  TaskSnapshot,
  UpdateTopologyPayload,
} from "@shared/types";

declare global {
  interface Window {
    agentFlow: {
      bootstrap: () => Promise<ProjectSnapshot[]>;
      createProject: (payload: CreateProjectPayload) => Promise<ProjectSnapshot>;
      pickProjectPath: () => Promise<string | null>;
      submitTask: (payload: SubmitTaskPayload) => Promise<TaskSnapshot>;
      deleteTask: (payload: DeleteTaskPayload) => Promise<ProjectSnapshot>;
      openTaskSession: (payload: OpenTaskSessionPayload) => Promise<void>;
      readAgentFile: (payload: ReadAgentFilePayload) => Promise<AgentFileRecord>;
      saveAgentPrompt: (payload: SaveAgentPromptPayload) => Promise<ProjectSnapshot>;
      deleteAgent: (payload: DeleteAgentPayload) => Promise<ProjectSnapshot>;
      saveTopology: (payload: UpdateTopologyPayload) => Promise<ProjectSnapshot>;
      getTaskRuntime: (payload: GetTaskRuntimePayload) => Promise<AgentRuntimeSnapshot[]>;
      onAgentFlowEvent: (listener: (event: AgentFlowEvent) => void) => () => void;
    };
  }
}

export {};
