import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validatePatch } from '../../src/providers/repair/patch-validation.js';
import { defaultConfig, type MaintenanceConfig } from '../../src/config/schema.js';
import { idempotencyKey, type RepairRequest } from '../../src/providers/repair/types.js';

const DEPENDENCY_FILES = ['package.json', '**/package.json', 'pnpm-lock.yaml', '**/pnpm-lock.yaml'];

function makeConfig(overrides?: (c: MaintenanceConfig) => void): MaintenanceConfig {
  const c = defaultConfig('demo-repo', 'node-pnpm');
  c.repair.allowed_ai_paths = ['src/**'];
  overrides?.(c);
  return c;
}

function makeRequest(): RepairRequest {
  return {
    schema_version: '1',
    idempotency_key: idempotencyKey('owner/repo', 10, 'abcdef123'),
    repository: 'owner/repo',
    base_branch: 'main',
    original_pr_number: 10,
    original_head_sha: 'abcdef123',
    dependency_updates: [
      { name: 'multer', from_version: '2.4.0', to_version: '2.5.0', update_type: 'minor' },
    ],
    commands: { install: 'pnpm install', build: 'pnpm build', test: 'pnpm test' },
    ci: { run_id: 1, workflow_name: 'CI', conclusion: 'failure' },
    policy: {
      max_attempts: 3,
      allow_test_changes: false,
      allow_ci_changes: false,
      preserve_public_api: true,
      max_changed_application_files: 10,
    },
  };
}

interface Tree {
  root: string;
  write: (path: string, content: string) => void;
}

function makeTree(prefix: string): Tree {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return {
    root,
    write(path, content) {
      const absolute = join(root, path);
      mkdirSync(join(absolute, '..'), { recursive: true });
      writeFileSync(absolute, content);
    },
  };
}

const MANIFEST = JSON.stringify(
  { name: 'demo', scripts: { test: 'vitest run' }, dependencies: { multer: '^2.4.0' } },
  null,
  2,
);

describe('validatePatch', () => {
  let baseline: Tree;
  let workspace: Tree;

  beforeEach(() => {
    baseline = makeTree('repair-baseline-');
    workspace = makeTree('repair-workspace-');
    for (const tree of [baseline, workspace]) {
      tree.write('package.json', MANIFEST);
      tree.write('src/index.ts', 'export const x = 1;\n');
    }
  });

  afterEach(() => {
    rmSync(baseline.root, { recursive: true, force: true });
    rmSync(workspace.root, { recursive: true, force: true });
  });

  function validate(config = makeConfig()) {
    return validatePatch(config, makeRequest(), {
      baseline: baseline.root,
      workspace: workspace.root,
      dependencyFilePaths: DEPENDENCY_FILES,
    });
  }

  it('accepts a minimal application fix inside the allowed surface', () => {
    workspace.write('src/index.ts', 'export const x = 2;\n');
    const result = validate();
    expect(result.allowed).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.changed_application_files).toEqual(['src/index.ts']);
  });

  it('rejects a change to a forbidden path (test file)', () => {
    workspace.write('src/index.test.ts', 'export const y = 1;\n');
    const result = validate();
    expect(result.allowed).toBe(false);
    expect(result.violations.join('\n')).toContain('forbidden path changed: src/index.test.ts');
  });

  it('rejects a change to a CI workflow', () => {
    workspace.write('.github/workflows/ci.yml', 'on: push\n');
    const result = validate();
    expect(result.allowed).toBe(false);
    expect(result.violations.join('\n')).toContain('forbidden path changed: .github/workflows/ci.yml');
  });

  it('rejects a protected manifest section change (weakened test script)', () => {
    workspace.write(
      'package.json',
      MANIFEST.replace('"test": "vitest run"', '"test": "true"'),
    );
    const result = validate();
    expect(result.allowed).toBe(false);
    expect(result.violations.join('\n')).toContain('protected manifest section changed: package.json#scripts');
  });

  it('rejects an added manifest', () => {
    workspace.write('packages/a/package.json', MANIFEST);
    const result = validate();
    expect(result.allowed).toBe(false);
    expect(result.violations.join('\n')).toContain('manifest added/removed: packages/a/package.json');
  });

  it('rejects application changes outside the allowed AI surface', () => {
    workspace.write('scripts/build.sh', 'echo hi\n');
    const result = validate();
    expect(result.allowed).toBe(false);
    expect(result.violations.join('\n')).toContain(
      'path outside the allowed AI surface: scripts/build.sh',
    );
  });

  it('rejects application changes when no allowed_ai_paths is configured', () => {
    workspace.write('src/index.ts', 'export const x = 2;\n');
    const result = validate(makeConfig((c) => (c.repair.allowed_ai_paths = [])));
    expect(result.allowed).toBe(false);
    expect(result.violations.join('\n')).toContain('no repair.allowed_ai_paths configured');
  });

  it('rejects when the changed-file budget is exceeded', () => {
    const config = makeConfig((c) => (c.repair.max_changed_application_files = 1));
    workspace.write('src/a.ts', 'export const a = 1;\n');
    workspace.write('src/b.ts', 'export const b = 1;\n');
    const result = validate(config);
    expect(result.allowed).toBe(false);
    expect(result.violations.join('\n')).toContain('exceeds the budget 1');
  });

  it('accepts manifest-only changes (no application files)', () => {
    workspace.write('pnpm-lock.yaml', 'lockfileVersion: 9\n');
    const result = validate();
    expect(result.allowed).toBe(true);
    expect(result.changed_application_files).toEqual([]);
  });

  it('reports an empty patch as allowed with no changes', () => {
    const result = validate();
    expect(result.allowed).toBe(true);
    expect(result.changed_files).toEqual([]);
  });
});
