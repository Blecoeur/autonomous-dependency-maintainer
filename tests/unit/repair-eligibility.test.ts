import { describe, expect, it } from 'vitest';
import { evaluateRepairEligibility, type RepairEligibilityInput } from '../../src/policy/repair-eligibility.js';
import { defaultConfig, type MaintenanceConfig } from '../../src/config/schema.js';
import type { PrInput } from '../../src/policy/pr.js';

function makeConfig(overrides?: (c: MaintenanceConfig) => void): MaintenanceConfig {
  const c = defaultConfig('demo-repo', 'node-pnpm');
  c.repair.enabled = true;
  overrides?.(c);
  return c;
}

function makePr(overrides?: Partial<PrInput>): PrInput {
  return {
    number: 10,
    title: 'Bump multer from 2.4.0 to 2.5.0',
    author: 'app/dependabot',
    authorIsBot: true,
    baseRef: 'main',
    headSha: 'abcdef123',
    labels: ['dependencies'],
    files: ['package.json', 'pnpm-lock.yaml'],
    securityUpdate: false,
    ...overrides,
  };
}

function makeInput(overrides?: Partial<RepairEligibilityInput>): RepairEligibilityInput {
  return {
    pr: makePr(),
    repository: 'Blecoeur/keelflow-auto-maintained',
    ci: {
      run_id: 456,
      workflow_name: 'CI',
      conclusion: 'failure',
      head_sha: 'abcdef123',
      is_latest_run: true,
    },
    state: { repair_in_progress: false, attempts_used: 0 },
    expected_workflow_name: 'CI',
    ...overrides,
  };
}

describe('evaluateRepairEligibility', () => {
  it('builds a repair request for a reproducible CI failure on an eligible PR (12.2 case 3)', () => {
    const decision = evaluateRepairEligibility(makeConfig(), makeInput());
    expect(decision.eligible).toBe(true);
    expect(decision.request).not.toBeNull();
    expect(decision.request?.idempotency_key).toBe(
      'Blecoeur/keelflow-auto-maintained#10@abcdef123:repair-v1',
    );
    expect(decision.request?.dependency_updates[0]?.to_version).toBe('2.5.0');
    expect(decision.request?.policy.allow_test_changes).toBe(false);
    expect(decision.request?.commands.test).toBe('pnpm test');
    expect(decision.request?.commands.build).toBe('pnpm build');
  });

  it('refuses repairs when no verification oracle is configured', () => {
    const decision = evaluateRepairEligibility(
      makeConfig((c) => {
        c.validation.test = null;
        c.validation.smoke = null;
      }),
      makeInput(),
    );
    expect(decision.reason).toBe('not-a-dependency-pr');
    expect(decision.details).toContain('verification oracle');
  });

  it('refuses when the repair circuit is disabled', () => {
    const decision = evaluateRepairEligibility(
      makeConfig((c) => { c.repair.enabled = false; }),
      makeInput(),
    );
    expect(decision.reason).toBe('repair-disabled');
    expect(decision.request).toBeNull();
  });

  it('refuses PRs that are not eligible dependency updates (human PRs, majors)', () => {
    const human = evaluateRepairEligibility(makeConfig(), makeInput({ pr: makePr({ author: 'Blecoeur', authorIsBot: false }) }));
    expect(human.reason).toBe('not-a-dependency-pr');

    const major = evaluateRepairEligibility(
      makeConfig(),
      makeInput({ pr: makePr({ title: 'Bump eslint from 8.57.0 to 9.0.0' }) }),
    );
    expect(major.reason).toBe('not-a-dependency-pr');
  });

  it('refuses failures from an unexpected workflow (12.2 pwn-request guard)', () => {
    const decision = evaluateRepairEligibility(
      makeConfig(),
      makeInput({
        ci: { run_id: 456, workflow_name: 'attacker-workflow', conclusion: 'failure', head_sha: 'abcdef123', is_latest_run: true },
        expected_workflow_name: 'CI',
      }),
    );
    expect(decision.reason).toBe('wrong-workflow');
  });

  it('refuses cancelled/timed-out runs as transient (12.1 flakiness case)', () => {
    for (const conclusion of ['cancelled', 'timed_out', 'startup_failure']) {
      const decision = evaluateRepairEligibility(
        makeConfig(),
        makeInput({ ci: { run_id: 456, workflow_name: 'CI', conclusion, head_sha: 'abcdef123', is_latest_run: true } }),
      );
      expect(decision.reason).toBe('transient-ci-conclusion');
    }
  });

  it('refuses CI from another commit (12.1 case: CI du mauvais commit)', () => {
    const decision = evaluateRepairEligibility(
      makeConfig(),
      makeInput({ ci: { run_id: 456, workflow_name: 'CI', conclusion: 'failure', head_sha: 'different999', is_latest_run: true } }),
    );
    expect(decision.reason).toBe('wrong-head-sha');
  });

  it('refuses stale runs: duplicate events create no second repair (12.2 case 7)', () => {
    const decision = evaluateRepairEligibility(
      makeConfig(),
      makeInput({ ci: { run_id: 456, workflow_name: 'CI', conclusion: 'failure', head_sha: 'abcdef123', is_latest_run: false } }),
    );
    expect(decision.reason).toBe('stale-run');
  });

  it('refuses when a repair is already in progress (no concurrent repairs)', () => {
    const decision = evaluateRepairEligibility(
      makeConfig(),
      makeInput({ state: { repair_in_progress: true, attempts_used: 0 } }),
    );
    expect(decision.reason).toBe('repair-already-in-progress');
  });

  it('refuses when the attempt budget is exhausted', () => {
    const decision = evaluateRepairEligibility(
      makeConfig(),
      makeInput({ state: { repair_in_progress: false, attempts_used: 3 } }),
    );
    expect(decision.reason).toBe('budget-exceeded');
  });

  it('is deterministic: identical input yields an identical decision (idempotence)', () => {
    const config = makeConfig();
    const input = makeInput();
    expect(evaluateRepairEligibility(config, input)).toEqual(evaluateRepairEligibility(config, input));
  });
});
