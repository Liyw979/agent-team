import type { UtcIsoTimestamp } from "@shared/types";
import type { ChatMessageItem } from "./chat-messages";

const SYSTEM_SENDER_LABEL = "Orchestrator";

interface TranscriptHeaderLine {
  label: "日志" | "网页";
  value: string;
}

interface FormatChatTranscriptOptions {
  locale?: string;
  timeZone?: string;
  headerLines: TranscriptHeaderLine[];
}

export function getChatSenderLabel(sender: string) {
  if (sender === "system") {
    return SYSTEM_SENDER_LABEL;
  }
  return sender;
}

function formatChatTranscriptTimestamp(
  timestamp: UtcIsoTimestamp,
  options: Pick<FormatChatTranscriptOptions, "locale" | "timeZone">,
) {
  return new Intl.DateTimeFormat(options.locale ?? "zh-CN", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: options.timeZone,
  }).format(new Date(timestamp));
}

export function formatChatTranscript(
  messages: ChatMessageItem[],
  options: FormatChatTranscriptOptions,
) {
  const transcriptBody = messages
    .map((message) =>
      [
        getChatSenderLabel(message.senderDisplayName),
        formatChatTranscriptTimestamp(message.timestamp, options),
        message.content.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");

  if (!transcriptBody) {
    return "";
  }

  // 2026-05-29: 用户要求展示层边界先完成确定性标准化，不再向格式化函数传递可空展示字段。
  const headerLines = options.headerLines.map((item) => `${item.label}：${item.value}`);

  if (headerLines.length === 0) {
    return transcriptBody;
  }

  return `${headerLines.join("\n")}\n\n${transcriptBody}`;
}
