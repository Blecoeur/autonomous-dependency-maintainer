#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { loadConfig } from '../config/load.js';
import { evaluateRepairEligibility, type CiRunFacts, type RepairStateFacts } from '../policy/repair-eligibility.js';
import type { PrInput } from '../policy/pr.js';

/**
 * maintenance-repair-request — deterministic guards (spec 7.1) deciding
 * whether a CI-red dependency PR may be sent to the repair provider, and
 * building the RepairRequest when it may.
 *
 * Inputs:
 *   maintenance-repair-request --config <file> --pr <pr.json> --ci <ci.json>
 *     --repo <owner/name> --expected-workflow <name> --state <state.json>
 *
 * Prints the decision JSON; exit 0 either way (an ineligible repair is a
 * normal outcome, not a CI failure — the PR stays red on its own checks).
 */
function main(): number {
  const args = process.argv.slice(2);
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = args[i + 1];
    if (arg !== undefined && arg.startsWith('--') && value !== undefined) {
      opts[arg.slice(2)] = value;
      i++;
    } else {
      process.stderr.write(`unknown argument: ${arg ?? '(none)'}\n`);
      return 2;
    }
  }
  const required = ['config', 'pr', 'ci', 'repo', 'expected-workflow', 'state'];
  const missing = required.filter((k) => !opts[k]);
  if (missing.length > 0) {
    process.stderr.write(`missing arguments: ${missing.join(', ')}\n`);
    return 2;
  }

  const configResult = loadConfig(readFileSync(opts['config'] as string, 'utf8'));
  if (!configResult.ok) {
    process.stderr.write(`invalid config:\n`);
    for (const error of configResult.errors) {
      process.stderr.write(`  - ${error.path || '(root)'}: ${error.message}\n`);
    }
    return 2;
  }

  let pr: PrInput;
  let ci: CiRunFacts;
  let state: RepairStateFacts;
  try {
    pr = JSON.parse(readFileSync(opts['pr'] as string, 'utf8')) as PrInput;
    ci = JSON.parse(readFileSync(opts['ci'] as string, 'utf8')) as CiRunFacts;
    state = JSON.parse(readFileSync(opts['state'] as string, 'utf8')) as RepairStateFacts;
  } catch (err) {
    process.stderr.write(`cannot parse inputs: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  const decision = evaluateRepairEligibility(configResult.config, {
    pr,
    repository: opts['repo'] as string,
    ci,
    state,
    expected_workflow_name: opts['expected-workflow'] as string,
  });

  console.log(JSON.stringify(decision, null, 2));

  const summaryFile = process.env['GITHUB_STEP_SUMMARY'];
  if (summaryFile) {
    appendFileSync(
      summaryFile,
      `### Repair eligibility: ${decision.eligible ? 'eligible' : decision.reason}\n\n${decision.details}\n`,
    );
  }

  return 0;
}

process.exit(main());
