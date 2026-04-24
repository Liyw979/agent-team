import type { GraphDispatchBatch, GraphAgentResult } from "./gating-router";
import type { GraphTaskState } from "./gating-state";

export interface LangGraphInputEvent {
  type: "user_message";
  targetAgentId: string;
  content: string;
}

export interface LangGraphBatchRunner {
  id: string;
  agentId: string;
  promise: Promise<GraphAgentResult>;
}

export interface LangGraphTaskLoopHost {
  createBatchRunners(input: {
    taskId: string;
    state: GraphTaskState;
    batch: GraphDispatchBatch;
  }): Promise<LangGraphBatchRunner[]>;
  completeTask(input: {
    taskId: string;
    status: "finished" | "failed";
    finishReason?: string | null;
    failureReason?: string | null;
  }): Promise<void>;
}
