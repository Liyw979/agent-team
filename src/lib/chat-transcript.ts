import type { ChatMessageItem } from "./chat-messages";

const SYSTEM_SENDER_LABEL = "Orchestrator";

interface FormatChatTranscriptOptions {
  locale?: string;
  timeZone?: string;
  logFilePath?: string | null;
  taskUrl?: string | null;
}

export function getChatSenderLabel(sender: string) {
  if (sender === "system") {
    return SYSTEM_SENDER_LABEL;
  }
  return sender;
}

function formatChatTranscriptTimestamp(
  timestamp: string,
  options: FormatChatTranscriptOptions = {},
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
  options: FormatChatTranscriptOptions = {},
) {
  const transcriptBody = messages
    .map((message) =>
      [
        getChatSenderLabel(message.sender),
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

  const headerLines = [
    options.logFilePath ? `日志: ${options.logFilePath}` : null,
    options.taskUrl ? `url: ${options.taskUrl}` : null,
  ].filter((line): line is string => Boolean(line));

  if (headerLines.length === 0) {
    return transcriptBody;
  }

  return `${headerLines.join("\n")}\n\n${transcriptBody}`;
}
