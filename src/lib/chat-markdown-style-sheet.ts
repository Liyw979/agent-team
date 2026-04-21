export function getChatMarkdownStaticStyleSheet(): string {
  return `
    .chat-markdown {
      min-width: 0;
      word-break: break-word;
    }

    .chat-markdown > :first-child {
      margin-top: 0;
    }

    .chat-markdown > :last-child {
      margin-bottom: 0;
    }

    .chat-markdown :is(h1, h2, h3, h4, h5, h6, p, ul, ol, pre, blockquote, table, hr) {
      margin: var(--chat-markdown-block-spacing) 0 0;
    }

    .chat-markdown :is(h1, h2, h3, h4, h5, h6) {
      font-size: var(--chat-markdown-heading-font-size, inherit);
      font-weight: inherit;
    }

    .chat-markdown :is(h1, h2, h3, h4, h5, h6, p, li, blockquote, th, td) {
      font-size: var(--chat-markdown-font-size, inherit);
      line-height: var(--chat-markdown-line-height, inherit);
    }

    .chat-markdown p {
      white-space: pre-wrap;
    }

    .chat-markdown ul {
      list-style-type: disc;
    }

    .chat-markdown ol {
      list-style-type: decimal;
    }

    .chat-markdown :is(ul, ol) {
      padding-left: var(--chat-markdown-list-padding-left, 1.35rem);
    }

    .chat-markdown li + li {
      margin-top: var(--chat-markdown-list-item-spacing);
    }

    .chat-markdown blockquote {
      margin-left: 0;
      padding-left: 0.9rem;
      border-left: 3px solid rgba(44, 74, 63, 0.22);
      opacity: 0.92;
    }

    .chat-markdown a {
      color: inherit;
      text-decoration: underline;
      text-decoration-thickness: 1.5px;
      text-underline-offset: 0.16em;
    }

    .chat-markdown pre {
      overflow-x: auto;
      font-size: var(--chat-markdown-font-size, inherit);
      padding: var(--chat-markdown-pre-padding, 0.3rem 0.65rem);
      border-radius: 10px;
      background: rgba(23, 32, 25, 0.1);
      box-shadow: inset 0 0 0 1px rgba(23, 32, 25, 0.06);
      line-height: var(--chat-markdown-line-height, inherit);
    }

    .chat-markdown code {
      font-family: "IBM Plex Mono", "SFMono-Regular", Consolas, monospace;
      font-size: var(--chat-markdown-code-font-size, inherit);
      line-height: var(--chat-markdown-line-height, inherit);
    }

    .chat-markdown pre > code {
      display: block;
      margin: -0.08em 0 -0.1em;
    }

    .chat-markdown strong {
      font-size: inherit;
      font-weight: 700;
      font-synthesis: weight;
    }

    .chat-markdown :not(pre) > code {
      padding: var(--chat-markdown-inline-code-padding, 0.12rem 0.35rem);
      border-radius: 6px;
      background: rgba(23, 32, 25, 0.08);
    }

    .chat-markdown table {
      display: block;
      width: 100%;
      overflow-x: auto;
      border-collapse: collapse;
    }

    .chat-markdown th,
    .chat-markdown td {
      padding: 0.42rem 0.58rem;
      border: 1px solid rgba(44, 74, 63, 0.14);
      text-align: left;
    }

    .chat-markdown hr {
      border: 0;
      border-top: 1px solid rgba(44, 74, 63, 0.16);
    }
  `
    .replace(/\s+/g, " ")
    .trim();
}
