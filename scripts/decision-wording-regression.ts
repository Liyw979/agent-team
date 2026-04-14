import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Orchestrator } from "../electron/main/orchestrator";
import type { AgentFileRecord } from "../shared/types";

function createAgent(name: string, role: AgentFileRecord["role"]): AgentFileRecord {
  return {
    id: `test:${name}`,
    projectId: "project-1",
    name,
    relativePath: `${name}.md`,
    absolutePath: path.join("/tmp", `${name}.md`),
    mode: "primary",
    role,
    tools: [],
    prompt: "",
    content: "",
  };
}

async function main() {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-decision-wording-"));
  const orchestrator = new Orchestrator({ userDataPath, enableEventStream: false });

  try {
    const buildAgent = createAgent("Build", "implementation");
    const unitTestAgent = createAgent("UnitTest", "unit_test");

    const buildPrompt = (orchestrator as any).createSystemPrompt(buildAgent) as string;
    const unitTestPrompt = (orchestrator as any).createSystemPrompt(unitTestAgent) as string;

    assert.match(buildPrompt, /【DECISION】已完成/u, "Build 应使用“已完成”决策文案");
    assert.doesNotMatch(buildPrompt, /【DECISION】检查通过/u, "Build 不应使用“检查通过”决策文案");
    assert.match(unitTestPrompt, /【DECISION】检查通过/u, "审查类 Agent 应继续使用“检查通过”");

    const buildParsed = (orchestrator as any).parseReview("实现已整理完毕。\n\n【DECISION】已完成") as {
      decision: string;
    };
    const reviewParsed = (orchestrator as any).parseReview("测试结论已确认。\n\n【DECISION】检查通过") as {
      decision: string;
    };

    assert.equal(buildParsed.decision, "pass", "“已完成” 应被解析为通过状态");
    assert.equal(reviewParsed.decision, "pass", "“检查通过” 应继续被解析为通过状态");

    const buildDisplay = (orchestrator as any).createDisplayContent(buildAgent, {
      cleanContent: "",
      decision: "pass",
      feedback: null,
      rawDecisionBlock: "【DECISION】已完成",
    }) as string;
    const reviewDisplay = (orchestrator as any).createDisplayContent(unitTestAgent, {
      cleanContent: "",
      decision: "pass",
      feedback: null,
      rawDecisionBlock: "【DECISION】检查通过",
    }) as string;

    assert.equal(buildDisplay, "（该 Agent 已完成本轮工作，未额外返回高层说明。）");
    assert.equal(reviewDisplay, "（该 Agent 已完成本轮审查并给出通过结论，未额外返回高层说明。）");

    console.log(
      JSON.stringify(
        {
          buildPrompt,
          unitTestPrompt,
          buildDisplay,
          reviewDisplay,
        },
        null,
        2,
      ),
    );
  } finally {
    await orchestrator.dispose().catch(() => undefined);
    fs.rmSync(userDataPath, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
