import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MarkdownMessage } from "./chat-markdown";

export function AgentHistoryMarkdown({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  return <MarkdownMessage content={content} className={className} />;
}

export function renderAgentHistoryDetailToStaticHtml(content: string): string {
  return renderToStaticMarkup(<AgentHistoryMarkdown content={content} />);
}
