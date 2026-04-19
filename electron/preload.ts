import { contextBridge, ipcRenderer } from "electron";
import type {
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
  OpenAgentTerminalPayload,
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
import { IPC_CHANNELS } from "@shared/ipc";

const api = {
  bootstrap: (): Promise<ProjectSnapshot[]> => ipcRenderer.invoke(IPC_CHANNELS.bootstrap),
  createProject: (payload: CreateProjectPayload): Promise<ProjectSnapshot> =>
    ipcRenderer.invoke(IPC_CHANNELS.createProject, payload),
  pickProjectPath: (): Promise<string | null> => ipcRenderer.invoke(IPC_CHANNELS.pickProjectPath),
  submitTask: (payload: SubmitTaskPayload): Promise<TaskSnapshot> =>
    ipcRenderer.invoke(IPC_CHANNELS.submitTask, payload),
  copyToClipboard: (payload: CopyToClipboardPayload): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.copyToClipboard, payload),
  deleteProject: (payload: DeleteProjectPayload): Promise<ProjectSnapshot[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.deleteProject, payload),
  deleteTask: (payload: DeleteTaskPayload): Promise<ProjectSnapshot> =>
    ipcRenderer.invoke(IPC_CHANNELS.deleteTask, payload),
  openAgentTerminal: (payload: OpenAgentTerminalPayload): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.openAgentTerminal, payload),
  openTaskSession: (payload: OpenTaskSessionPayload): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.openTaskSession, payload),
  openLangGraphStudio: (payload: OpenLangGraphStudioPayload): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.openLangGraphStudio, payload),
  readAgentFile: (payload: ReadAgentFilePayload) =>
    ipcRenderer.invoke(IPC_CHANNELS.readAgentFile, payload),
  readBuiltinAgentTemplate: (payload: ReadBuiltinAgentTemplatePayload): Promise<BuiltinAgentTemplateRecord> =>
    ipcRenderer.invoke(IPC_CHANNELS.readBuiltinAgentTemplate, payload),
  saveAgentPrompt: (payload: SaveAgentPromptPayload): Promise<ProjectSnapshot> =>
    ipcRenderer.invoke(IPC_CHANNELS.saveAgentPrompt, payload),
  saveBuiltinAgentTemplate: (payload: SaveBuiltinAgentTemplatePayload): Promise<ProjectSnapshot> =>
    ipcRenderer.invoke(IPC_CHANNELS.saveBuiltinAgentTemplate, payload),
  resetBuiltinAgentTemplate: (payload: ResetBuiltinAgentTemplatePayload): Promise<ProjectSnapshot> =>
    ipcRenderer.invoke(IPC_CHANNELS.resetBuiltinAgentTemplate, payload),
  deleteAgent: (payload: DeleteAgentPayload): Promise<ProjectSnapshot> =>
    ipcRenderer.invoke(IPC_CHANNELS.deleteAgent, payload),
  saveTopology: (payload: UpdateTopologyPayload): Promise<ProjectSnapshot> =>
    ipcRenderer.invoke(IPC_CHANNELS.saveTopology, payload),
  getTaskRuntime: (payload: GetTaskRuntimePayload): Promise<AgentRuntimeSnapshot[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.getTaskRuntime, payload),
  onAgentFlowEvent: (listener: (event: AgentFlowEvent) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: AgentFlowEvent) => listener(payload);
    ipcRenderer.on(IPC_CHANNELS.eventStream, wrapped);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.eventStream, wrapped);
  },
};

contextBridge.exposeInMainWorld("agentFlow", api);

declare global {
  interface Window {
    agentFlow: typeof api;
  }
}
