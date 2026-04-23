import React from "react";
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

export function AgentHistoryMarkdown({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  return (
    <MarkdownMessage
      content={content}
      className={className}
      inheritTypography
      style={AGENT_HISTORY_MARKDOWN_STYLE}
    />
  );
}

export function renderAgentHistoryDetailToStaticHtml(content: string): string {
  return renderToStaticMarkup(<AgentHistoryMarkdown content={content} />);
}
