import type {
  SubmitTaskPayload,
  TaskSnapshot,
  UiSnapshotPayload,
} from "@shared/types";

async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `请求失败：${response.status}`);
  }
  return JSON.parse(await response.text()) as T;
}

export function fetchUiSnapshot() {
  return fetchJson<UiSnapshotPayload>("/api/ui-snapshot");
}

export function submitTask(content: SubmitTaskPayload) {
  return fetchJson<TaskSnapshot>("/api/tasks/submit", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(content),
  });
}

export async function openAgentTerminal(agentId: string) {
  await fetchJson<{ ok: true }>("/api/tasks/open-agent-terminal", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ agentId }),
  });
}
