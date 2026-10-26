import type { RepairExecution, RepairRequest, RepairStatusReport } from '../types.js';

export interface MistralRepairAdapterOptions {
  /** Mistral API key. In CI this comes from a secret, never from PR content. */
  apiKey: string;
  /** API base; defaults to the public Mistral API. */
  baseUrl?: string;
  /** Name of the deployed repair workflow, e.g. 'repair_dependency_update'. */
  workflowName: string;
  /**
   * Optional header set by the platform (some Mistral deployments require it
   * for managed workflow executions). No-op when absent.
   */
  extraHeaders?: Record<string, string>;
}

interface MistralExecutionResponse {
  id?: string;
  status?: string;
  inputs?: unknown;
  output?: unknown;
  error?: unknown;
}

/**
 * Adapter for Mistral Workflows (spec 7.2-7.3).
 *
 * The API shape below follows the Mistral Workflows documentation as of
 * October 2026 (POST /v1/workflows/{name}/execute, execution polling).
 * It MUST be re-verified against the live API before production use —
 * the framework treats the JSON request/response contracts as its own and
 * this adapter as the single translation point.
 */
export class MistralWorkflowsRepairProvider {
  constructor(private readonly options: MistralRepairAdapterOptions) {}

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.options.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(this.options.extraHeaders ?? {}),
    };
  }

  private url(path: string): string {
    const base = (this.options.baseUrl ?? 'https://api.mistral.ai').replace(/\/$/, '');
    return `${base}${path}`;
  }

  async submit(request: RepairRequest): Promise<RepairExecution> {
    const response = await fetch(this.url(`/v1/workflows/${this.options.workflowName}/execute`), {
      method: 'POST',
      headers: this.headers(),
      // Idempotency: Mistral Workflows accept an idempotency key on execute;
      // replays with the same key must return the same execution.
      body: JSON.stringify({
        inputs: request,
        metadata: { idempotency_key: request.idempotency_key },
      }),
    });
    if (!response.ok) {
      throw new Error(`Mistral execute failed: HTTP ${response.status} ${await safeText(response)}`);
    }
    const data = (await response.json()) as MistralExecutionResponse;
    const executionId = data.id;
    if (!executionId) {
      throw new Error('Mistral execute response did not contain an execution id');
    }
    return {
      provider: 'mistral-workflows',
      execution_id: executionId,
      idempotency_key: request.idempotency_key,
    };
  }

  async status(executionId: string): Promise<RepairStatusReport> {
    const response = await fetch(this.url(`/v1/workflows/${this.options.workflowName}/executions/${executionId}`), {
      headers: this.headers(),
    });
    if (!response.ok) {
      throw new Error(`Mistral status failed: HTTP ${response.status} ${await safeText(response)}`);
    }
    const data = (await response.json()) as MistralExecutionResponse;
    return mapExecutionToReport(data);
  }
}

/** Maps provider states onto the framework's repair status vocabulary. */
export function mapExecutionToReport(data: MistralExecutionResponse): RepairStatusReport {
  const raw = (data.status ?? '').toLowerCase();
  if (raw === 'succeeded' || raw === 'success') {
    const output = data.output as Record<string, unknown> | undefined;
    const status = (output?.['status'] as string) ?? 'pr_created';
    return {
      status: normalizeOutcome(status),
      replacement_pr_number: output?.['replacement_pr_number'] as number | undefined,
      attempt_count: output?.['attempt_count'] as number | undefined,
      reason: output?.['reason'] as string | undefined,
      changed_application_files: output?.['changed_application_files'] as string[] | undefined,
    };
  }
  if (raw === 'running' || raw === 'queued' || raw === 'pending') {
    return { status: 'in_progress' };
  }
  if (raw === 'failed' || raw === 'error') {
    return { status: 'internal_error', reason: JSON.stringify(data.error ?? 'unknown') };
  }
  return { status: 'in_progress' };
}

function normalizeOutcome(status: string): RepairStatusReport['status'] {
  const allowed: RepairStatusReport['status'][] = [
    'pr_created',
    'blocked',
    'not_reproducible',
    'transient_failure',
    'budget_exceeded',
    'stale_original_pr',
    'internal_error',
  ];
  return allowed.includes(status as RepairStatusReport['status'])
    ? (status as RepairStatusReport['status'])
    : 'internal_error';
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return '';
  }
}
