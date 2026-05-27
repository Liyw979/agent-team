import {
  DEFAULT_TOPOLOGY_TRIGGER,
  getTopologyNodeRecords,
  type GroupRule,
  type TopologyAgentNodeRecord,
  type TopologyGroupNodeRecord,
  type TopologyNodeRecord,
  type TopologyRecord,
} from "@shared/types";

const DEBATE_TURN_TRIGGER = "<respond>";
const DEBATE_SUMMARY_TRIGGER = "<finalize>";
const REQUIRED_MAX_TRIGGER_ROUNDS = 4;

interface DebateGroupDraftInput {
  teamName: string;
  sourceTemplateName: string;
  proTemplateName: string;
  conTemplateName: string;
  summaryTemplateName: string;
  reportToTemplateName: string;
}

function sanitizeRuleId(value: string): string {
  const normalized = value.trim().replace(/\s+/g, "-");
  return normalized.length > 0 ? normalized : "dynamic-team";
}

function buildGroupRuleId(teamName: string): string {
  return `group-rule:${sanitizeRuleId(teamName)}`;
}

function ensureNodeRecord(records: TopologyNodeRecord[], node: TopologyNodeRecord): TopologyNodeRecord[] {
  const existingIndex = records.findIndex((item) => item.id === node.id);
  if (existingIndex < 0) {
    return [...records, node];
  }
  const next = [...records];
  next[existingIndex] = node;
  return next;
}

export function getTopologyDisplayNodeIds(
  topology: Pick<TopologyRecord, "nodes" | "nodeRecords" | "groupRules">,
  candidateNodeIds: string[],
): string[] {
  const candidateNodeIdSet = new Set(candidateNodeIds);
  const nodeRecords = getTopologyNodeRecords(topology as TopologyRecord);
  const groupAgentTemplateNames = new Set(
    topology.groupRules?.flatMap((rule) => rule.members.map((agent) => agent.templateName)) ?? [],
  );
  const latestRuntimeNodeIdByTemplate = new Map<string, string>();
  const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const resolveRuntimeNodeIndex = (templateName: string, runtimeNodeId: string) => {
    const match = new RegExp(`^${escapeRegExp(templateName)}-(\\d+)$`).exec(runtimeNodeId);
    return match ? Number.parseInt(match[1] ?? "0", 10) : Number.MAX_SAFE_INTEGER;
  };

  for (const templateName of groupAgentTemplateNames) {
    const runtimeNodeIds = candidateNodeIds
      .filter((nodeId) => new RegExp(`^${escapeRegExp(templateName)}-(\\d+)$`).test(nodeId))
      .sort((left, right) =>
        resolveRuntimeNodeIndex(templateName, left) - resolveRuntimeNodeIndex(templateName, right));
    const latestRuntimeNodeId = runtimeNodeIds.at(-1);
    if (latestRuntimeNodeId) {
      latestRuntimeNodeIdByTemplate.set(templateName, latestRuntimeNodeId);
    }
  }

  const orderedTemplateNodeIds = topology.nodes.length > 0
    ? topology.nodes
    : nodeRecords
      .filter((node) => node.kind !== "group")
      .map((node) => node.id);

  return orderedTemplateNodeIds.flatMap((nodeId) => {
    const latestRuntimeNodeId = latestRuntimeNodeIdByTemplate.get(nodeId);
    if (latestRuntimeNodeId) {
      return [latestRuntimeNodeId];
    }
    if (candidateNodeIdSet.has(nodeId)) {
      return [nodeId];
    }
    return [];
  });
}

export function upsertDebateGroupDraft(
  topology: TopologyRecord,
  input: DebateGroupDraftInput,
): TopologyRecord {
  // 要求记录：
  // 1. agent 与 group 是不同类型，禁止生成半节点记录。
  // 2. 节点记录禁止可空字段，默认值必须在草稿写入时补齐。
  const teamName = input.teamName.trim();
  if (!teamName) {
    throw new Error("动态团队名称不能为空。");
  }

  const groupRuleId = buildGroupRuleId(teamName);
  const groupNodeId = teamName;
  let nodeRecords = getTopologyNodeRecords(topology).map((node) => ({ ...node }));
  for (const templateName of [
    input.sourceTemplateName,
    input.proTemplateName,
    input.conTemplateName,
    input.summaryTemplateName,
    input.reportToTemplateName,
  ]) {
    if (!nodeRecords.some((node) => node.id === templateName)) {
      const nextAgentNode: TopologyAgentNodeRecord = {
        id: templateName,
        kind: "agent",
        templateName,
        initialMessageRouting: { mode: "inherit" },
        prompt: "",
        writable: false,
      };
      nodeRecords.push(nextAgentNode);
    }
  }
  const nextGroupNode: TopologyGroupNodeRecord = {
    id: groupNodeId,
    kind: "group",
    templateName: input.proTemplateName,
    initialMessageRouting: { mode: "inherit" },
    groupRuleId,
  };
  nodeRecords = ensureNodeRecord(nodeRecords, nextGroupNode);

  const nodeIds = topology.nodes.length > 0 ? [...topology.nodes] : nodeRecords
    .filter((node) => node.kind === "agent")
    .map((node) => node.id);
  for (const templateName of [
    input.sourceTemplateName,
    input.proTemplateName,
    input.conTemplateName,
    input.summaryTemplateName,
    input.reportToTemplateName,
  ]) {
    if (!nodeIds.includes(templateName)) {
      nodeIds.push(templateName);
    }
  }

  const groupRule: GroupRule = {
    id: groupRuleId,
    groupNodeName: groupNodeId,
    sourceTemplateName: input.sourceTemplateName,
    entryRole: "pro",
    members: [
      { role: "pro", templateName: input.proTemplateName },
      { role: "con", templateName: input.conTemplateName },
      { role: "summary", templateName: input.summaryTemplateName },
    ],
    edges: [
      { sourceRole: "pro", targetRole: "con", trigger: DEBATE_TURN_TRIGGER, messageMode: "last", maxTriggerRounds: REQUIRED_MAX_TRIGGER_ROUNDS },
      { sourceRole: "con", targetRole: "pro", trigger: DEBATE_TURN_TRIGGER, messageMode: "last", maxTriggerRounds: REQUIRED_MAX_TRIGGER_ROUNDS },
      { sourceRole: "pro", targetRole: "summary", trigger: DEBATE_SUMMARY_TRIGGER, messageMode: "last", maxTriggerRounds: REQUIRED_MAX_TRIGGER_ROUNDS },
      { sourceRole: "con", targetRole: "summary", trigger: DEBATE_SUMMARY_TRIGGER, messageMode: "last", maxTriggerRounds: REQUIRED_MAX_TRIGGER_ROUNDS },
    ],
    report: {
      sourceRole: "summary",
      templateName: input.reportToTemplateName,
      trigger: DEFAULT_TOPOLOGY_TRIGGER,
      messageMode: "last",
      maxTriggerRounds: REQUIRED_MAX_TRIGGER_ROUNDS,
    },
  };

  const nextEdges = topology.edges.filter(
    (edge) => !(edge.source === input.sourceTemplateName && edge.target === groupNodeId),
  ).concat({
    source: input.sourceTemplateName,
    target: groupNodeId,
    trigger: DEFAULT_TOPOLOGY_TRIGGER,
    messageMode: "last" as const,
    maxTriggerRounds: REQUIRED_MAX_TRIGGER_ROUNDS,
  });

  const nextGroupRules = (topology.groupRules ?? []).filter((rule) => rule.id !== groupRuleId).concat(groupRule);

  return {
    ...topology,
    nodes: nodeIds,
    edges: nextEdges,
    nodeRecords,
    groupRules: nextGroupRules,
  };
}
