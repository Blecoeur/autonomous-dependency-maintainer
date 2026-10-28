import type { RepairRequest, RepairStatusReport } from './types.js';

/**
 * Interface between the trusted orchestrator and any repair provider.
 * Phase 3 ships the vibe CLI provider (agent runs on the CI runner) and a
 * deterministic mock for tests; the framework core never depends on either
 * directly.
 */
export interface RepairProvider {
  /** Run one repair attempt to completion and return its report. */
  run(request: RepairRequest): Promise<RepairStatusReport>;
}
