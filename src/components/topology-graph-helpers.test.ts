import test from "node:test";
import assert from "node:assert/strict";

import {
  getTopologyAgentStatusBadgePresentation,
  getTopologyLoopLimitFailedReviewerName,
  getTopologyNodeHeaderActionOrder,
} from "./topology-graph-helpers";
import type { MessageRecord } from "@shared/types";

function createTaskCompletedMessage(input: {
  id: string;
  content: string;
  status: "failed";
}): MessageRecord {
  return {
    id: input.id,
    taskId: "task-1",
    sender: "system",
    timestamp: "2026-04-23T10:00:00.000Z",
    content: input.content,
    kind: "task-completed",
    status: input.status,
  };
}

function createTaskRoundFinishedMessage(input: {
  id: string;
  content: string;
}): MessageRecord {
  return {
    id: input.id,
    taskId: "task-1",
    sender: "system",
    timestamp: "2026-04-23T10:00:00.000Z",
    content: input.content,
    kind: "task-round-finished",
    finishReason: "round_finished",
  };
}

test("getTopologyAgentStatusBadgePresentation 会把普通 agent 状态映射为 Electron 同款图标与文案", () => {
  const topology = {
    edges: [],
  };

  assert.deepEqual(
    getTopologyAgentStatusBadgePresentation(topology, "Build", "completed"),
    {
      label: "已完成",
      icon: "success",
      className: "border border-[#2c4a3f]/18 bg-[#edf5f0] text-[#2c4a3f]",
      effectClassName: "",
    },
  );

  assert.deepEqual(
    getTopologyAgentStatusBadgePresentation(topology, "Build", "running"),
    {
      label: "运行中",
      icon: "running",
      className:
        "border border-[#d8b14a]/70 bg-[linear-gradient(180deg,#fff7d8_0%,#ffedb8_100%)] text-[#6b5208]",
      effectClassName: "topology-status-badge-running",
    },
  );
});

test("getTopologyAgentStatusBadgePresentation 会把审查 agent 映射为 continue/complete 语义对应的状态徽标", () => {
  const topology = {
    edges: [
      {
        source: "CodeReview",
        target: "Build",
        triggerOn: "continue" as const,
        messageMode: "last" as const,
      },
    ],
  };

  assert.deepEqual(
    getTopologyAgentStatusBadgePresentation(topology, "CodeReview", "completed"),
    {
      label: "已完成判定",
      icon: "success",
      className: "border border-[#2c4a3f]/18 bg-[#edf5f0] text-[#2c4a3f]",
      effectClassName: "",
    },
  );

  assert.deepEqual(
    getTopologyAgentStatusBadgePresentation(topology, "CodeReview", "continue"),
    {
      label: "继续处理",
      icon: "continue",
      className: "border border-[#d6a14a]/55 bg-[#fff7e8] text-[#8a5a12]",
      effectClassName: "",
    },
  );

  assert.deepEqual(
    getTopologyAgentStatusBadgePresentation(topology, "CodeReview", "failed", {
      finalLoopReviewerName: "CodeReview",
    }),
    {
      label: "继续处理，最后一次",
      icon: "continue",
      className: "border border-[#d6a14a]/55 bg-[#fff7e8] text-[#8a5a12]",
      effectClassName: "",
    },
  );
});

test("getTopologyLoopLimitFailedReviewerName 会从任务失败原因里识别超限 reviewer", () => {
  assert.equal(
    getTopologyLoopLimitFailedReviewerName([
      createTaskCompletedMessage({
        id: "completion-1",
        content: "UnitTest -> Build 已连续交流 4 次，任务已结束",
        status: "failed",
      }),
    ]),
    "UnitTest",
  );

  assert.equal(
    getTopologyLoopLimitFailedReviewerName([
      createTaskRoundFinishedMessage({
        id: "completion-2",
        content: "本轮已完成，可继续 @Agent 发起下一轮。",
      }),
    ]),
    null,
  );
});

test("getTopologyNodeHeaderActionOrder 会把 attach 固定排在状态 icon 左边", () => {
  assert.deepEqual(
    getTopologyNodeHeaderActionOrder({
      showAttachButton: true,
    }),
    ["attach", "status"],
  );

  assert.deepEqual(
    getTopologyNodeHeaderActionOrder({
      showAttachButton: false,
    }),
    ["status"],
  );
});
