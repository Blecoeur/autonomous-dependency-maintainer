import type { RepairExecution, RepairRequest, RepairStatusReport } from './types.js';

/**
 * Interface between the trusted orchestrator and any repair provider.
 * The hosted provider is a Mistral-managed agent (Agents SDK, `agents
 * deploy`): the framework opens one session per repair via the Session API
 * and the agent runs in the session's MistralSandbox, never on the CI
 * runner. A deterministic mock implements the same interface for tests;
 * the framework core never depends on either directly.
 */
export interface RepairProvider {
  /** Submit a repair; replays with the same idempotency key return the same execution. */
  submit(request: RepairRequest): Promise<RepairExecution>;
  /** Poll the status of a submitted repair. */
  status(executionId: string): Promise<RepairStatusReport>;
}
