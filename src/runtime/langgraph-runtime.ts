import { Annotation, END, MemorySaver, START, StateGraph } from "@langchain/langgraph";

import {
  applyAgentResultToGraphState,
  createGraphTaskState,
  createUserDispatchDecision,
  type GraphRoutingDecision,
} from "./gating-router";
import type { GraphTaskState } from "./gating-state";
import type {
  LangGraphBatchRunner,
  LangGraphInputEvent,
  LangGraphTaskLoopHost,
} from "./langgraph-host";

interface RuntimeEnvelope {
  graphState: GraphTaskState | null;
  pendingInput: LangGraphInputEvent | null;
  lastDecision: GraphRoutingDecision | null;
  lastError: string | null;
}

function takeLatestValue<T>(...values: [previous: T, next: T]): T {
  return values[1];
}

const RuntimeAnnotation = Annotation.Root({
  graphState: Annotation<GraphTaskState | null>({
    reducer: takeLatestValue,
    default: () => null,
  }),
  pendingInput: Annotation<LangGraphInputEvent | null>({
    reducer: takeLatestValue,
    default: () => null,
  }),
  lastDecision: Annotation<GraphRoutingDecision | null>({
    reducer: takeLatestValue,
    default: () => null,
  }),
  lastError: Annotation<string | null>({
    reducer: takeLatestValue,
    default: () => null,
  }),
});

function runtimeConfig(taskId: string) {
  return {
    configurable: {
      thread_id: taskId,
    },
  };
}

export class LangGraphRuntime {
  private readonly checkpointer: MemorySaver;
  private readonly graph;

  constructor(
    private readonly options: {
      host: LangGraphTaskLoopHost;
    },
  ) {
    this.checkpointer = new MemorySaver();

    const builder = new StateGraph(RuntimeAnnotation)
      .addNode("task_loop", async (state: RuntimeEnvelope) => this.runTaskLoop(state))
      .addNode("task_finished", async (state: RuntimeEnvelope) => state)
      .addNode("task_failed", async (state: RuntimeEnvelope) => state)
      .addEdge(START, "task_loop")
      .addConditionalEdges("task_loop", (state: RuntimeEnvelope) => {
        if (state.lastDecision?.type === "failed") {
          return "task_failed";
        }
        return "task_finished";
      })
      .addEdge("task_finished", END)
      .addEdge("task_failed", END);

    this.graph = builder.compile({
      checkpointer: this.checkpointer,
      name: "agent-team-task-runtime",
    });
  }

  async startTask(input: {
    taskId: string;
    topology: GraphTaskState["topology"];
    initialInput: LangGraphInputEvent;
  }): Promise<GraphTaskState> {
    const graphState = createGraphTaskState({
      taskId: input.taskId,
      topology: input.topology,
    });
    const result = await this.graph.invoke(
      {
        graphState,
        pendingInput: input.initialInput,
        lastDecision: null,
        lastError: null,
      } satisfies RuntimeEnvelope,
      runtimeConfig(input.taskId),
    ) as RuntimeEnvelope;
    return result.graphState ?? graphState;
  }

  async resumeTask(input: {
    taskId: string;
    topology: GraphTaskState["topology"];
    event: LangGraphInputEvent;
  }): Promise<GraphTaskState> {
    const existing = await this.getCheckpoint(input.taskId);
    const graphState = existing?.graphState ?? createGraphTaskState({
      taskId: input.taskId,
      topology: input.topology,
    });
    const result = await this.graph.invoke(
      {
        graphState,
        pendingInput: input.event,
        lastDecision: existing?.lastDecision ?? null,
        lastError: null,
      } satisfies RuntimeEnvelope,
      runtimeConfig(input.taskId),
    ) as RuntimeEnvelope;
    return result.graphState ?? graphState;
  }

  async getCheckpoint(taskId: string): Promise<RuntimeEnvelope | null> {
    const state = await this.graph.getState(runtimeConfig(taskId));
    if (!state.values || Object.keys(state.values).length === 0) {
      return null;
    }
    return state.values as RuntimeEnvelope;
  }

  async streamTask(
    taskId: string,
    listener: (state: RuntimeEnvelope | null) => void,
  ): Promise<void> {
    listener(await this.getCheckpoint(taskId));
  }

  async deleteTask(taskId: string): Promise<void> {
    await this.checkpointer.deleteThread(taskId);
  }

  private async runTaskLoop(state: RuntimeEnvelope): Promise<RuntimeEnvelope> {
    const graphState = state.graphState;
    if (!graphState) {
      return {
        ...state,
        lastDecision: {
          type: "failed",
          errorMessage: "graphState 缺失",
        },
        lastError: "graphState 缺失",
      };
    }

    let currentState = graphState;
    let currentDecision: GraphRoutingDecision | null = state.pendingInput
      ? createUserDispatchDecision(currentState, {
        targetAgentId: state.pendingInput.targetAgentId,
        content: state.pendingInput.content,
      })
      : state.lastDecision;

    const inflight = new Map<string, LangGraphBatchRunner>();
    while (true) {
      while (currentDecision?.type === "execute_batch") {
        const runners = await this.options.host.createBatchRunners({
          taskId: currentState.taskId,
          state: currentState,
          batch: currentDecision.batch,
        });
        for (const runner of runners) {
          inflight.set(runner.id, runner);
        }
        currentDecision = null;
      }

      if (inflight.size === 0) {
        if (!currentDecision || currentDecision.type === "finished") {
          currentState.taskStatus = "finished";
          currentState.finishReason = currentDecision?.finishReason ?? currentState.finishReason ?? "idle";
          await this.options.host.completeTask({
            taskId: currentState.taskId,
            status: "finished",
            finishReason: currentState.finishReason,
          });
          return {
            graphState: currentState,
            pendingInput: null,
            lastDecision: currentDecision ?? {
              type: "finished",
              finishReason: currentState.finishReason,
            },
            lastError: null,
          };
        }

        currentState.taskStatus = "failed";
        currentState.finishReason = null;
        await this.options.host.completeTask({
          taskId: currentState.taskId,
          status: "failed",
          failureReason: currentDecision.errorMessage,
        });
        return {
          graphState: currentState,
          pendingInput: null,
          lastDecision: currentDecision,
          lastError: currentDecision.errorMessage,
        };
      }

      const settled = await Promise.race(
        [...inflight.values()].map(async (runner) => ({
          id: runner.id,
          result: await runner.promise,
        })),
      );
      inflight.delete(settled.id);
      const reduced = applyAgentResultToGraphState(currentState, settled.result);
      currentState = reduced.state;
      currentDecision = reduced.decision;
    }
  }
}
