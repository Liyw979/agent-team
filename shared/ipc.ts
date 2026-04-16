export const IPC_CHANNELS = {
  bootstrap: "agentflow/bootstrap",
  createProject: "agentflow/create-project",
  pickProjectPath: "agentflow/pick-project-path",
  submitTask: "agentflow/submit-task",
  deleteProject: "agentflow/delete-project",
  deleteTask: "agentflow/delete-task",
  openAgentTerminal: "agentflow/open-agent-terminal",
  openTaskSession: "agentflow/open-task-session",
  readAgentFile: "agentflow/read-agent-file",
  readBuiltinAgentTemplate: "agentflow/read-builtin-agent-template",
  saveAgentPrompt: "agentflow/save-agent-prompt",
  saveBuiltinAgentTemplate: "agentflow/save-builtin-agent-template",
  resetBuiltinAgentTemplate: "agentflow/reset-builtin-agent-template",
  deleteAgent: "agentflow/delete-agent",
  saveTopology: "agentflow/save-topology",
  getTaskRuntime: "agentflow/get-task-runtime",
  eventStream: "agentflow/event-stream",
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
