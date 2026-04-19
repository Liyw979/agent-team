import type { GraphDispatchBatch, GraphAgentResult } from "./gating-router";
import type { GraphTaskState } from "./gating-state";

export interface LangGraphInputEvent {
  type: "user_message";
  targetAgentName: string;
  content: string;
}

export interface LangGraphBatchRunner {
  id: string;
  agentName: string;
  promise: Promise<GraphAgentResult>;
}

export interface LangGraphTaskLoopHost {
  createBatchRunners(input: {
    taskId: string;
    state: GraphTaskState;
    batch: GraphDispatchBatch;
  }): Promise<LangGraphBatchRunner[]>;
  moveTaskToWaiting(input: {
    taskId: string;
    state: GraphTaskState;
  }): Promise<void>;
  completeTask(input: {
    taskId: string;
    status: "finished" | "failed";
    failureReason?: string | null;
  }): Promise<void>;
}
