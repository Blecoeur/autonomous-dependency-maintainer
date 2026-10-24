#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { loadConfig } from '../config/load.js';

/**
 * maintenance-validate-config — validates a `.maintenance.yml` file.
 * Exit 0 when the file is valid, exit 1 with a report otherwise.
 */
function main(): number {
  const args = process.argv.slice(2);
  const path = args[0];
  if (!path || args.length !== 1) {
    process.stderr.write('usage: maintenance-validate-config <path-to-.maintenance.yml>\n');
    return 2;
  }

  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    process.stderr.write(`cannot read ${path}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  const result = loadConfig(text);
  if (result.ok) {
    const { config } = result;
    console.log(`OK: ${config.project.name} (ecosystem: ${config.project.ecosystem}, base: ${config.project.base_branch})`);
    console.log(`updates: schedule=${config.updates.schedule} cooldown=${config.updates.cooldown_days}d grouping=${config.updates.grouping} max_open_prs=${config.updates.max_open_prs}`);
    console.log(`merge: mode=${config.merge.mode} strategy=${config.merge.strategy} allowed_authors=${config.merge.allowed_authors.join(',')}`);
    console.log(`repair: provider=${config.repair.provider} enabled=${config.repair.enabled} max_attempts=${config.repair.max_attempts}`);
    return 0;
  }

  console.error(`invalid config: ${path}`);
  for (const error of result.errors) {
    console.error(`  - ${error.path || '(root)'}: ${error.message}`);
  }
  return 1;
}

process.exit(main());
