import {
  OpenCodeClient,
  type OpenCodeExecutionResult,
  type OpenCodeRuntimeTarget,
  type SubmitMessagePayload,
} from "./opencode-client";

interface RunAgentPayload extends SubmitMessagePayload {
  runtimeTarget?: OpenCodeRuntimeTarget;
  projectPath?: string;
  sessionId: string;
}

export class OpenCodeRunner {
  constructor(private readonly client: OpenCodeClient) {}

  async run(payload: RunAgentPayload): Promise<OpenCodeExecutionResult> {
    const startedAt = new Date().toISOString();
    const runtimeTarget = payload.runtimeTarget ?? payload.projectPath;
    if (!runtimeTarget) {
      throw new Error("OpenCode runner 缺少 runtimeTarget/projectPath");
    }

    try {
      const submitted = await this.client.submitMessage(runtimeTarget, payload.sessionId, payload);
      const result = await this.client.resolveExecutionResult(runtimeTarget, payload.sessionId, submitted);
      if (result.status === "error") {
        const recovered = await this.client.recoverExecutionResultAfterTransportError(
          runtimeTarget,
          payload.sessionId,
          startedAt,
          result.rawMessage.error || result.finalMessage,
        );
        if (recovered) {
          return recovered;
        }
      }
      return result;
    } catch (error) {
      const recovered = await this.client.recoverExecutionResultAfterTransportError(
        runtimeTarget,
        payload.sessionId,
        startedAt,
        error instanceof Error ? error.message : String(error),
      );
      if (recovered) {
        return recovered;
      }
      throw error;
    }
  }
}
