/// <reference types="vite/client" />

import type {
  AgentFileRecord,
  AgentRuntimeSnapshot,
  BuiltinAgentTemplateRecord,
  AgentFlowEvent,
  CopyToClipboardPayload,
  CreateProjectPayload,
  DeleteProjectPayload,
  DeleteAgentPayload,
  DeleteTaskPayload,
  GetTaskRuntimePayload,
  OpenLangGraphStudioPayload,
  OpenTaskSessionPayload,
  ProjectSnapshot,
  ReadAgentFilePayload,
  ReadBuiltinAgentTemplatePayload,
  ResetBuiltinAgentTemplatePayload,
  SaveAgentPromptPayload,
  SaveBuiltinAgentTemplatePayload,
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
      copyToClipboard: (payload: CopyToClipboardPayload) => Promise<void>;
      deleteProject: (payload: DeleteProjectPayload) => Promise<ProjectSnapshot[]>;
      deleteTask: (payload: DeleteTaskPayload) => Promise<ProjectSnapshot>;
      openTaskSession: (payload: OpenTaskSessionPayload) => Promise<void>;
      openLangGraphStudio: (payload: OpenLangGraphStudioPayload) => Promise<string>;
      readAgentFile: (payload: ReadAgentFilePayload) => Promise<AgentFileRecord>;
      readBuiltinAgentTemplate: (payload: ReadBuiltinAgentTemplatePayload) => Promise<BuiltinAgentTemplateRecord>;
      saveAgentPrompt: (payload: SaveAgentPromptPayload) => Promise<ProjectSnapshot>;
      saveBuiltinAgentTemplate: (payload: SaveBuiltinAgentTemplatePayload) => Promise<ProjectSnapshot>;
      resetBuiltinAgentTemplate: (payload: ResetBuiltinAgentTemplatePayload) => Promise<ProjectSnapshot>;
      deleteAgent: (payload: DeleteAgentPayload) => Promise<ProjectSnapshot>;
      saveTopology: (payload: UpdateTopologyPayload) => Promise<ProjectSnapshot>;
      getTaskRuntime: (payload: GetTaskRuntimePayload) => Promise<AgentRuntimeSnapshot[]>;
      onAgentFlowEvent: (listener: (event: AgentFlowEvent) => void) => () => void;
    };
  }
}

export {};
