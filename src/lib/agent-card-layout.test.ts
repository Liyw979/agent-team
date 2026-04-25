import test from "node:test";
import assert from "node:assert/strict";

import {
  calculateAgentCardListGap,
  calculateAgentCardPanelLayout,
  calculateAgentCardPromptLineCount,
} from "./agent-card-layout";

test("calculateAgentCardPromptLineCount 会按可用空间和成员数自动计算 prompt 可展示行数", () => {
  assert.equal(
    calculateAgentCardPromptLineCount({
      viewportHeight: 600,
      cardCount: 5,
      gapPx: 6,
      reservedHeightPx: 56,
      lineHeightPx: 20,
    }),
    2,
  );

  assert.equal(
    calculateAgentCardPromptLineCount({
      viewportHeight: 960,
      cardCount: 3,
      gapPx: 6,
      reservedHeightPx: 56,
      lineHeightPx: 20,
    }),
    13,
  );
});

test("calculateAgentCardPromptLineCount 在空间不足时至少保留 1 行", () => {
  assert.equal(
    calculateAgentCardPromptLineCount({
      viewportHeight: 120,
      cardCount: 5,
      gapPx: 6,
      reservedHeightPx: 56,
      lineHeightPx: 20,
    }),
    1,
  );
});

test("calculateAgentCardListGap 会在卡片高度不变的前提下，把剩余空间分摊到中间留白", () => {
  assert.equal(
    calculateAgentCardListGap({
      viewportHeight: 600,
      cardCount: 5,
      promptCardCount: 4,
      promptLineCount: 2,
      minGapPx: 6,
      reservedHeightPx: 58,
      lineHeightPx: 18,
      emptyStateHeightPx: 20,
    }),
    36.5,
  );

  assert.equal(
    calculateAgentCardListGap({
      viewportHeight: 280,
      cardCount: 5,
      promptCardCount: 4,
      promptLineCount: 1,
      minGapPx: 6,
      reservedHeightPx: 58,
      lineHeightPx: 18,
      emptyStateHeightPx: 20,
    }),
    6,
  );
});

test("团队面板在 340px 可视高度内展示 4 张带 prompt 的卡片时，摘要至少应展示 2 行", () => {
  assert.deepEqual(
    calculateAgentCardPanelLayout({
      viewportHeight: 340,
      cardCount: 4,
      promptCardCount: 4,
      hasErrorBanner: false,
    }),
    {
      promptLineCount: 2,
      gapPx: 12,
    },
  );
});
