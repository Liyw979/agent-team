import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

import { getChatMarkdownSpacingStyle } from "./chat-markdown-spacing";
import { getChatMarkdownTypographyStyle } from "./chat-markdown-typography";

const MARKDOWN_REMARK_PLUGINS = [remarkGfm, remarkBreaks] as const;

function MarkdownContent({
  content,
}: {
  content: string;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={MARKDOWN_REMARK_PLUGINS}
      components={{
        a: ({ node: _node, ...props }) => <a {...props} rel="noreferrer" target="_blank" />,
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

export function MarkdownMessage({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  return (
    <div
      className={className ? `chat-markdown ${className}` : "chat-markdown"}
      style={{
        ...getChatMarkdownSpacingStyle(),
        ...getChatMarkdownTypographyStyle(),
      }}
    >
      <MarkdownContent content={content} />
    </div>
  );
}

export function renderMarkdownToStaticHtml(content: string): string {
  return renderToStaticMarkup(<MarkdownMessage content={content} />);
}
