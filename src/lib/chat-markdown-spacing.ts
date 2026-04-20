import type { CSSProperties } from "react";

export type ChatMarkdownSpacing = {
  blockSpacingEm: number;
  listItemSpacingRem: number;
};

type ChatMarkdownSpacingStyle = CSSProperties & Record<"--chat-markdown-block-spacing" | "--chat-markdown-list-item-spacing", string>;

export function getChatMarkdownSpacing(): ChatMarkdownSpacing {
  return {
    blockSpacingEm: 0.1625,
    listItemSpacingRem: 0.06,
  };
}

export function getChatMarkdownSpacingStyle(): ChatMarkdownSpacingStyle {
  const spacing = getChatMarkdownSpacing();
  return {
    "--chat-markdown-block-spacing": `${spacing.blockSpacingEm}em`,
    "--chat-markdown-list-item-spacing": `${spacing.listItemSpacingRem}rem`,
  };
}
