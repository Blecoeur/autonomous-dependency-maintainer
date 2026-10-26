import type { MaintenanceConfig } from '../config/schema.js';
import { evaluatePr } from './eligibility.js';
import type { PrInput } from './pr.js';
import { idempotencyKey, type RepairRequest } from '../providers/repair/types.js';

/** Facts about the CI run that failed, collected from the GitHub API. */
export interface CiRunFacts {
  run_id: number;
  /** Name of the workflow that ran, e.g. "CI". */
  workflow_name: string;
  /** Conclusion: failure, cancelled, timed_out, startup_failure... */
  conclusion: string;
  /** Head SHA the run executed on. */
  head_sha: string;
  /** Whether this is the latest run for that SHA (guards stale events). */
  is_latest_run: boolean;
}

/** Repair state, derived from GitHub (open/closed replacement PRs). */
export interface RepairStateFacts {
  /** A repair execution is already in progress for this PR+SHA. */
  repair_in_progress: boolean;
  /** Number of repair attempts already spent on this original PR. */
  attempts_used: number;
}

export interface RepairEligibilityInput {
  pr: PrInput;
  repository: string;
  ci: CiRunFacts;
  state: RepairStateFacts;
  /** The CI workflow name this repository expects, from .maintenance.yml wiring. */
  expected_workflow_name: string;
}

export type RepairEligibilityReason =
  | 'eligible'
  | 'repair-disabled'
  | 'not-a-dependency-pr'
  | 'wrong-workflow'
  | 'transient-ci-conclusion'
  | 'wrong-head-sha'
  | 'stale-run'
  | 'repair-already-in-progress'
  | 'budget-exceeded'
  | 'major-requires-policy-authorization';

export interface RepairEligibilityDecision {
  eligible: boolean;
  reason: RepairEligibilityReason;
  details: string;
  request: RepairRequest | null;
  idempotency_key: string;
}

/**
 * Deterministic guards deciding whether a CI-red dependency PR may be sent
 * to the AI repair provider (spec 7.1). Every guard refuses explicitly; the
 * agent is the LAST resort, never the default.
 */
export function evaluateRepairEligibility(
  config: MaintenanceConfig,
  input: RepairEligibilityInput,
): RepairEligibilityDecision {
  const key = idempotencyKey(input.repository, input.pr.number, input.pr.headSha);
  const refuse = (
    reason: RepairEligibilityReason,
    details: string,
  ): RepairEligibilityDecision => ({ eligible: false, reason, details, request: null, idempotency_key: key });

  if (!config.repair.enabled) {
    return refuse('repair-disabled', 'The AI repair circuit is disabled in this repository policy.');
  }

  // The PR must be a clean eligible dependencies-only PR; majors and anything
  // policy-uncertain never reach an agent.
  const decision = evaluatePr(config, input.pr);
  if (decision.classification !== 'dependencies-only' || decision.decision !== 'eligible') {
    return refuse(
      'not-a-dependency-pr',
      `The PR is not an eligible dependencies-only update (decision: ${decision.decision}). ` +
        'Majors and uncertain updates are never sent to AI repair.',
    );
  }
  if (decision.dependencyUpdates.some((u) => u.updateType === 'major')) {
    return refuse('major-requires-policy-authorization', 'Major updates need prior policy authorization.');
  }

  // The failure must belong to the expected CI workflow...
  if (input.ci.workflow_name !== input.expected_workflow_name) {
    return refuse(
      'wrong-workflow',
      `Failure came from '${input.ci.workflow_name}', not the expected CI workflow '${input.expected_workflow_name}'.`,
    );
  }
  // ...be a real failure (not infra noise / cancellation / timeout)...
  if (input.ci.conclusion !== 'failure') {
    return refuse(
      'transient-ci-conclusion',
      `CI conclusion is '${input.ci.conclusion}'; only reproducible 'failure' conclusions trigger a repair.`,
    );
  }
  // ...on the PR's exact head SHA...
  if (input.ci.head_sha !== input.pr.headSha) {
    return refuse(
      'wrong-head-sha',
      `CI ran on ${input.ci.head_sha.slice(0, 8)}, not the current head ${input.pr.headSha.slice(0, 8)}; the PR moved.`,
    );
  }
  // ...and be the latest run for that SHA (duplicated events are ignored).
  if (!input.ci.is_latest_run) {
    return refuse('stale-run', 'A newer run exists for this SHA; this event is stale.');
  }

  // One repair at a time per PR, within the attempt budget.
  if (input.state.repair_in_progress) {
    return refuse('repair-already-in-progress', 'A repair is already in progress for this PR and SHA.');
  }
  if (input.state.attempts_used >= config.repair.max_attempts) {
    return refuse(
      'budget-exceeded',
      `Repair budget exhausted: ${input.state.attempts_used}/${config.repair.max_attempts} attempts used.`,
    );
  }

  const testOracle = config.validation.test ?? config.validation.smoke;
  if (!testOracle) {
    return refuse(
      'not-a-dependency-pr',
      'No test or smoke command configured; a repair without a verification oracle is never accepted.',
    );
  }

  const request: RepairRequest = {
    schema_version: '1',
    idempotency_key: key,
    repository: input.repository,
    base_branch: config.project.base_branch,
    original_pr_number: input.pr.number,
    original_head_sha: input.pr.headSha,
    dependency_updates: decision.dependencyUpdates.map((u) => ({
      name: u.name,
      from_version: u.fromVersion,
      to_version: u.toVersion,
      update_type: u.updateType,
    })),
    commands: {
      install: config.validation.install,
      build: config.validation.build,
      test: testOracle,
    },
    ci: {
      run_id: input.ci.run_id,
      workflow_name: input.ci.workflow_name,
      conclusion: 'failure',
    },
    policy: {
      max_attempts: config.repair.max_attempts,
      allow_test_changes: false,
      allow_ci_changes: false,
      preserve_public_api: config.repair.preserve_public_api,
      max_changed_application_files: config.repair.max_changed_application_files,
    },
  };

  return {
    eligible: true,
    reason: 'eligible',
    details: 'All guards passed; the repair request is ready for the provider.',
    request,
    idempotency_key: key,
  };
}
