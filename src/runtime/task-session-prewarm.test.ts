import test from "node:test";
import assert from "node:assert/strict";

import type { TaskAgentRecord, TopologyRecord } from "@shared/types";

import { resolveTaskAgentNamesToPrewarm } from "./task-session-prewarm";

test("resolveTaskAgentNamesToPrewarm 不会为仅作为 spawn 模板存在的静态 agent 预建 session", () => {
  const topology: TopologyRecord = {
    nodes: ["初筛", "正方", "反方", "裁决总结", "疑点辩论"],
    edges: [
      { source: "初筛", target: "疑点辩论", triggerOn: "association", messageMode: "last" },
      { source: "疑点辩论", target: "初筛", triggerOn: "association", messageMode: "last" },
    ],
    langgraph: {
      start: {
        id: "__start__",
        targets: ["初筛"],
      },
      end: null,
    },
    spawnRules: [
      {
        id: "spawn-rule:疑点辩论",
        name: "疑点辩论",
        spawnNodeName: "疑点辩论",
        sourceTemplateName: "初筛",
        entryRole: "正方",
        spawnedAgents: [
          { role: "正方", templateName: "正方" },
          { role: "反方", templateName: "反方" },
          { role: "裁决总结", templateName: "裁决总结" },
        ],
        edges: [
          { sourceRole: "正方", targetRole: "反方", triggerOn: "needs_revision", messageMode: "last" },
          { sourceRole: "反方", targetRole: "正方", triggerOn: "needs_revision", messageMode: "last" },
          { sourceRole: "正方", targetRole: "裁决总结", triggerOn: "approved", messageMode: "last" },
          { sourceRole: "反方", targetRole: "裁决总结", triggerOn: "approved", messageMode: "last" },
        ],
        exitWhen: "all_completed",
        reportToTemplateName: "初筛",
        reportToTriggerOn: "association",
      },
    ],
  };
  const taskAgents: TaskAgentRecord[] = [
    {
      id: "1",
      taskId: "task-1",
      name: "初筛",
      opencodeSessionId: null,
      opencodeAttachBaseUrl: null,
      status: "idle",
      runCount: 0,
    },
    {
      id: "2",
      taskId: "task-1",
      name: "正方",
      opencodeSessionId: null,
      opencodeAttachBaseUrl: null,
      status: "idle",
      runCount: 0,
    },
    {
      id: "3",
      taskId: "task-1",
      name: "反方",
      opencodeSessionId: null,
      opencodeAttachBaseUrl: null,
      status: "idle",
      runCount: 0,
    },
    {
      id: "4",
      taskId: "task-1",
      name: "裁决总结",
      opencodeSessionId: null,
      opencodeAttachBaseUrl: null,
      status: "idle",
      runCount: 0,
    },
  ];

  assert.deepEqual(resolveTaskAgentNamesToPrewarm(topology, taskAgents), ["初筛"]);
});
