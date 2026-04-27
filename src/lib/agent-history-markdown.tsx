import { renderToStaticMarkup } from "react-dom/server";
import type { CSSProperties } from "react";

import { MarkdownMessage } from "./chat-markdown";

const AGENT_HISTORY_MARKDOWN_STYLE = {
  "--chat-markdown-block-spacing": "0.08em",
  "--chat-markdown-list-item-spacing": "0.02rem",
  "--chat-markdown-list-padding-left": "0.92rem",
  "--chat-markdown-inline-code-padding": "0.04rem 0.22rem",
  "--chat-markdown-pre-padding": "0.18rem 0.42rem",
} as CSSProperties;

export function compactAgentHistoryMarkdownContent(content: string): string {
  return content
    .replace(/\r\n?/gu, "\n")
    .replace(/\n[ \t]*\n+/gu, "\n");
}

export function AgentHistoryMarkdown({
  content,
  className,
  style,
}: {
  content: string;
  className?: string;
  style?: CSSProperties;
}) {
  const normalizedContent = compactAgentHistoryMarkdownContent(content);

  if (!className && !style) {
    return (
      <MarkdownMessage
        content={normalizedContent}
        inheritTypography
        style={AGENT_HISTORY_MARKDOWN_STYLE}
      />
    );
  }

  if (className) {
    return (
      <MarkdownMessage
        content={normalizedContent}
        className={className}
        inheritTypography
        style={style ? { ...AGENT_HISTORY_MARKDOWN_STYLE, ...style } : AGENT_HISTORY_MARKDOWN_STYLE}
      />
    );
  }

  return (
    <MarkdownMessage
      content={normalizedContent}
      inheritTypography
      style={{ ...AGENT_HISTORY_MARKDOWN_STYLE, ...style }}
    />
  );
}

export function renderAgentHistoryDetailToStaticHtml(content: string): string {
  return renderToStaticMarkup(<AgentHistoryMarkdown content={content} />);
}
