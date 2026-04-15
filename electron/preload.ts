import { contextBridge, ipcRenderer } from "electron";
import type {
  AgentRuntimeSnapshot,
  AgentFlowEvent,
  CreateProjectPayload,
  DeleteAgentPayload,
  DeleteTaskPayload,
  GetTaskRuntimePayload,
  OpenAgentPanePayload,
  OpenTaskSessionPayload,
  ProjectSnapshot,
  ReadAgentFilePayload,
  SaveAgentPromptPayload,
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
  deleteTask: (payload: DeleteTaskPayload): Promise<ProjectSnapshot> =>
    ipcRenderer.invoke(IPC_CHANNELS.deleteTask, payload),
  openAgentPane: (payload: OpenAgentPanePayload): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.openAgentPane, payload),
  openTaskSession: (payload: OpenTaskSessionPayload): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.openTaskSession, payload),
  readAgentFile: (payload: ReadAgentFilePayload) =>
    ipcRenderer.invoke(IPC_CHANNELS.readAgentFile, payload),
  saveAgentPrompt: (payload: SaveAgentPromptPayload): Promise<ProjectSnapshot> =>
    ipcRenderer.invoke(IPC_CHANNELS.saveAgentPrompt, payload),
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
