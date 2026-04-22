export const IPC_CHANNELS = {
  getUiSnapshot: "agent-team/get-ui-snapshot",
  submitTask: "agent-team/submit-task",
  openAgentTerminal: "agent-team/open-agent-terminal",
  getTaskRuntime: "agent-team/get-task-runtime",
  eventStream: "agent-team/event-stream",
} as const;

type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
