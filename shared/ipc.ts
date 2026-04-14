export const IPC_CHANNELS = {
  bootstrap: "agentflow/bootstrap",
  createProject: "agentflow/create-project",
  pickProjectPath: "agentflow/pick-project-path",
  submitTask: "agentflow/submit-task",
  deleteTask: "agentflow/delete-task",
  openAgentPane: "agentflow/open-agent-pane",
  openTaskSession: "agentflow/open-task-session",
  readAgentFile: "agentflow/read-agent-file",
  saveTopology: "agentflow/save-topology",
  getTaskRuntime: "agentflow/get-task-runtime",
  eventStream: "agentflow/event-stream",
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
