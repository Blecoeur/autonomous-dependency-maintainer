import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VibeRepairProvider } from '../../src/providers/repair/vibe/provider.js';
import { defaultConfig, type MaintenanceConfig } from '../../src/config/schema.js';
import { idempotencyKey, type RepairRequest } from '../../src/providers/repair/types.js';
import { scrubbedEnv, tail } from '../../src/providers/repair/vibe/sandbox.js';
import { renderVibeConfig, REPAIR_SYSTEM_PROMPT_ID } from '../../src/providers/repair/vibe/config.js';
import { buildRepairPrompt, repairSystemPrompt } from '../../src/providers/repair/vibe/prompt.js';
import type { RepairWorkspace } from '../../src/providers/repair/vibe/sandbox.js';

function makeConfig(): MaintenanceConfig {
  const c = defaultConfig('demo-repo', 'node-pnpm');
  c.repair.allowed_ai_paths = ['src/**'];
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
    commands: { install: null, build: null, test: 'true' },
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

/** A fake workspace: no git, no clone; commands are scripted. */
class FakeWorkspace {
  readonly root: string;
  readonly baseline: string;
  readonly workspace: string;
  cleaned = false;
  testScript: string;

  constructor(testScript: string) {
    this.root = mkdtempSync(join(tmpdir(), 'fake-repair-'));
    this.baseline = join(this.root, 'baseline');
    this.workspace = join(this.root, 'workspace');
    for (const dir of [this.baseline, this.workspace]) {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'package.json'), '{"name":"demo"}\n');
      writeFileSync(join(dir, 'src', 'index.ts'), 'export const x = 1;\n');
    }
    this.testScript = testScript;
  }

  run(command: string): { ok: boolean; returncode: number; output: string } {
    if (command !== 'true' && command !== 'false') {
      return { ok: false, returncode: 127, output: `unexpected command: ${command}` };
    }
    return command === 'true'
      ? { ok: true, returncode: 0, output: 'ok' }
      : { ok: false, returncode: 1, output: 'boom: test failed' };
  }

  producePatch(): string {
    return 'diff --git a/src/index.ts b/src/index.ts\n';
  }

  cleanup(): void {
    this.cleaned = true;
    rmSync(this.root, { recursive: true, force: true });
  }
}

describe('VibeRepairProvider', () => {
  let workspace: FakeWorkspace;

  function provider(fake: FakeWorkspace, vibeExit = 0) {
    return new VibeRepairProvider(makeConfig(), {
      createWorkspace: () => fake as unknown as RepairWorkspace,
      // A command that never runs vibe: the provider's execFileSync will
      // fail on it, but we intercept earlier by scripting exit codes below.
      command: ['/bin/true'],
      runConfig: { version: '0.0.0-test', maxTurns: 5, timeLimitSeconds: 60 },
    });
  }

  it('reports not_reproducible when verification already passes', async () => {
    workspace = new FakeWorkspace('pass');
    const p = new VibeRepairProvider(makeConfig(), {
      createWorkspace: () => workspace as unknown as RepairWorkspace,
    });
    // FakeWorkspace.run only knows 'true'/'false'; simulate a passing oracle.
    workspace.run = () => ({ ok: true, returncode: 0, output: 'ok' });
    const report = await p.run(makeRequest());
    expect(report.status).toBe('not_reproducible');
    expect(workspace.cleaned).toBe(true);
  });

  it('runs the agent and re-verifies; passes with a valid patch', async () => {
    workspace = new FakeWorkspace('fail');
    let verifyCount = 0;
    workspace.run = (command: string) => {
      verifyCount += 1;
      // First call: reproduce (fails). Second call: re-verify (passes).
      if (verifyCount === 1) {
        return { ok: false, returncode: 1, output: 'boom: test failed' };
      }
      return { ok: true, returncode: 0, output: 'ok' };
    };
    const p = new VibeRepairProvider(makeConfig(), {
      createWorkspace: () => workspace as unknown as RepairWorkspace,
      command: ['/bin/true'],
      runConfig: { version: '0.0.0-test', maxTurns: 5, timeLimitSeconds: 60 },
    });
    // The fake "vibe" (/bin/true) writes no export; the provider must
    // treat exit 0 + missing export as finished.
    const report = await p.run(makeRequest());
    expect(report.status).toBe('pr_created');
    expect(report.patch).toContain('diff --git');
    expect(report.idempotency_key).toBe(makeRequest().idempotency_key);
    expect(workspace.cleaned).toBe(true);
  });

  it('reports blocked when re-verification still fails after the agent', async () => {
    workspace = new FakeWorkspace('fail');
    workspace.run = () => ({ ok: false, returncode: 1, output: 'boom: test failed' });
    const p = new VibeRepairProvider(makeConfig(), {
      createWorkspace: () => workspace as unknown as RepairWorkspace,
      command: ['/bin/true'],
      runConfig: { version: '0.0.0-test', maxTurns: 5, timeLimitSeconds: 60 },
    });
    const report = await p.run(makeRequest());
    expect(report.status).toBe('blocked');
    expect(report.reason).toContain('re-ran the verification');
  });

  it('reports transient_failure when the agent command itself fails', async () => {
    workspace = new FakeWorkspace('fail');
    let verifyCount = 0;
    workspace.run = () => {
      verifyCount += 1;
      return verifyCount === 1
        ? { ok: false, returncode: 1, output: 'boom' }
        : { ok: true, returncode: 0, output: 'ok' };
    };
    const p = new VibeRepairProvider(makeConfig(), {
      createWorkspace: () => workspace as unknown as RepairWorkspace,
      command: ['/bin/false'],
      runConfig: { version: '0.0.0-test', maxTurns: 5, timeLimitSeconds: 60 },
    });
    const report = await p.run(makeRequest());
    expect(report.status).toBe('transient_failure');
  });

  it('reports internal_error when the workspace cannot be created', async () => {
    const p = new VibeRepairProvider(makeConfig(), {
      createWorkspace: () => {
        throw new Error('clone failed');
      },
    });
    const report = await p.run(makeRequest());
    expect(report.status).toBe('internal_error');
    expect(report.reason).toContain('clone failed');
  });
});

describe('scrubbedEnv', () => {
  it('keeps only the safe keys', () => {
    const env = scrubbedEnv();
    expect(env['MISTRAL_API_KEY']).toBeUndefined();
    expect(env['GITHUB_READ_TOKEN']).toBeUndefined();
    expect(env['GITHUB_TOKEN']).toBeUndefined();
    expect(env['PATH']).toBeDefined();
  });
});

describe('tail', () => {
  it('keeps the last lines', () => {
    expect(tail(Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n'), 5)).toBe(
      ['line 95', 'line 96', 'line 97', 'line 98', 'line 99'].join('\n'),
    );
  });
});

describe('renderVibeConfig', () => {
  it('pins the doctrine as system prompt and denies leaving the workdir', () => {
    const toml = renderVibeConfig(makeRequest(), {
      version: '3.0.3',
      model: 'mistral-large-latest',
      maxTurns: 40,
      timeLimitSeconds: 2700,
    });
    expect(toml).toContain(`system_prompt_id = "${REPAIR_SYSTEM_PROMPT_ID}"`);
    expect(toml).toContain('outside_workdir = "deny"');
    expect(toml).toContain('permission = "always"');
    expect(toml).toContain('"pnpm"');
    expect(toml).toContain('"true"'); // the test command name from the request
  });
});

describe('repair doctrine and prompt', () => {
  it('ships a reviewable doctrine artifact', () => {
    const doctrine = repairSystemPrompt();
    expect(doctrine).toContain('dependency-compatibility repair');
    expect(doctrine).toContain('BLOCKED');
  });

  it('builds the repair prompt with the failure tail and the oracle', () => {
    const prompt = buildRepairPrompt(makeConfig(), makeRequest(), 'boom: test failed');
    expect(prompt).toContain('multer 2.4.0 -> 2.5.0');
    expect(prompt).toContain('boom: test failed');
    expect(prompt).toContain('true'); // test oracle
    expect(prompt).toContain('src/**');
  });
});
