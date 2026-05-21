import type {
  UiSnapshotPayload,
  TaskSnapshot,
  WorkspaceSnapshot,
} from "@shared/types";

type AppTaskView =
  | {
      kind: "empty";
    }
  | {
      kind: "ready";
      workspace: WorkspaceSnapshot;
      task: TaskSnapshot;
      taskLogFilePath: string;
    };

export interface AppUiSnapshot {
  taskView: AppTaskView;
  taskUrl: string;
}

export function createInitialAppUiSnapshot(): AppUiSnapshot {
  return {
    taskView: EMPTY_TASK_VIEW,
    taskUrl: "",
  };
}

const EMPTY_TASK_VIEW: AppTaskView = {
  kind: "empty",
};

function buildTaskView(payload: UiSnapshotPayload): AppTaskView {
  if (payload.kind === "workspace") {
    return EMPTY_TASK_VIEW;
  }

  return {
    kind: "ready",
    workspace: payload.workspace,
    task: payload.task,
    taskLogFilePath: payload.taskLogFilePath,
  };
}

export function resolveAppUiSnapshot(payload: UiSnapshotPayload): AppUiSnapshot {
  return {
    taskView: buildTaskView(payload),
    taskUrl: payload.taskUrl,
  };
}
