import type { CSSProperties } from "react";

export type ChatMarkdownTypography = {
  bodyFontSizeRem: number;
  headingFontSizeEm: number;
  codeFontSizeEm: number;
};

type ChatMarkdownTypographyStyle = CSSProperties & Record<
  "--chat-markdown-font-size" | "--chat-markdown-heading-font-size" | "--chat-markdown-code-font-size",
  string
>;

export function getChatMarkdownTypography(): ChatMarkdownTypography {
  return {
    bodyFontSizeRem: 0.875,
    headingFontSizeEm: 1,
    codeFontSizeEm: 1,
  };
}

export function isChatMarkdownFontSizeUnified(typography: ChatMarkdownTypography): boolean {
  return typography.headingFontSizeEm === 1 && typography.codeFontSizeEm === 1;
}

export function getChatMarkdownTypographyStyle(): ChatMarkdownTypographyStyle {
  const typography = getChatMarkdownTypography();
  return {
    "--chat-markdown-font-size": `${typography.bodyFontSizeRem}rem`,
    "--chat-markdown-heading-font-size": `${typography.headingFontSizeEm}em`,
    "--chat-markdown-code-font-size": `${typography.codeFontSizeEm}em`,
  };
}
