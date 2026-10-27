/**
 * Contracts of the AI repair circuit (spec section 7, docs/vibe-repair-provider.md).
 *
 * The framework owns these schemas; adapters translate them to their
 * provider's API. Nothing here is a validated third-party API.
 */

export const REPAIR_STRATEGY_VERSION = 'repair-v1' as const;

/** Machine + policy context of a repair request (input contract). */
export interface RepairRequest {
  schema_version: '1';
  /** repo#pr@sha:repair-v1 — replays of the same failure map to one repair. */
  idempotency_key: string;
  repository: string;
  base_branch: string;
  original_pr_number: number;
  original_head_sha: string;
  dependency_updates: Array<{
    name: string;
    from_version: string;
    to_version: string;
    update_type: 'major' | 'minor' | 'patch';
  }>;
  /** Verification commands from the consumer's .maintenance.yml (validation section). */
  commands: {
    install: string | null;
    build: string | null;
    /** The test oracle; required — a repair without verification is never accepted. */
    test: string;
  };
  ci: {
    run_id: number;
    workflow_name: string;
    conclusion: 'failure';
  };
  policy: {
    max_attempts: number;
    allow_test_changes: false;
    allow_ci_changes: false;
    preserve_public_api: boolean;
    max_changed_application_files: number;
  };
}

export type RepairStatus =
  | 'pr_created'
  | 'blocked'
  | 'not_reproducible'
  | 'transient_failure'
  | 'budget_exceeded'
  | 'stale_original_pr'
  | 'internal_error';

export interface RepairStatusReport {
  status: RepairStatus;
  /** Replacement PR number when status is pr_created. */
  replacement_pr_number?: number;
  attempt_count?: number;
  reason?: string;
  changed_application_files?: string[];
  /**
   * Unified diff of the validated repair, produced by the vibe provider.
   * The privileged gateway applies it; the agent never pushes.
   */
  patch?: string;
  /** Framework-side bookkeeping, filled by the provider. */
  idempotency_key?: string;
}

export function idempotencyKey(
  repository: string,
  prNumber: number,
  headSha: string,
): string {
  return `${repository}#${prNumber}@${headSha}:${REPAIR_STRATEGY_VERSION}`;
}
