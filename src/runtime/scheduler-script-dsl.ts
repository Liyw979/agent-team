import assert from "node:assert/strict";

export type ParsedSchedulerScriptLine =
  | {
      kind: "state";
      value: "finished";
      raw: string;
    }
  | {
      kind: "message";
      sender: string;
      body: string;
      raw: string;
      targets: string[];
    };

export function parseSchedulerScriptLines(script: string[]): ParsedSchedulerScriptLine[] {
  return script
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(parseSchedulerScriptLine);
}

export function parseSchedulerScriptLine(line: string): ParsedSchedulerScriptLine {
  const separatorIndex = line.indexOf(":");
  assert.notEqual(separatorIndex, -1, `脚本缺少 sender/state 前缀：${line}`);
  const sender = line.slice(0, separatorIndex).trim();
  const content = line.slice(separatorIndex + 1).trim();

  if (sender === "state") {
    assert.equal(content, "finished", `暂仅支持 state: finished，实际收到：${line}`);
    return {
      kind: "state",
      value: "finished",
      raw: line,
    };
  }

  const dispatch = extractInlineDispatch(content);
  return {
    kind: "message",
    sender,
    body: dispatch?.body ?? content,
    raw: line,
    targets: dispatch?.targets ?? [],
  };
}

export function isDispatchAssertionLine(
  line: Extract<ParsedSchedulerScriptLine, { kind: "message" }>,
): boolean {
  return line.body.length === 0 && line.targets.length > 0;
}

export function formatSchedulerScriptMessageLine(input: {
  sender: string;
  body: string;
  targets: string[];
}): string {
  const targetsText = input.targets.map((target) => `@${target}`).join(" ");
  if (input.body.length === 0) {
    return `${input.sender}: ${targetsText}`.trimEnd();
  }
  if (targetsText.length === 0) {
    return `${input.sender}: ${input.body}`;
  }
  return `${input.sender}: ${input.body} ${targetsText}`;
}

export function extractLeadingMention(content: string): string {
  const match = content.trim().match(/^@(\S+)/u);
  return match?.[1] ?? "";
}

export function stripLeadingMention(content: string): string {
  return content.trim().replace(/^@\S+\s*/u, "").trim();
}

export function parseRuntimeAlias(rawName: string): { templateName: string; index: number } | null {
  const legacyMatch = rawName.match(/^(.*)-([1-9]\d*)$/u);
  if (legacyMatch) {
    const templateName = legacyMatch[1]?.trim() ?? "";
    const index = Number.parseInt(legacyMatch[2] ?? "", 10);
    if (templateName && Number.isInteger(index) && index > 0) {
      return { templateName, index };
    }
  }

  return null;
}

function extractInlineDispatch(content: string): { body: string; targets: string[] } | null {
  const trimmed = content.trim();
  if (/^@\S+(?:\s+@\S+)*$/u.test(trimmed)) {
    return {
      body: "",
      targets: [...trimmed.matchAll(/@(\S+)/gu)]
        .map((item) => item[1] ?? "")
        .filter(Boolean),
    };
  }
  const match = trimmed.match(/@\S+(?:\s+@\S+)*\s*$/u);
  if (!match || typeof match.index !== "number") {
    return null;
  }
  const mentionStartIndex = match.index;
  if (mentionStartIndex > 0) {
    const previousChar = trimmed[mentionStartIndex - 1] ?? "";
    if (!/[\s，,。.!?！？；;：:]/u.test(previousChar)) {
      return null;
    }
  }

  const targets = [...(match[0] ?? "").matchAll(/@(\S+)/gu)]
    .map((item) => item[1] ?? "")
    .filter(Boolean);
  if (targets.length === 0) {
    return null;
  }

  const body = trimmed.slice(0, mentionStartIndex).trimEnd();
  return {
    body,
    targets,
  };
}
