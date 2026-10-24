import { describe, expect, it } from 'vitest';
import { assembleReleasePlan, type MergedPr, type ReleaseInputData } from '../../src/release/plan.js';
import { defaultConfig, type MaintenanceConfig } from '../../src/config/schema.js';

function makeConfig(overrides?: (c: MaintenanceConfig) => void): MaintenanceConfig {
  const c = defaultConfig('demo-repo', 'node-pnpm');
  c.release.initial_major = 3;
  c.release.versioning = 'source-aware';
  overrides?.(c);
  return c;
}

function mergedPr(overrides?: Partial<MergedPr>): MergedPr {
  return {
    number: 10,
    title: 'Bump express from 4.18.2 to 4.18.3',
    author: 'dependabot[bot]',
    authorIsBot: true,
    labels: ['dependencies'],
    files: ['package.json', 'pnpm-lock.yaml'],
    mergedAt: '2026-10-26T10:00:00Z',
    mergeSha: 'abc123',
    ...overrides,
  };
}

function data(overrides?: Partial<ReleaseInputData>): ReleaseInputData {
  return {
    last_tag: 'v3.2.1',
    source_repo: 'Blecoeur/keelflow-auto-maintained',
    framework_ref: 'v0.1.3',
    merged_prs: [],
    ...overrides,
  };
}

describe('assembleReleasePlan — versioning', () => {
  it('bumps PATCH for dependency-only merges', () => {
    const plan = assembleReleasePlan(makeConfig(), data({ merged_prs: [mergedPr()] }));
    expect(plan.should_release).toBe(true);
    expect(plan.previous_version).toBe('3.2.1');
    expect(plan.new_version).toBe('3.2.2');
    expect(plan.includes_ai_assisted).toBe(false);
  });

  it('bumps MINOR and resets PATCH when an AI-assisted fix is included', () => {
    const config = makeConfig((c) => {
      c.merge.ai_authors = ['repair-bot[bot]'];
      c.repair.enabled = true;
      c.repair.allowed_ai_paths = ['src/**'];
    });
    const plan = assembleReleasePlan(
      config,
      data({
        merged_prs: [
          mergedPr(),
          mergedPr({
            number: 11,
            author: 'repair-bot[bot]',
            title: 'Repair compatibility for express 4.19.0',
            labels: ['maintenance', 'ai-assisted'],
            files: ['package.json', 'pnpm-lock.yaml', 'src/routes.ts'],
          }),
        ],
      }),
    );
    expect(plan.new_version).toBe('3.3.0');
    expect(plan.includes_ai_assisted).toBe(true);
  });

  it('produces no release when nothing was merged since the tag (12.2 case 9)', () => {
    const plan = assembleReleasePlan(makeConfig(), data({ merged_prs: [] }));
    expect(plan.should_release).toBe(false);
  });

  it('treats direct human changes as a PATCH release (spec 8.1 table)', () => {
    const plan = assembleReleasePlan(
      makeConfig(),
      data({ merged_prs: [mergedPr({ author: 'Blecoeur', authorIsBot: false, labels: [], title: 'Manual fix', files: ['src/app.ts'] })] }),
    );
    expect(plan.should_release).toBe(true);
    expect(plan.new_version).toBe('3.2.2');
    expect(plan.classified_prs[0]?.kind).toBe('direct');
  });

  it('anchors on initial_major when no tag exists yet', () => {
    const plan = assembleReleasePlan(makeConfig(), data({ last_tag: null, merged_prs: [mergedPr()] }));
    expect(plan.previous_version).toBeNull();
    expect(plan.new_version).toBe('3.0.1');
  });

  it('never bumps MAJOR (5.4 and beyond stay on the fork generation)', () => {
    const config = makeConfig();
    config.merge.ai_authors = ['repair-bot[bot]'];
    config.repair.enabled = true;
    config.repair.allowed_ai_paths = ['src/**'];
    const plan = assembleReleasePlan(
      config,
      data({
        last_tag: 'v3.9.9',
        merged_prs: [
          mergedPr({ author: 'repair-bot[bot]', labels: ['maintenance', 'ai-assisted'], files: ['package.json', 'src/x.ts'] }),
        ],
      }),
    );
    expect(plan.new_version).toBe('3.10.0');
  });
});

describe('assembleReleasePlan — classification', () => {
  it('classifies dependabot manifest-only PRs as dependencies-only (12.2 case 10)', () => {
    const plan = assembleReleasePlan(makeConfig(), data({ merged_prs: [mergedPr()] }));
    expect(plan.classified_prs[0]?.kind).toBe('dependencies-only');
    expect(plan.classified_prs[0]?.ai_assisted).toBe(false);
    expect(plan.classified_prs[0]?.dependencies).toEqual(['express']);
  });

  it('classifies human PRs as direct even with maintenance labels', () => {
    const plan = assembleReleasePlan(
      makeConfig(),
      data({ merged_prs: [mergedPr({ author: 'someone', authorIsBot: false, labels: ['dependencies', 'maintenance'] })] }),
    );
    expect(plan.classified_prs[0]?.kind).toBe('direct');
  });

  it('classifies a merged security patch as dependencies-only', () => {
    const plan = assembleReleasePlan(
      makeConfig(),
      data({ merged_prs: [mergedPr({ labels: ['security'], title: 'Bump lodash from 4.17.20 to 4.17.21' })] }),
    );
    expect(plan.classified_prs[0]?.kind).toBe('dependencies-only');
  });
});

describe('assembleReleasePlan — provenance and notes', () => {
  it('emits the provenance document per the schema', () => {
    const plan = assembleReleasePlan(
      makeConfig(),
      data({ merged_prs: [mergedPr({ number: 120 }), mergedPr({ number: 121, title: 'Bump zod from 3.22.0 to 3.23.0' })] }),
    );
    expect(plan.provenance.schema_version).toBe('1');
    expect(plan.provenance.distribution_version).toBe('3.2.2');
    expect(plan.provenance.source_repo).toBe('Blecoeur/keelflow-auto-maintained');
    expect(plan.provenance.framework_ref).toBe('v0.1.3');
    expect(plan.provenance.maintenance_mode).toBe('automated-with-ai'); // repair.enabled defaults to true
    expect(plan.provenance.human_review).toBe(false);
    expect(plan.provenance.merged_prs).toHaveLength(2);
    expect(plan.provenance.merged_prs[0]?.mergeSha).toBe('abc123');
  });

  it('marks maintenance_mode automated when repair is disabled', () => {
    const config = makeConfig((c) => { c.repair.enabled = false; });
    const plan = assembleReleasePlan(config, data({ merged_prs: [mergedPr()] }));
    expect(plan.provenance.maintenance_mode).toBe('automated');
  });

  it('groups PRs by kind in the release notes with links', () => {
    const plan = assembleReleasePlan(
      makeConfig(),
      data({ merged_prs: [mergedPr({ number: 120 }), mergedPr({ number: 5, author: 'Blecoeur', authorIsBot: false, labels: [], files: ['README.md'] })] }),
    );
    expect(plan.release_notes_markdown).toContain('### Dependency updates (no AI)');
    expect(plan.release_notes_markdown).toContain('### Direct changes');
    expect(plan.release_notes_markdown).toContain('https://github.com/Blecoeur/keelflow-auto-maintained/pull/120');
    expect(plan.release_notes_markdown).toContain('PATCH bump');
  });

  it('includes the experimental-distribution warning in the notes', () => {
    const plan = assembleReleasePlan(makeConfig(), data({ merged_prs: [mergedPr()] }));
    expect(plan.release_notes_markdown).toContain('Experimental, automatically maintained distribution');
  });
});

describe('assembleReleasePlan — determinism and idempotence', () => {
  it('produces the same plan for the same input (12.2 case 8)', () => {
    const config = makeConfig();
    const input = data({ merged_prs: [mergedPr()] });
    expect(assembleReleasePlan(config, input)).toEqual(assembleReleasePlan(config, input));
  });

  it('rejects a non source-aware versioning mode explicitly', () => {
    const config = makeConfig((c) => { c.release.versioning = 'semver'; });
    expect(() => assembleReleasePlan(config, data())).toThrow(/not implemented/);
  });

  it('rejects an invalid last_tag', () => {
    expect(() => assembleReleasePlan(makeConfig(), data({ last_tag: 'vbanane' }))).toThrow(/valid vX.Y.Z/);
  });
});
