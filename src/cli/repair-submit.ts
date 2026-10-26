#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { MistralWorkflowsRepairProvider } from '../providers/repair/mistral/adapter.js';
import type { RepairRequest } from '../providers/repair/types.js';

/**
 * maintenance-repair-submit — submits a validated RepairRequest to the
 * Mistral Workflows provider and prints the execution JSON.
 *
 * Reads the request from a file; credentials come exclusively from the
 * environment (CI secrets): MISTRAL_API_KEY, optional MISTRAL_WORKFLOW_NAME
 * (default: repair_dependency_update) and MISTRAL_API_URL.
 *
 * Idempotence: replays of the same idempotency key map to the same
 * execution on the provider side (see adapter).
 */
async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !args[0]) {
    process.stderr.write('usage: maintenance-repair-submit <request.json>\n');
    return 2;
  }

  const apiKey = process.env['MISTRAL_API_KEY'];
  if (!apiKey) {
    process.stderr.write('MISTRAL_API_KEY is not set; cannot submit the repair.\n');
    return 2;
  }

  let request: RepairRequest;
  try {
    request = JSON.parse(readFileSync(args[0] as string, 'utf8')) as RepairRequest;
  } catch (err) {
    process.stderr.write(`cannot parse repair request: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  const provider = new MistralWorkflowsRepairProvider({
    apiKey,
    workflowName: process.env['MISTRAL_WORKFLOW_NAME'] ?? 'repair_dependency_update',
    baseUrl: process.env['MISTRAL_API_URL'],
  });

  try {
    const execution = await provider.submit(request);
    console.log(JSON.stringify(execution, null, 2));
    return 0;
  } catch (err) {
    process.stderr.write(`submit failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

process.exit(await main());
