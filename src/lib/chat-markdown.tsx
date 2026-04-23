import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

import { getChatMarkdownSpacingStyle } from "./chat-markdown-spacing";
import { getChatMarkdownStaticStyleSheet } from "./chat-markdown-style-sheet";
import { getChatMarkdownTypographyStyle } from "./chat-markdown-typography";

const MARKDOWN_REMARK_PLUGINS = [remarkGfm, remarkBreaks];

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
        h1: ({ node: _node, ...props }) => <p data-chat-markdown-role="heading" {...props} />,
        h2: ({ node: _node, ...props }) => <p data-chat-markdown-role="heading" {...props} />,
        h3: ({ node: _node, ...props }) => <p data-chat-markdown-role="heading" {...props} />,
        h4: ({ node: _node, ...props }) => <p data-chat-markdown-role="heading" {...props} />,
        h5: ({ node: _node, ...props }) => <p data-chat-markdown-role="heading" {...props} />,
        h6: ({ node: _node, ...props }) => <p data-chat-markdown-role="heading" {...props} />,
        strong: ({ node: _node, ...props }) => <strong data-chat-markdown-role="strong" {...props} />,
        em: ({ node: _node, ...props }) => <span data-chat-markdown-role="em" {...props} />,
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

export function MarkdownMessage({
  content,
  className,
  inheritTypography = false,
  style,
}: {
  content: string;
  className?: string;
  inheritTypography?: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className={className ? `chat-markdown ${className}` : "chat-markdown"}
      style={{
        ...getChatMarkdownSpacingStyle(),
        ...(inheritTypography ? {} : getChatMarkdownTypographyStyle()),
        ...style,
      }}
    >
      <MarkdownContent content={content} />
    </div>
  );
}

export function renderMarkdownToStaticHtml(content: string): string {
  return renderToStaticMarkup(
    <>
      <style>{getChatMarkdownStaticStyleSheet()}</style>
      <MarkdownMessage content={content} />
    </>,
  );
}
