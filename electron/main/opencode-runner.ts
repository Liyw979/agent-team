import { OpenCodeClient, type OpenCodeExecutionResult, type SubmitMessagePayload } from "./opencode-client";

export interface RunAgentPayload extends SubmitMessagePayload {
  projectPath: string;
  sessionId: string;
}

export class OpenCodeRunner {
  constructor(private readonly client: OpenCodeClient) {}

  async run(payload: RunAgentPayload): Promise<OpenCodeExecutionResult> {
    const startedAt = new Date().toISOString();

    try {
      const submitted = await this.client.submitMessage(payload.projectPath, payload.sessionId, payload);
      const result = await this.client.resolveExecutionResult(payload.projectPath, payload.sessionId, submitted);
      if (result.status === "error") {
        const recovered = await this.client.recoverExecutionResultAfterTransportError(
          payload.projectPath,
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
        payload.projectPath,
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
