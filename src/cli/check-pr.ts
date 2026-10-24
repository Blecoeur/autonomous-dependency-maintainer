#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { loadConfig } from '../config/load.js';
import { evaluatePr } from '../policy/eligibility.js';
import { DECISION_EXIT_CODES, type PrInput } from '../policy/pr.js';

/**
 * maintenance-check-pr — evaluates a pull request against the repository's
 * maintenance policy and prints a machine-readable decision.
 *
 * Inputs:
 *   maintenance-check-pr --config <.maintenance.yml> --pr <pr.json>
 *
 * `pr.json` must contain the PrInput fields (author, labels, files, ...),
 * collected from the GitHub API by the calling workflow. The engine never
 * holds a token. Exit code follows DECISION_EXIT_CODES: policy violations
 * exit 1 so the required check visibly blocks the PR; informational outcomes
 * (eligible, not-maintenance, needs-human) exit 0.
 */
function main(): number {
  const args = process.argv.slice(2);
  let configPath = '.maintenance.yml';
  let prPath = '';
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--config' && args[i + 1] !== undefined) {
      configPath = args[i + 1] as string;
      i++;
    } else if (arg === '--pr' && args[i + 1] !== undefined) {
      prPath = args[i + 1] as string;
      i++;
    } else {
      process.stderr.write(`unknown argument: ${arg}\nusage: maintenance-check-pr --config <file> --pr <file>\n`);
      return 2;
    }
  }
  if (!prPath) {
    process.stderr.write('usage: maintenance-check-pr --config <file> --pr <file>\n');
    return 2;
  }

  const configResult = loadConfig(readFileSync(configPath, 'utf8'));
  if (!configResult.ok) {
    process.stderr.write(`invalid config ${configPath}:\n`);
    for (const error of configResult.errors) {
      process.stderr.write(`  - ${error.path || '(root)'}: ${error.message}\n`);
    }
    return 2;
  }

  let pr: PrInput;
  try {
    pr = JSON.parse(readFileSync(prPath, 'utf8')) as PrInput;
  } catch (err) {
    process.stderr.write(`cannot parse PR input ${prPath}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  const decision = evaluatePr(configResult.config, pr);

  console.log(JSON.stringify(decision, null, 2));

  const summaryFile = process.env['GITHUB_STEP_SUMMARY'];
  if (summaryFile) {
    appendFileSync(
      summaryFile,
      [
        `### Maintenance policy: ${decision.decision}`,
        `Classification: ${decision.classification}`,
        '',
        ...decision.details.map((d) => `- ${d}`),
        decision.automerge ? '- Auto-merge: enabled' : '- Auto-merge: not enabled',
        '',
      ].join('\n'),
    );
  }

  return DECISION_EXIT_CODES[decision.decision];
}

process.exit(main());
