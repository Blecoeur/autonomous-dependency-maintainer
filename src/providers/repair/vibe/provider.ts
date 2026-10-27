import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MaintenanceConfig } from '../../../config/schema.js';
import { adapterFor } from '../../ecosystem-node-pnpm/adapter.js';
import { validatePatch } from '../patch-validation.js';
import type { RepairProvider } from '../provider.js';
import type { RepairRequest, RepairStatusReport } from '../types.js';
import {
  DEFAULT_VIBE_CONFIG,
  renderVibeConfig,
  writeVibeHome,
  type VibeRunConfig,
} from './config.js';
import { buildRepairPrompt, repairSystemPrompt } from './prompt.js';
import { RepairWorkspace, scrubbedEnv, tail, type CommandOutcome } from './sandbox.js';

export interface VibeRepairProviderOptions {
  /**
   * How the vibe CLI is made available. Default: `uv tool run --from
   * mistral-vibe==<version> vibe` (pinned, no global install). Override in
   * tests or when the runner image ships vibe.
   */
  command?: string[];
  /** Pinned mistral-vibe version, e.g. "3.0.3". */
  version?: string;
  /** Model name; defaults to REPAIR_MODEL_NAME or the vibe default (mistral-medium-3.5). */
  model?: string;
  /** Workspace factory; injectable for tests. */
  createWorkspace?: (request: RepairRequest) => RepairWorkspace;
  /** Config used for the vibe run; defaults from REPAIR_* env or defaults. */
  runConfig?: Partial<VibeRunConfig>;
}

interface VibeExport {
  outcome?: string;
  exit_code?: number;
  stop_reason?: string | null;
  error?: { message?: string } | null;
  session_id?: string | null;
  cost_usd?: number | null;
  steps?: number | null;
}

/**
 * Repair provider running the Mistral vibe CLI on the CI runner
 * (spec 7.2-7.3, runner variant).
 *
 * One `run()` is one repair attempt: clone the PR head, apply the
 * dependency update, reproduce the failure, let the agent fix it, then
 * re-verify and validate the patch with the policy engine. The provider
 * never opens PRs and never holds GitHub write credentials; it returns a
 * validated patch for the privileged gateway.
 */
export class VibeRepairProvider implements RepairProvider {
  constructor(
    private readonly config: MaintenanceConfig,
    private readonly options: VibeRepairProviderOptions = {},
  ) {}

  async run(request: RepairRequest): Promise<RepairStatusReport> {
    const base = { idempotency_key: request.idempotency_key };
    let workspace: RepairWorkspace;
    try {
      const createWorkspace =
        this.options.createWorkspace ??
        (() => RepairWorkspace.create(request, process.env['GITHUB_READ_TOKEN']));
      workspace = createWorkspace(request);
    } catch (err) {
      return {
        status: 'internal_error',
        reason: `workspace setup failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
        ...base,
      };
    }
    try {
      const reproduce = this.verify(workspace, request);
      if (reproduce.ok) {
        return {
          status: 'not_reproducible',
          attempt_count: 0,
          reason: 'the dependency update passes build and tests as-is',
          ...base,
        };
      }

      const run = await this.runAgent(workspace, request, reproduce);
      if (run.status !== 'finished') {
        return {
          status: 'transient_failure',
          attempt_count: run.steps ?? 0,
          reason: `agent run ended as ${run.status}${run.error ? `: ${run.error}` : ''}`,
          ...base,
        };
      }

      const verify = this.verify(workspace, request);
      if (!verify.ok) {
        return {
          status: 'blocked',
          attempt_count: run.steps ?? 0,
          reason: 'the harness re-ran the verification after the agent finished and it still fails',
          ...base,
        };
      }

      const validation = validatePatch(this.config, request, {
        baseline: workspace.baseline,
        workspace: workspace.workspace,
        dependencyFilePaths: adapterFor(this.config).dependencyFilePaths(),
      });
      if (!validation.allowed) {
        return {
          status: 'blocked',
          attempt_count: run.steps ?? 0,
          reason: `patch rejected by the policy guard: ${validation.violations.join('; ')}`,
          changed_application_files: validation.changed_application_files,
          ...base,
        };
      }

      const patch = workspace.producePatch();
      if (!patch.trim()) {
        return {
          status: 'blocked',
          attempt_count: run.steps ?? 0,
          reason: 'verification passes but the agent produced no patch',
          ...base,
        };
      }

      return {
        status: 'pr_created',
        attempt_count: run.steps ?? 0,
        reason: run.stop_reason ?? 'repair verified and validated; patch ready for the gateway',
        changed_application_files: validation.changed_application_files,
        patch,
        ...base,
      };
    } catch (err) {
      return {
        status: 'internal_error',
        reason: `${err instanceof Error ? err.constructor.name : 'Error'}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        ...base,
      };
    } finally {
      workspace.cleanup();
    }
  }

  private verify(workspace: RepairWorkspace, request: RepairRequest): CommandOutcome {
    if (request.commands.build) {
      const build = workspace.run(request.commands.build);
      if (!build.ok) {
        return build;
      }
    }
    return workspace.run(request.commands.test);
  }

  private async runAgent(
    workspace: RepairWorkspace,
    request: RepairRequest,
    reproduce: CommandOutcome,
  ): Promise<{ status: string; steps?: number; error?: string; stop_reason?: string }> {
    const runConfig: VibeRunConfig = {
      ...DEFAULT_VIBE_CONFIG,
      version: this.options.version ?? process.env['REPAIR_VIBE_VERSION'] ?? '3.0.3',
      model: this.options.model ?? process.env['REPAIR_MODEL_NAME'] ?? DEFAULT_VIBE_CONFIG.model,
      ...this.options.runConfig,
    };

    const vibeHome = mkdtempSync(join(tmpdir(), 'vibe-home-'));
    const outputDir = join(vibeHome, 'export');
    const promptPath = join(vibeHome, 'prompt.md');
    try {
      writeVibeHome(
        vibeHome,
        renderVibeConfig(request, runConfig),
        repairSystemPrompt(),
      );
      writeFileSync(
        promptPath,
        buildRepairPrompt(this.config, request, tail(reproduce.output)),
      );

      const command = this.options.command ?? [
        'uv',
        'tool',
        'run',
        `--from`,
        `mistral-vibe==${runConfig.version}`,
        '--',
        'vibe',
      ];
      const args = [
        ...command.slice(1),
        '--prompt-file',
        promptPath,
        '--output',
        'json',
        '--output-dir',
        outputDir,
        '--max-turns',
        String(runConfig.maxTurns),
        '--time-limit',
        String(runConfig.timeLimitSeconds),
        '--trust',
        '--enabled-tools',
        'read_file',
        '--enabled-tools',
        'grep',
        '--enabled-tools',
        'edit',
        '--enabled-tools',
        'write_file',
        '--enabled-tools',
        'bash',
        '--disabled-tools',
        'task',
        '--disabled-tools',
        'todo',
        '--disabled-tools',
        'ask_user_question',
        '--disabled-tools',
        'web_fetch',
        '--disabled-tools',
        'web_search',
        '--disabled-tools',
        'skill',
      ];

      let exitCode = 0;
      try {
        execFileSync(command[0] as string, args, {
          cwd: workspace.workspace,
          env: {
            ...scrubbedEnv(),
            VIBE_HOME: vibeHome,
            MISTRAL_API_KEY: process.env['MISTRAL_API_KEY'] ?? '',
          },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          maxBuffer: 64 * 1024 * 1024,
          timeout: (runConfig.timeLimitSeconds + 120) * 1000,
        });
      } catch (err) {
        const e = err as { status?: number; stderr?: string; message?: string };
        exitCode = typeof e.status === 'number' ? e.status : 1;
        if (exitCode !== 0) {
          process.stderr.write(
            `vibe agent exited ${exitCode}: ${e.stderr ?? e.message ?? 'no output'}\n`,
          );
        }
      }

      const report = readExport(outputDir);
      const steps = report?.steps ?? undefined;
      const stopReason = report?.stop_reason ?? undefined;
      // Exit 3 = a limit was reached (turns, time, tokens, price): the
      // repair did not finish within its budget.
      if (exitCode === 3) {
        return { status: 'budget_exceeded', steps, stop_reason: stopReason };
      }
      if (exitCode !== 0) {
        return {
          status: 'transient_failure',
          steps,
          error: report?.error?.message ?? `vibe exited with code ${exitCode}`,
        };
      }
      return {
        status: report?.outcome ?? 'finished',
        steps,
        stop_reason: stopReason,
      };
    } finally {
      rmSync(vibeHome, { recursive: true, force: true });
    }
  }
}

function readExport(outputDir: string): VibeExport | null {
  try {
    return JSON.parse(readFileSync(join(outputDir, 'export.json'), 'utf8')) as VibeExport;
  } catch {
    return null;
  }
}
