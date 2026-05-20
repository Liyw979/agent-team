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
    taskId: string;
    state: GraphTaskState;
    batch: GraphDispatchBatch;
  }): Promise<TaskRuntimeBatchRunner[]>;
  completeTask(
    input:
      | {
          taskId: string;
          status: "finished";
          finishReason: string;
        }
      | {
          taskId: string;
          status: "failed";
          failureReason: string;
        },
  ): Promise<void>;
}
