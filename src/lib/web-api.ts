import type {
  AgentTeamEvent,
  AgentRuntimeSnapshot,
  GetTaskRuntimePayload,
  OpenAgentTerminalPayload,
  SubmitTaskPayload,
  TaskSnapshot,
  UiSnapshotPayload,
} from "@shared/types";
import { normalizeOptionalString } from "@shared/object-utils";

function buildQuery(params: Record<string, string>) {
  return new URLSearchParams(params).toString();
}

async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `请求失败：${response.status}`);
  }
  return response.json() as Promise<T>;
}

export function readLaunchTaskIdFromSearch(search: string): string | null {
  const params = new URLSearchParams(search);
  return normalizeOptionalString(params.get("taskId")) ?? null;
}

export function readLaunchParams() {
  return {
    taskId: readLaunchTaskIdFromSearch(window.location.search),
  };
}

export function fetchUiSnapshot(params: { taskId: string }) {
  return fetchJson<UiSnapshotPayload>(`/api/ui-snapshot?${buildQuery(params)}`);
}

export function getTaskRuntime(payload: Pick<GetTaskRuntimePayload, "taskId">) {
  return fetchJson<AgentRuntimeSnapshot[]>(`/api/tasks/runtime?${buildQuery({
    taskId: payload.taskId,
  })}`);
}

export function submitTask(payload: SubmitTaskPayload) {
  return fetchJson<TaskSnapshot>("/api/tasks/submit", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

export async function openAgentTerminal(payload: OpenAgentTerminalPayload) {
  await fetchJson<{ ok: true }>("/api/tasks/open-agent-terminal", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

export function subscribeAgentTeamEvents(
  params: {
    taskId: string;
  },
  listener: (event: AgentTeamEvent) => void,
) {
  const source = new EventSource(`/api/events?${buildQuery(params)}`);
  source.onmessage = (message) => {
    try {
      const payload = JSON.parse(message.data) as AgentTeamEvent | { type: "connected" };
      if (payload.type === "connected") {
        return;
      }
      listener(payload);
    } catch {
      // ignore malformed events
    }
  };
  return () => {
    source.close();
  };
}
