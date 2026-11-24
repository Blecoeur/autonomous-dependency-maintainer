#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { loadConfig } from '../config/load.js';
import type { MaintenanceConfig } from '../config/schema.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MistralAgentRepairProvider } from '../providers/repair/mistral/adapter.js';
import type { RepairProvider } from '../providers/repair/provider.js';
import { MockRepairProvider } from '../providers/repair/mock/adapter.js';
import type { RepairRequest, RepairStatus, RepairStatusReport } from '../providers/repair/types.js';

const TERMINAL_STATUSES: ReadonlySet<RepairStatus> = new Set([
  'pr_created',
  'blocked',
  'not_reproducible',
  'transient_failure',
  'budget_exceeded',
  'stale_original_pr',
  'internal_error',
]);

/**
 * maintenance-repair-run — submits ONE repair attempt for a validated
 * RepairRequest to the hosted provider and polls it to completion.
 *
 * Usage:
 *   maintenance-repair-run --config <file> <request.json>
 *
 * The provider is selected from the validated config (repair.provider):
 * 'mistral-agent' opens a session on the Mistral-MANAGED repair agent
 * (agents deploy) through the Session API, via the thin client
 * agent/client.py. The session idempotency key is the request's idempotency
 * key, so replays return the same session/turn server-side. The agent
 * harness and all repository commands run inside the session's Mistral
 * sandbox on Mistral Cloud — NOT on this runner; this process only forwards
 * JSON. 'mock' is the deterministic test double. Credentials come
 * exclusively from the environment (MISTRAL_API_KEY; optional
 * REPAIR_AGENT_NAME, MISTRAL_API_URL); the repository's own code never
 * sees them.
 *
 * Polling is bounded: REPAIR_POLL_INTERVAL_SECONDS (default 15) and
 * REPAIR_TIMEOUT_SECONDS (default 1800); on timeout the report is
 * internal_error and the execution keeps running provider-side (a replay
 * with the same idempotency key resumes observation of the same run).
 *
 * Exit code: 0 when the report status is pr_created or blocked (both are
 * normal outcomes — the PR stays red on its own checks otherwise), 1 on
 * transient_failure / internal_error, 2 on usage errors.
 */
async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const opts: Record<string, string> = {};
  let positional: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = args[i + 1];
    if (arg === '--config' && value !== undefined) {
      opts['config'] = value;
      i++;
    } else if (arg !== undefined && !arg.startsWith('--') && positional === undefined) {
      positional = arg;
    } else {
      process.stderr.write(`unknown argument: ${arg ?? '(none)'}\n`);
      return 2;
    }
  }
  if (!opts['config'] || !positional) {
    process.stderr.write('usage: maintenance-repair-run --config <file> <request.json>\n');
    return 2;
  }

  const configResult = loadConfig(readFileSync(opts['config'], 'utf8'));
  if (!configResult.ok) {
    process.stderr.write('invalid config:\n');
    for (const error of configResult.errors) {
      process.stderr.write(`  - ${error.path || '(root)'}: ${error.message}\n`);
    }
    return 2;
  }
  const config: MaintenanceConfig = configResult.config;

  let request: RepairRequest;
  try {
    request = JSON.parse(readFileSync(positional, 'utf8')) as RepairRequest;
  } catch (err) {
    process.stderr.write(`cannot parse repair request: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  let provider: RepairProvider;
  try {
    provider = providerFor(config);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  let report: RepairStatusReport;
  try {
    const execution = await provider.submit(request);
    console.error(`submitted repair execution ${execution.execution_id} (${execution.provider})`);
    report = await poll(provider, execution.execution_id);
  } catch (err) {
    report = {
      status: 'internal_error',
      idempotency_key: request.idempotency_key,
      reason: `provider threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  report.idempotency_key = report.idempotency_key ?? request.idempotency_key;

  console.log(JSON.stringify(report, null, 2));

  const summaryFile = process.env['GITHUB_STEP_SUMMARY'];
  if (summaryFile) {
    appendFileSync(
      summaryFile,
      `### Repair attempt: ${report.status}\n\n${report.reason ?? ''}\n`,
    );
  }

  if (report.status === 'pr_created') {
    const patchFile = process.env['REPAIR_PATCH_FILE'];
    if (patchFile && report.patch) {
      writeFileSync(patchFile, report.patch);
    }
    return 0;
  }
  if (report.status === 'blocked') {
    return 0;
  }
  return 1;
}

function providerFor(config: MaintenanceConfig): RepairProvider {
  switch (config.repair.provider) {
    case 'mistral-agent': {
      const apiKey = process.env['MISTRAL_API_KEY'];
      if (!apiKey) {
        throw new Error('MISTRAL_API_KEY is not set; cannot reach the Mistral repair agent.');
      }
      // dist/cli/repair-run.js -> <framework root>/agent/client.py
      const here = dirname(fileURLToPath(import.meta.url));
      return new MistralAgentRepairProvider({
        apiKey,
        agentName: process.env['REPAIR_AGENT_NAME'] ?? 'repair-dependency-update',
        clientPath: process.env['REPAIR_CLIENT_PATH'] ?? join(here, '..', '..', '..', 'agent', 'client.py'),
        baseUrl: process.env['MISTRAL_API_URL'],
      });
    }
    case 'mock':
      return new MockRepairProvider();
    case 'none':
      throw new Error("repair.provider is 'none' but a repair was requested");
    default:
      throw new Error(`unsupported repair provider: ${config.repair.provider satisfies never}`);
  }
}

async function poll(provider: RepairProvider, executionId: string): Promise<RepairStatusReport> {
  const intervalSeconds = Number(process.env['REPAIR_POLL_INTERVAL_SECONDS'] ?? '15');
  const timeoutSeconds = Number(process.env['REPAIR_TIMEOUT_SECONDS'] ?? '1800');
  const deadline = Date.now() + timeoutSeconds * 1000;
  for (;;) {
    const report = await provider.status(executionId);
    if (TERMINAL_STATUSES.has(report.status)) {
      return report;
    }
    if (Date.now() >= deadline) {
      return {
        status: 'internal_error',
        reason: `timed out after ${timeoutSeconds}s waiting for execution ${executionId}; ` +
          'the execution may still be running provider-side — replay with the same idempotency key',
      };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000));
  }
}

process.exit(await main());
