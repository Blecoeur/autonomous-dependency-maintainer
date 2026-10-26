import type { RepairExecution, RepairRequest, RepairStatusReport } from '../types.js';

/**
 * Deterministic in-memory provider for tests and local dry runs.
 * Replays of the same idempotency key return the same execution.
 */
export class MockRepairProvider {
  private readonly executions = new Map<string, RepairExecution>();
  private readonly reports = new Map<string, RepairStatusReport>();
  private sequence: RepairStatusReport['status'] = 'in_progress';

  constructor(
    private readonly options: {
      apiBaseUrl?: string;
      apiKey?: string;
      workflowName?: string;
    } = {},
  ) {}

  /** Sets the status the next `status()` call reports. */
  setStatus(status: RepairStatusReport['status']): void {
    this.sequence = status;
  }

  async submit(request: RepairRequest): Promise<RepairExecution> {
    const existing = this.executions.get(request.idempotency_key);
    if (existing) {
      return existing; // idempotent replay
    }
    const execution: RepairExecution = {
      provider: 'mock',
      execution_id: `mock-${request.idempotency_key}-${this.executions.size + 1}`,
      idempotency_key: request.idempotency_key,
    };
    this.executions.set(request.idempotency_key, execution);
    return execution;
  }

  async status(executionId: string): Promise<RepairStatusReport> {
    const report = this.reports.get(executionId);
    if (report) {
      return report;
    }
    return { status: this.sequence, attempt_count: 0 };
  }
}
