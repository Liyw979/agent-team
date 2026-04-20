import fs from "node:fs";
import path from "node:path";

export interface UiHostStateRecord {
  pid: number;
  port: number;
  cwd: string;
  taskId: string;
  startedAt: string;
  version: string;
}

export function getUiHostStatePath(cwd: string): string {
  return path.join(cwd, ".agentflow", "ui-host.json");
}

export function normalizeUiHostStateRecord(value: unknown): UiHostStateRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Partial<UiHostStateRecord>;
  if (
    typeof record.pid !== "number"
    || !Number.isFinite(record.pid)
    || typeof record.port !== "number"
    || !Number.isFinite(record.port)
    || typeof record.cwd !== "string"
    || record.cwd.trim().length === 0
    || typeof record.taskId !== "string"
    || record.taskId.trim().length === 0
    || typeof record.startedAt !== "string"
    || record.startedAt.trim().length === 0
    || typeof record.version !== "string"
    || record.version.trim().length === 0
  ) {
    return null;
  }

  return {
    pid: Math.trunc(record.pid),
    port: Math.trunc(record.port),
    cwd: record.cwd,
    taskId: record.taskId,
    startedAt: record.startedAt,
    version: record.version,
  };
}

export function isUiHostStateReusable(
  record: UiHostStateRecord,
  target: {
    cwd: string;
    taskId: string;
    version: string;
  },
): boolean {
  return record.cwd === target.cwd
    && record.taskId === target.taskId
    && record.version === target.version;
}

export function readUiHostState(cwd: string): UiHostStateRecord | null {
  const statePath = getUiHostStatePath(cwd);
  if (!fs.existsSync(statePath)) {
    return null;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return normalizeUiHostStateRecord(raw);
  } catch {
    return null;
  }
}

export function writeUiHostState(cwd: string, record: UiHostStateRecord): void {
  const statePath = getUiHostStatePath(cwd);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(record, null, 2));
}

export function deleteUiHostState(cwd: string): void {
  const statePath = getUiHostStatePath(cwd);
  if (fs.existsSync(statePath)) {
    fs.rmSync(statePath);
  }
}
