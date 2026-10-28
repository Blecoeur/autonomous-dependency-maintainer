import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RepairRequest } from '../types.js';

/**
 * The repair workspace (spec 7.9).
 *
 * One repair attempt gets TWO directories:
 *
 * - `baseline/`: the PR head cloned at the exact head SHA, with the
 *   dependency update applied and dependencies installed. This is the
 *   reference the agent's patch is diffed against, and the tree the
 *   harness re-verifies.
 * - `workspace/`: a copy of `baseline/` the agent edits freely.
 *
 * Security posture:
 * - The clone uses a READ-ONLY token (GITHUB_READ_TOKEN); the process
 *   never holds GitHub write credentials.
 * - Repository commands (install/build/test) run with a scrubbed
 *   environment: only PATH/HOME/LANG/TMPDIR survive, so MISTRAL_API_KEY
 *   and any other CI secret can never leak into PR-controlled scripts.
 */
export class RepairWorkspace {
  readonly root: string;
  readonly baseline: string;
  readonly workspace: string;

  private constructor(root: string) {
    this.root = root;
    this.baseline = join(root, 'baseline');
    this.workspace = join(root, 'workspace');
  }

  static create(request: RepairRequest, githubReadToken?: string): RepairWorkspace {
    const root = mkdtempSync(join(tmpdir(), 'repair-'));
    const self = new RepairWorkspace(root);
    // The read token travels in an HTTP extra header, never in the URL:
    // a URL-embedded credential can leak into git error output and logs.
    const authArgs = githubReadToken
      ? ['-c', `http.extraheader=Authorization: Basic ${basicAuth(githubReadToken)}`]
      : [];
    self.git(
      [
        ...authArgs,
        'clone',
        '--quiet',
        '--depth',
        '1',
        '--no-checkout',
        `https://github.com/${request.repository}.git`,
        self.baseline,
      ],
      root,
    );
    self.git(
      [
        ...authArgs,
        '-C',
        self.baseline,
        'fetch',
        '--quiet',
        '--depth',
        '1',
        'origin',
        request.original_head_sha,
      ],
      root,
    );
    self.git(['-C', self.baseline, 'checkout', '--quiet', 'FETCH_HEAD'], root);
    self.applyDependencyUpdates(request);
    execFileSync('cp', ['-a', `${self.baseline}/.`, `${self.workspace}/`]);
    return self;
  }

  /** Runs a repository command with a scrubbed environment (no secrets). */
  run(command: string, options?: { cwd?: string; timeoutMs?: number }): CommandOutcome {
    try {
      const stdout = execFileSync(command, {
        cwd: options?.cwd ?? this.workspace,
        shell: '/bin/sh',
        env: scrubbedEnv(),
        timeout: options?.timeoutMs ?? 20 * 60 * 1000,
        maxBuffer: 64 * 1024 * 1024,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { ok: true, returncode: 0, output: stdout };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string; message?: string };
      return {
        ok: false,
        returncode: typeof e.status === 'number' ? e.status : 1,
        output: `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim() || String(e.message ?? err),
      };
    }
  }

  /** Unified diff of the agent's edits against the baseline (empty when none). */
  producePatch(): string {
    return this.git(['-C', this.workspace, 'diff', '--', '.', ':(exclude).git'], this.root, {
      tolerateFailure: true,
    });
  }

  cleanup(): void {
    rmSync(this.root, { recursive: true, force: true });
  }

  private git(args: string[], cwd: string, options?: { tolerateFailure?: boolean }): string {
    try {
      return execFileSync('git', args, {
        cwd,
        env: scrubbedEnv(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (err) {
      if (options?.tolerateFailure) {
        const e = err as { stdout?: string };
        return typeof e.stdout === 'string' ? e.stdout : '';
      }
      const e = err as { stderr?: string; message?: string };
      throw new Error(`git ${args[0]} failed: ${e.stderr ?? e.message ?? err}`);
    }
  }

  private applyDependencyUpdates(request: RepairRequest): void {
    const manifestPath = join(this.baseline, 'package.json');
    if (!existsSync(manifestPath)) {
      throw new Error('package.json not found at the repository root; ecosystem adapter needed');
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    for (const update of request.dependency_updates) {
      let found = false;
      for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        const deps = manifest[section];
        if (typeof deps === 'object' && deps !== null && update.name in deps) {
          const current = (deps as Record<string, string>)[update.name] as string;
          const next = current.startsWith('^')
            ? `^${update.to_version}`
            : current.startsWith('~')
              ? `~${update.to_version}`
              : update.to_version;
          (deps as Record<string, string>)[update.name] = next;
          found = true;
          break;
        }
      }
      if (!found) {
        throw new Error(`package ${update.name} not found in any dependency section`);
      }
    }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    if (request.commands.install) {
      const install = this.run(request.commands.install, { cwd: this.baseline });
      if (!install.ok) {
        throw new Error(`install command failed (exit ${install.returncode})`);
      }
    }
  }
}

export interface CommandOutcome {
  ok: boolean;
  returncode: number;
  output: string;
}

function basicAuth(token: string): string {
  return Buffer.from(`x-access-token:${token}`).toString('base64');
}

/** The environment repository commands may see: no CI or provider secrets. */
export function scrubbedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'CI']) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

export function tail(output: string, lines = 60): string {
  return output.split('\n').slice(-lines).join('\n').trim();
}
