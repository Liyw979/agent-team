export function calculateAgentCardPromptLineCount(input: {
  viewportHeight: number;
  cardCount: number;
  gapPx: number;
  reservedHeightPx: number;
  lineHeightPx: number;
}) {
  const cardCount = Math.max(1, Math.floor(input.cardCount));
  const viewportHeight = Math.max(0, input.viewportHeight);
  const gapPx = Math.max(0, input.gapPx);
  const reservedHeightPx = Math.max(0, input.reservedHeightPx);
  const lineHeightPx = Math.max(1, input.lineHeightPx);

  const availableHeight = viewportHeight - Math.max(0, (cardCount - 1) * gapPx);
  const perCardHeight = availableHeight / cardCount;
  const promptHeight = perCardHeight - reservedHeightPx;

  return Math.max(1, Math.floor(promptHeight / lineHeightPx));
}

export function calculateAgentCardListGap(input: {
  viewportHeight: number;
  cardCount: number;
  promptCardCount: number;
  promptLineCount: number;
  minGapPx: number;
  reservedHeightPx: number;
  lineHeightPx: number;
  emptyStateHeightPx: number;
}) {
  const cardCount = Math.max(1, Math.floor(input.cardCount));
  const promptCardCount = Math.min(cardCount, Math.max(0, Math.floor(input.promptCardCount)));
  const emptyCardCount = Math.max(0, cardCount - promptCardCount);
  const viewportHeight = Math.max(0, input.viewportHeight);
  const minGapPx = Math.max(0, input.minGapPx);
  const reservedHeightPx = Math.max(0, input.reservedHeightPx);
  const lineHeightPx = Math.max(1, input.lineHeightPx);
  const emptyStateHeightPx = Math.max(0, input.emptyStateHeightPx);
  const promptLineCount = Math.max(1, Math.floor(input.promptLineCount));

  if (cardCount <= 1) {
    return 0;
  }

  const promptCardHeight = reservedHeightPx + promptLineCount * lineHeightPx;
  const emptyCardHeight = reservedHeightPx + emptyStateHeightPx;
  const minimumTotalGap = (cardCount - 1) * minGapPx;
  const totalCardHeight = promptCardCount * promptCardHeight + emptyCardCount * emptyCardHeight;
  const remainingHeight = viewportHeight - totalCardHeight - minimumTotalGap;

  if (remainingHeight <= 0) {
    return minGapPx;
  }

  return minGapPx + remainingHeight / (cardCount - 1);
}

const AGENT_CARD_MIN_GAP_PX = 6;
const AGENT_CARD_LINE_HEIGHT_PX = 18;
const AGENT_CARD_EMPTY_STATE_HEIGHT_PX = 20;
const AGENT_CARD_ERROR_BANNER_HEIGHT_PX = 42;
const AGENT_CARD_RESERVED_HEIGHT_PX = 40;

export function calculateAgentCardPanelLayout(input: {
  viewportHeight: number;
  cardCount: number;
  promptCardCount: number;
  hasErrorBanner: boolean;
}) {
  const viewportHeight = Math.max(0, input.viewportHeight - (input.hasErrorBanner ? AGENT_CARD_ERROR_BANNER_HEIGHT_PX : 0));
  const promptLineCount = calculateAgentCardPromptLineCount({
    viewportHeight,
    cardCount: input.cardCount,
    gapPx: AGENT_CARD_MIN_GAP_PX,
    reservedHeightPx: AGENT_CARD_RESERVED_HEIGHT_PX,
    lineHeightPx: AGENT_CARD_LINE_HEIGHT_PX,
  });

  return {
    promptLineCount,
    gapPx: calculateAgentCardListGap({
      viewportHeight,
      cardCount: input.cardCount,
      promptCardCount: input.promptCardCount,
      promptLineCount,
      minGapPx: AGENT_CARD_MIN_GAP_PX,
      reservedHeightPx: AGENT_CARD_RESERVED_HEIGHT_PX,
      lineHeightPx: AGENT_CARD_LINE_HEIGHT_PX,
      emptyStateHeightPx: AGENT_CARD_EMPTY_STATE_HEIGHT_PX,
    }),
  };
}
