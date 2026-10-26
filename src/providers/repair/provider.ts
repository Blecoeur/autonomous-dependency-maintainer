import type { RepairExecution, RepairRequest, RepairStatusReport } from './types.js';

/**
 * Interface between the trusted orchestrator and any repair provider.
 * Phase 3 ships a Mistral Workflows adapter and a deterministic mock for
 * tests; the framework core never depends on either directly.
 */
export interface RepairProvider {
  /** Submit a repair; replays with the same idempotency key return the same execution. */
  submit(request: RepairRequest): Promise<RepairExecution>;
  /** Poll the status of a submitted repair. */
  status(executionId: string): Promise<RepairStatusReport>;
}
