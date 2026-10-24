import { describe, expect, it } from 'vitest';
import { evaluatePr } from '../../src/policy/eligibility.js';
import { defaultConfig, type MaintenanceConfig } from '../../src/config/schema.js';
import type { PrInput } from '../../src/policy/pr.js';

function makeConfig(overrides?: (config: MaintenanceConfig) => void): MaintenanceConfig {
  const config = defaultConfig('demo-repo', 'node-pnpm');
  overrides?.(config);
  return config;
}

function makePr(overrides?: Partial<PrInput>): PrInput {
  return {
    number: 42,
    title: 'Bump express from 4.18.2 to 4.18.3 in /packages/server',
    author: 'dependabot[bot]',
    authorIsBot: true,
    baseRef: 'main',
    headSha: 'abc123',
    labels: ['dependencies'],
    files: ['packages/server/package.json', 'pnpm-lock.yaml'],
    securityUpdate: false,
    ...overrides,
  };
}

describe('evaluatePr — dependencies-only circuit', () => {
  it('approves a compatible patch update from an authorized bot (12.1 case 1)', () => {
    const decision = evaluatePr(makeConfig(), makePr());
    expect(decision.decision).toBe('eligible');
    expect(decision.classification).toBe('dependencies-only');
    expect(decision.automerge).toBe(true);
    expect(decision.reasons).toEqual([]);
  });

  it('approves a compatible minor update', () => {
    const decision = evaluatePr(makeConfig(), makePr({ title: 'Bump express from 4.18.2 to 4.19.0' }));
    expect(decision.decision).toBe('eligible');
  });

  it('rejects an unknown author even with identical labels and diff (12.1 case 2)', () => {
    const decision = evaluatePr(makeConfig(), makePr({ author: 'someone-else', authorIsBot: false }));
    expect(decision.decision).toBe('not-maintenance');
    expect(decision.reasons).toContain('author-not-authorized');
    expect(decision.automerge).toBe(false);
  });

  it('ignores a human PR pretending to be the bot via labels', () => {
    const decision = evaluatePr(
      makeConfig(),
      makePr({ author: 'attacker', authorIsBot: false, labels: ['dependencies', 'maintenance'] }),
    );
    expect(decision.decision).toBe('not-maintenance');
  });

  it('rejects a PR that touches .github/workflows (12.1 case 3)', () => {
    const decision = evaluatePr(makeConfig(), makePr({ files: ['package.json', '.github/workflows/ci.yml'] }));
    expect(decision.decision).toBe('rejected');
    expect(decision.reasons).toContain('forbidden-path-changed');
  });

  it('rejects a PR that touches .maintenance.yml or CODEOWNERS', () => {
    expect(evaluatePr(makeConfig(), makePr({ files: ['package.json', '.maintenance.yml'] })).reasons).toContain('forbidden-path-changed');
    expect(evaluatePr(makeConfig(), makePr({ files: ['package.json', 'CODEOWNERS'] })).reasons).toContain('forbidden-path-changed');
  });

  it('rejects a PR that removes the test script from package.json (12.1 case 5)', () => {
    const before = JSON.stringify({ name: 'x', scripts: { test: 'vitest run' }, dependencies: { express: '4.18.2' } });
    const after = JSON.stringify({ name: 'x', dependencies: { express: '4.18.3' } });
    const decision = evaluatePr(makeConfig(), makePr({ manifests: [{ path: 'package.json', before, after }] }));
    expect(decision.decision).toBe('rejected');
    expect(decision.reasons).toContain('protected-manifest-section-changed');
  });

  it('classifies a manifest/lockfile-only change as dependencies-only (12.1 case 6)', () => {
    const decision = evaluatePr(makeConfig(), makePr());
    expect(decision.classification).toBe('dependencies-only');
  });

  it('rejects a dependency PR that also modifies application code', () => {
    const decision = evaluatePr(makeConfig(), makePr({ files: ['package.json', 'pnpm-lock.yaml', 'src/app.ts'] }));
    expect(decision.decision).toBe('rejected');
    expect(decision.reasons).toContain('unexpected-file-changes');
  });

  it('defers an ordinary major update (12.1 case 8)', () => {
    const decision = evaluatePr(makeConfig(), makePr({ title: 'Bump eslint from 8.57.0 to 9.0.0' }));
    expect(decision.decision).toBe('needs-human');
    expect(decision.reasons).toContain('major-deferred');
    expect(decision.automerge).toBe(false);
  });

  it('keeps a security major update visible but unmerged, for humans (12.1 cases 11/12)', () => {
    const decision = evaluatePr(
      makeConfig(),
      makePr({ title: 'Bump openssl-wrapper from 2.1.0 to 3.0.0', securityUpdate: true, labels: ['security'] }),
    );
    expect(decision.decision).toBe('needs-human');
    expect(decision.reasons).toContain('major-requires-policy-authorization');
  });

  it('approves a security patch update like any other patch', () => {
    const decision = evaluatePr(makeConfig(), makePr({ securityUpdate: true, labels: ['security'] }));
    expect(decision.decision).toBe('eligible');
  });

  it('blocks minors when allow_minor is false', () => {
    const config = makeConfig((c) => { c.updates.allow_minor = false; });
    const decision = evaluatePr(config, makePr({ title: 'Bump express from 4.18.2 to 4.19.0' }));
    expect(decision.decision).toBe('needs-human');
    expect(decision.reasons).toContain('update-type-not-allowed');
  });

  it('blocks a PR whose update type cannot be verified (grouped title)', () => {
    const decision = evaluatePr(makeConfig(), makePr({ title: 'Bump the npm_and_yarn group with 4 updates' }));
    expect(decision.decision).toBe('needs-human');
    expect(decision.reasons).toContain('update-type-unverified');
  });

  it('ignores a PR targeting another base branch', () => {
    const decision = evaluatePr(makeConfig(), makePr({ baseRef: 'develop' }));
    expect(decision.decision).toBe('not-maintenance');
    expect(decision.reasons).toContain('wrong-base-branch');
  });

  it('surfaces a dependabot actions-update PR as needs-human, not rejected', () => {
    const decision = evaluatePr(
      makeConfig(),
      makePr({
        title: 'Bump actions/checkout from 4 to 5',
        files: ['.github/workflows/maintenance-ci.yml'],
        labels: ['dependencies', 'infrastructure'],
      }),
    );
    expect(decision.decision).toBe('needs-human');
    expect(decision.reasons).toContain('infrastructure-update-needs-human');
    expect(decision.automerge).toBe(false);
    expect(decision.classification).toBe('none');
  });

  it('treats a multi-file actions update as needs-human', () => {
    const decision = evaluatePr(
      makeConfig(),
      makePr({
        title: 'Bump the github-actions group with 2 updates',
        files: ['.github/workflows/ci.yml', '.github/workflows/maintenance-release.yml'],
      }),
    );
    expect(decision.decision).toBe('needs-human');
  });

  it('still rejects a PR mixing infrastructure with application files', () => {
    const decision = evaluatePr(
      makeConfig(),
      makePr({ files: ['.github/workflows/ci.yml', 'package.json'] }),
    );
    expect(decision.decision).toBe('rejected');
    expect(decision.reasons).toContain('forbidden-path-changed');
    expect(decision.reasons).not.toContain('infrastructure-update-needs-human');
  });

  it('still rejects a dependabot PR touching CODEOWNERS (not workflows-only)', () => {
    const decision = evaluatePr(makeConfig(), makePr({ files: ['CODEOWNERS'] }));
    expect(decision.decision).toBe('rejected');
    expect(decision.reasons).toContain('forbidden-path-changed');
  });
});

describe('evaluatePr — ai-assisted circuit', () => {
  const aiPr = (overrides?: Partial<PrInput>): PrInput =>
    makePr({
      author: 'maintenance-repairer[bot]',
      title: 'Repair compatibility for express 4.19.0',
      labels: ['maintenance', 'ai-assisted'],
      files: ['package.json', 'pnpm-lock.yaml', 'packages/server/src/routes.ts'],
      ...overrides,
    });

  const aiConfig = (overrides?: (config: MaintenanceConfig) => void): MaintenanceConfig =>
    makeConfig((config) => {
      config.merge.ai_authors = ['maintenance-repairer[bot]'];
      config.repair.allowed_ai_paths = ['packages/server/src/**', 'packages/ui/src/**'];
      overrides?.(config);
    });

  it('approves an AI repair within the allowed application surface (12.1 case 7)', () => {
    const decision = evaluatePr(aiConfig(), aiPr());
    expect(decision.decision).toBe('eligible');
    expect(decision.classification).toBe('ai-assisted');
    expect(decision.automerge).toBe(true);
  });

  it('rejects an AI PR that modifies a test file (12.1 case 4)', () => {
    const decision = evaluatePr(
      aiConfig(),
      aiPr({ files: ['package.json', 'pnpm-lock.yaml', 'packages/server/src/app.test.ts'] }),
    );
    expect(decision.decision).toBe('rejected');
    expect(decision.reasons).toContain('forbidden-path-changed');
  });

  it('rejects an AI PR that modifies a CI workflow', () => {
    const decision = evaluatePr(
      aiConfig(),
      aiPr({ files: ['.github/workflows/maintenance-ci.yml', 'package.json'] }),
    );
    expect(decision.decision).toBe('rejected');
    expect(decision.reasons).toContain('forbidden-path-changed');
  });

  it('rejects an AI PR touching only workflows (no infrastructure exemption for AI)', () => {
    const decision = evaluatePr(
      aiConfig(),
      aiPr({ files: ['.github/workflows/maintenance-ci.yml'] }),
    );
    expect(decision.decision).toBe('rejected');
    expect(decision.reasons).toContain('forbidden-path-changed');
  });

  it('rejects an AI PR that weakens the test script via package.json', () => {
    const before = JSON.stringify({ scripts: { test: 'vitest run' } });
    const after = JSON.stringify({ scripts: { test: 'true' } });
    const decision = evaluatePr(aiConfig(), aiPr({ manifests: [{ path: 'package.json', before, after }] }));
    expect(decision.decision).toBe('rejected');
    expect(decision.reasons).toContain('protected-manifest-section-changed');
  });

  it('blocks AI repairs when the repository has not declared allowed_ai_paths', () => {
    const decision = evaluatePr(
      aiConfig((config) => { config.repair.allowed_ai_paths = []; }),
      aiPr(),
    );
    expect(decision.decision).toBe('rejected');
    expect(decision.reasons).toContain('ai-path-not-allowed');
  });

  it('rejects repairs touching paths outside the declared surface', () => {
    const decision = evaluatePr(
      aiConfig(),
      aiPr({ files: ['package.json', 'pnpm-lock.yaml', 'scripts/deploy.sh'] }),
    );
    expect(decision.decision).toBe('rejected');
    expect(decision.reasons).toContain('ai-path-not-allowed');
  });

  it('rejects repairs changing too many application files', () => {
    const files = ['package.json', 'pnpm-lock.yaml'];
    for (let i = 0; i < 11; i++) files.push(`packages/server/src/file${i}.ts`);
    const decision = evaluatePr(aiConfig(), aiPr({ files }));
    expect(decision.decision).toBe('rejected');
    expect(decision.reasons).toContain('too-many-application-files');
  });

  it('requires the ai-assisted label for provenance', () => {
    const decision = evaluatePr(aiConfig(), aiPr({ labels: ['maintenance'] }));
    expect(decision.decision).toBe('needs-human');
    expect(decision.reasons).toContain('missing-ai-label');
  });

  it('blocks AI repairs when repair.enabled is false', () => {
    const decision = evaluatePr(aiConfig((c) => { c.repair.enabled = false; }), aiPr());
    expect(decision.decision).toBe('needs-human');
    expect(decision.reasons).toContain('ai-repair-disabled');
  });

  it('keeps a major update inside an AI repair gated on policy authorization', () => {
    const decision = evaluatePr(aiConfig(), aiPr({ title: 'Repair compatibility for express 5.0.0', dependencyUpdates: [{ name: 'express', fromVersion: '4.19.0', toVersion: '5.0.0', updateType: 'major' }] }));
    expect(decision.decision).toBe('needs-human');
    expect(decision.reasons).toContain('major-requires-policy-authorization');
  });
});

describe('evaluatePr — determinism and idempotence', () => {
  it('returns an identical decision for a duplicated event (same input, twice)', () => {
    const config = makeConfig();
    const pr = makePr();
    const first = evaluatePr(config, pr);
    const second = evaluatePr(config, { ...pr });
    expect(second).toEqual(first);
  });

  it('never enables automerge outside the eligible decision', () => {
    const cases: PrInput[] = [
      makePr({ author: 'stranger' }),
      makePr({ baseRef: 'develop' }),
      makePr({ files: ['package.json', '.github/dependabot.yml'] }),
      makePr({ title: 'Bump eslint from 8.57.0 to 9.0.0' }),
    ];
    for (const pr of cases) {
      const decision = evaluatePr(makeConfig(), pr);
      expect(decision.decision).not.toBe('eligible');
      expect(decision.automerge).toBe(false);
    }
  });
});
