import type { RepairRequest, RepairStatusReport } from '../types.js';

/**
 * Deterministic in-memory provider for tests and local dry runs.
 * Replays of the same idempotency key return the same report.
 */
export class MockRepairProvider {
  private readonly reports = new Map<string, RepairStatusReport>();
  private sequence: RepairStatusReport['status'] = 'blocked';

  /** Sets the status the next `run()` call reports. */
  setStatus(status: RepairStatusReport['status']): void {
    this.sequence = status;
  }

  async run(request: RepairRequest): Promise<RepairStatusReport> {
    const existing = this.reports.get(request.idempotency_key);
    if (existing) {
      return existing; // idempotent replay
    }
    const report: RepairStatusReport = {
      status: this.sequence,
      attempt_count: 0,
      idempotency_key: request.idempotency_key,
    };
    this.reports.set(request.idempotency_key, report);
    return report;
  }
}
