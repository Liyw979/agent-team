import { contextBridge, ipcRenderer } from "electron";
import type {
  AgentRuntimeSnapshot,
  AgentFlowEvent,
  GetTaskRuntimePayload,
  OpenAgentTerminalPayload,
  SubmitTaskPayload,
  TaskSnapshot,
  UiBootstrapPayload,
} from "@shared/types";
import { IPC_CHANNELS } from "@shared/ipc";

const api = {
  bootstrap: (): Promise<UiBootstrapPayload> => ipcRenderer.invoke(IPC_CHANNELS.bootstrap),
  submitTask: (payload: SubmitTaskPayload): Promise<TaskSnapshot> =>
    ipcRenderer.invoke(IPC_CHANNELS.submitTask, payload),
  openAgentTerminal: (payload: OpenAgentTerminalPayload): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.openAgentTerminal, payload),
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
