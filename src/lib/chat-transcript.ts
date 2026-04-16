import type { ChatMessageItem } from "./chat-messages";

export const SYSTEM_SENDER_LABEL = "Ocustrater";

interface FormatChatTranscriptOptions {
  locale?: string;
  timeZone?: string;
}

export function getChatSenderLabel(sender: string) {
  if (sender === "system") {
    return SYSTEM_SENDER_LABEL;
  }
  return sender;
}

export function formatChatTranscriptTimestamp(
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
  return messages
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
}
