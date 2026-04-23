import test from "node:test";
import assert from "node:assert/strict";

import type { TaskAgentRecord, TopologyRecord } from "@shared/types";

import { resolveTaskAgentIdsToPrewarm } from "./task-session-prewarm";

test("resolveTaskAgentIdsToPrewarm 不会为仅作为 spawn 模板存在的静态 agent 预建 session", () => {
  const topology: TopologyRecord = {
    nodes: ["线索发现", "漏洞论证", "漏洞挑战", "讨论总结", "疑点辩论"],
    edges: [
      { source: "线索发现", target: "疑点辩论", triggerOn: "transfer", messageMode: "last" },
      { source: "疑点辩论", target: "线索发现", triggerOn: "transfer", messageMode: "last" },
    ],
    langgraph: {
      start: {
        id: "__start__",
        targets: ["线索发现"],
      },
      end: null,
    },
    spawnRules: [
      {
        id: "疑点辩论",
        spawnNodeName: "疑点辩论",
        sourceTemplateName: "线索发现",
        entryRole: "漏洞论证",
        spawnedAgents: [
          { role: "漏洞论证", templateName: "漏洞论证" },
          { role: "漏洞挑战", templateName: "漏洞挑战" },
          { role: "讨论总结", templateName: "讨论总结" },
        ],
        edges: [
          { sourceRole: "漏洞论证", targetRole: "漏洞挑战", triggerOn: "continue", messageMode: "last" },
          { sourceRole: "漏洞挑战", targetRole: "漏洞论证", triggerOn: "continue", messageMode: "last" },
          { sourceRole: "漏洞论证", targetRole: "讨论总结", triggerOn: "complete", messageMode: "last" },
          { sourceRole: "漏洞挑战", targetRole: "讨论总结", triggerOn: "complete", messageMode: "last" },
        ],
        exitWhen: "all_completed",
        reportToTemplateName: "线索发现",
        reportToTriggerOn: "transfer",
      },
    ],
  };
  const taskAgents: TaskAgentRecord[] = [
    {
      taskId: "task-1",
      id: "线索发现",
      opencodeSessionId: null,
      opencodeAttachBaseUrl: null,
      status: "idle",
      runCount: 0,
    },
    {
      taskId: "task-1",
      id: "漏洞论证",
      opencodeSessionId: null,
      opencodeAttachBaseUrl: null,
      status: "idle",
      runCount: 0,
    },
    {
      taskId: "task-1",
      id: "漏洞挑战",
      opencodeSessionId: null,
      opencodeAttachBaseUrl: null,
      status: "idle",
      runCount: 0,
    },
    {
      taskId: "task-1",
      id: "讨论总结",
      opencodeSessionId: null,
      opencodeAttachBaseUrl: null,
      status: "idle",
      runCount: 0,
    },
  ];

  assert.deepEqual(resolveTaskAgentIdsToPrewarm(topology, taskAgents), ["线索发现"]);
});
