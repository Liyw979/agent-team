import {
  OpenCodeClient,
  type OpenCodeExecutionResult,
  type SubmitMessagePayload,
} from "./opencode-client";

interface RunAgentPayload extends SubmitMessagePayload {
  sessionId: string;
  allowedDecisionTriggers: string[];
}

const RETRYABLE_EXECUTION_INTERVAL_MS = 60_000;

interface RunnerClock {
  sleep(ms: number): Promise<void>;
}

const defaultRunnerClock: RunnerClock = {
  sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },
};

export class OpenCodeRunner {
  constructor(
    private readonly client: OpenCodeClient,
    private readonly clock: RunnerClock = defaultRunnerClock,
  ) {}

  async run(payload: RunAgentPayload): Promise<OpenCodeExecutionResult> {
    while (true) {
      const startedAt = new Date().toISOString();
      try {
        return await this.executeAttempt(payload);
      } catch (error) {
        try {
          const recovered = await this.client.recoverExecutionResultAfterTransportError(
            payload.sessionId,
            startedAt,
            error instanceof Error ? error.message : String(error),
          );
          if (recovered.kind === "recovered" && recovered.result.status === "completed") {
            return recovered.result;
          }
        } catch {
          // recovery failures stay in the same retry loop
        }
      }
      await this.clock.sleep(RETRYABLE_EXECUTION_INTERVAL_MS);
    }
  }

  private async executeAttempt(
    payload: RunAgentPayload,
  ): Promise<OpenCodeExecutionResult> {
    const submitted = await this.client.submitMessage(payload.sessionId, payload);
    const result = await this.client.resolveExecutionResult(
      payload.sessionId,
      submitted,
      payload.agent,
      payload.allowedDecisionTriggers,
    );
    if (result.status === "completed") {
      return result;
    }
    throw new Error(result.finalMessage);
  }
}
