import type { GraphDispatchBatch, GraphAgentResult } from "./gating-router";
import type { GraphTaskState } from "./gating-state";

export interface TaskRuntimeInputEvent {
  type: "user_message";
  targetAgentId: string;
  content: string;
}

export interface TaskRuntimeBatchRunner {
  agentId: string;
  promise: Promise<GraphAgentResult>;
}

export interface TaskRuntimeLoopHost {
  createBatchRunners(input: {
    state: GraphTaskState;
    batch: GraphDispatchBatch;
  }): Promise<TaskRuntimeBatchRunner[]>;
  completeTask(
    input:
      | {
          status: "finished";
          finishReason: string;
        }
      | {
          status: "failed";
          failureReason: string;
        },
  ): Promise<void>;
}
