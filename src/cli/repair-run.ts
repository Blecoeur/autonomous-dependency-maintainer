#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { loadConfig } from '../config/load.js';
import type { MaintenanceConfig } from '../config/schema.js';
import { VibeRepairProvider } from '../providers/repair/vibe/provider.js';
import type { RepairProvider } from '../providers/repair/provider.js';
import { MockRepairProvider } from '../providers/repair/mock/adapter.js';
import type { RepairRequest, RepairStatusReport } from '../providers/repair/types.js';

/**
 * maintenance-repair-run — runs ONE repair attempt for a validated
 * RepairRequest and prints the RepairStatusReport JSON.
 *
 * Usage:
 *   maintenance-repair-run --config <file> <request.json>
 *
 * The provider is selected from the validated config (repair.provider):
 * 'vibe' runs the Mistral vibe CLI on this runner; 'mock' is the
 * deterministic test double. Credentials come exclusively from the
 * environment (MISTRAL_API_KEY, GITHUB_READ_TOKEN); the repository's own
 * code never sees them (the provider scrubs the environment for every
 * command it runs).
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

  const provider: RepairProvider = providerFor(config);

  let report: RepairStatusReport;
  try {
    report = await provider.run(request);
  } catch (err) {
    report = {
      status: 'internal_error',
      idempotency_key: request.idempotency_key,
      reason: `provider threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

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
    case 'vibe':
      return new VibeRepairProvider(config);
    case 'mock':
      return new MockRepairProvider();
    case 'none':
      throw new Error("repair.provider is 'none' but a repair was requested");
    default:
      throw new Error(`unsupported repair provider: ${config.repair.provider satisfies never}`);
  }
}

process.exit(await main());
