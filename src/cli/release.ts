#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { loadConfig } from '../config/load.js';
import { assembleReleasePlan, type ReleaseInputData } from '../release/plan.js';

/**
 * maintenance-release — computes the weekly release plan from merged-PR
 * evidence and prints it as JSON. The workflow decides whether to publish
 * (should_release) and stays idempotent by checking for an existing tag.
 *
 * Inputs:
 *   maintenance-release --config <.maintenance.yml> --data <release-data.json>
 */
function main(): number {
  const args = process.argv.slice(2);
  let configPath = '.maintenance.yml';
  let dataPath = '';
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--config' && args[i + 1] !== undefined) {
      configPath = args[i + 1] as string;
      i++;
    } else if (arg === '--data' && args[i + 1] !== undefined) {
      dataPath = args[i + 1] as string;
      i++;
    } else {
      process.stderr.write(`unknown argument: ${arg}\nusage: maintenance-release --config <file> --data <file>\n`);
      return 2;
    }
  }
  if (!dataPath) {
    process.stderr.write('usage: maintenance-release --config <file> --data <file>\n');
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

  let data: ReleaseInputData;
  try {
    data = JSON.parse(readFileSync(dataPath, 'utf8')) as ReleaseInputData;
  } catch (err) {
    process.stderr.write(`cannot parse release data ${dataPath}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  let plan;
  try {
    plan = assembleReleasePlan(configResult.config, data);
  } catch (err) {
    process.stderr.write(`cannot compute the release plan: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  console.log(JSON.stringify(plan, null, 2));

  const summaryFile = process.env['GITHUB_STEP_SUMMARY'];
  if (summaryFile) {
    writeFileSync(
      summaryFile,
      plan.should_release
        ? `### Maintenance release: ${plan.new_version}\n\n` +
            `- Previous tag: ${plan.previous_version ?? '(none)'}\n` +
            `- Includes AI-assisted changes: ${plan.includes_ai_assisted}\n` +
            `- Merged PRs: ${plan.classified_prs.map((p) => `#${p.number} (${p.kind})`).join(', ')}\n`
        : '### Maintenance release: none\n\nNo eligible merges since the last tag.\n',
    );
  }

  return 0;
}

process.exit(main());
