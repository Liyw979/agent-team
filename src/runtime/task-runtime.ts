import {
  applyAgentResultToGraphState,
  createUserDispatchDecision,
  type GraphRoutingDecision,
} from "./gating-router";
import { createEmptyGraphTaskState, type GraphTaskState } from "./gating-state";
import type {
  TaskRuntimeBatchRunner,
  TaskRuntimeInputEvent,
  TaskRuntimeLoopHost,
} from "./task-runtime-host";

interface RuntimeEnvelope {
  graphState: GraphStateSlot;
  pendingInput: PendingInputSlot;
  lastDecision: LastDecisionSlot;
  lastError: LastRuntimeError;
}

type GraphStateSlot =
  | {
      kind: "created";
      graphState: GraphTaskState;
    }
  | {
      kind: "empty";
    };

type PendingInputSlot =
  | {
      kind: "received";
      event: TaskRuntimeInputEvent;
    }
  | {
      kind: "empty";
    };

type LastDecisionSlot =
  | {
      kind: "decided";
      decision: GraphRoutingDecision;
    }
  | {
      kind: "empty";
    };

type LastRuntimeError =
  | {
      kind: "failed";
      message: string;
    }
  | {
      kind: "none";
    };

type CheckpointSlot =
  | {
      kind: "found";
      checkpoint: RuntimeEnvelope;
    }
  | {
      kind: "missing";
    };

export class TaskRuntime {
  private checkpointSlot: CheckpointSlot = { kind: "missing" };

  constructor(
    private readonly options: {
      host: TaskRuntimeLoopHost;
    },
  ) {}

  async startTask(input: {
    topology: GraphTaskState["topology"];
    initialInput: TaskRuntimeInputEvent;
  }): Promise<GraphTaskState> {
    const graphState = createEmptyGraphTaskState({
      topology: input.topology,
    });
    const result = await this.runAndPersist(
      {
        graphState: { kind: "created", graphState },
        pendingInput: { kind: "received", event: input.initialInput },
        lastDecision: { kind: "empty" },
        lastError: { kind: "none" },
      } satisfies RuntimeEnvelope,
    );
    return result.graphState.kind === "created" ? result.graphState.graphState : graphState;
  }

  async resumeTask(input: {
    topology: GraphTaskState["topology"];
    event: TaskRuntimeInputEvent;
  }): Promise<GraphTaskState> {
    const existing = await this.getCheckpoint();
    const graphState = resolveCheckpointGraphState(existing, input.topology);
    const result = await this.runAndPersist(
      {
        graphState: { kind: "created", graphState },
        pendingInput: { kind: "received", event: input.event },
        lastDecision: { kind: "empty" },
        lastError: { kind: "none" },
      } satisfies RuntimeEnvelope,
    );
    return result.graphState.kind === "created" ? result.graphState.graphState : graphState;
  }

  async getCheckpoint(): Promise<CheckpointSlot> {
    return this.checkpointSlot;
  }

  async streamTask(
    listener: (state: CheckpointSlot) => void,
  ): Promise<void> {
    listener(await this.getCheckpoint());
  }

  private async runAndPersist(
    state: RuntimeEnvelope,
  ): Promise<RuntimeEnvelope> {
    const result = await this.runTaskLoop(state);
    this.checkpointSlot = {
      kind: "found",
      checkpoint: result,
    };
    return result;
  }

  private async runTaskLoop(state: RuntimeEnvelope): Promise<RuntimeEnvelope> {
    if (state.graphState.kind === "empty") {
      return {
        ...state,
        lastDecision: {
          kind: "decided",
          decision: {
            type: "failed",
            errorMessage: "graphState 缺失",
          },
        },
        lastError: { kind: "failed", message: "graphState 缺失" },
      };
    }

    let currentState = state.graphState.graphState;
    let currentDecision = resolveInitialRuntimeDecision(state, currentState);

    const inflight = new Set<TaskRuntimeBatchRunner>();
    while (true) {
      while (currentDecision.kind === "decided" && currentDecision.decision.type === "execute_batch") {
        const runners = await this.options.host.createBatchRunners({
          state: currentState,
          batch: currentDecision.decision.batch,
        });
        for (const runner of runners) {
          inflight.add(runner);
        }
        currentDecision = { kind: "empty" };
      }

      if (inflight.size === 0) {
        if (currentDecision.kind === "empty" || currentDecision.decision.type === "finished") {
          currentState.taskStatus = "finished";
          currentState.finishReason = resolveFinishReason(currentDecision, currentState);
          await this.options.host.completeTask({
            status: "finished",
            finishReason: currentState.finishReason,
          });
          return {
            graphState: { kind: "created", graphState: currentState },
            pendingInput: { kind: "empty" },
            lastDecision: currentDecision.kind === "decided"
              ? currentDecision
              : {
                  kind: "decided",
                  decision: {
                    type: "finished",
                    finishReason: currentState.finishReason,
                  },
                },
            lastError: { kind: "none" },
          };
        }

        const failedDecision = requireFailedDecision(currentDecision);
        currentState.taskStatus = "failed";
        currentState.finishReason = "running";
        await this.options.host.completeTask({
          status: "failed",
          failureReason: failedDecision.errorMessage,
        });
        return {
          graphState: { kind: "created", graphState: currentState },
          pendingInput: { kind: "empty" },
          lastDecision: currentDecision,
          lastError: { kind: "failed", message: failedDecision.errorMessage },
        };
      }

      const settled = await Promise.race(
        [...inflight].map(async (runner) => ({
          runner,
          result: await runner.promise,
        })),
      );
      inflight.delete(settled.runner);
      const reduced = applyAgentResultToGraphState(currentState, settled.result);
      currentState = reduced.state;
      currentDecision = { kind: "decided", decision: reduced.decision };
    }
  }
}

function resolveCheckpointGraphState(
  checkpoint: CheckpointSlot,
  topology: GraphTaskState["topology"],
): GraphTaskState {
  if (checkpoint.kind === "found" && checkpoint.checkpoint.graphState.kind === "created") {
    return checkpoint.checkpoint.graphState.graphState;
  }
  return createEmptyGraphTaskState({
    topology,
  });
}

function resolveInitialRuntimeDecision(
  state: RuntimeEnvelope,
  currentState: GraphTaskState,
): LastDecisionSlot {
  if (state.pendingInput.kind === "received") {
    return {
      kind: "decided",
      decision: createUserDispatchDecision(currentState, {
        targetAgentId: state.pendingInput.event.targetAgentId,
        content: state.pendingInput.event.content,
      }),
    };
  }
  return state.lastDecision;
}

function resolveFinishReason(
  decision: LastDecisionSlot,
  currentState: GraphTaskState,
): string {
  if (decision.kind === "decided" && decision.decision.type === "finished") {
    return decision.decision.finishReason;
  }
  if (currentState.finishReason) {
    return currentState.finishReason;
  }
  return "idle";
}

function requireFailedDecision(
  decision: LastDecisionSlot,
): Extract<GraphRoutingDecision, { type: "failed" }> {
  if (decision.kind === "decided" && decision.decision.type === "failed") {
    return decision.decision;
  }
  throw new Error("期望 failed decision");
}
