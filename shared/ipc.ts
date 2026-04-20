export const IPC_CHANNELS = {
  bootstrap: "agentflow/bootstrap",
  submitTask: "agentflow/submit-task",
  openAgentTerminal: "agentflow/open-agent-terminal",
  getTaskRuntime: "agentflow/get-task-runtime",
  eventStream: "agentflow/event-stream",
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
