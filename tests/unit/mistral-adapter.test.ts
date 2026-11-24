import { describe, expect, it } from 'vitest';
import {
  MistralAgentRepairProvider,
  parseClientOutput,
} from '../../src/providers/repair/mistral/adapter.js';
import type { RepairRequest } from '../../src/providers/repair/types.js';

function makeRequest(overrides?: Partial<RepairRequest>): RepairRequest {
  return {
    schema_version: '1',
    idempotency_key: 'owner/repo#10@abcdef123:repair-v1',
    repository: 'owner/repo',
    base_branch: 'main',
    original_pr_number: 10,
    original_head_sha: 'abcdef123',
    dependency_updates: [
      { name: 'multer', from_version: '2.4.0', to_version: '2.5.0', update_type: 'minor' },
    ],
    commands: { install: 'pnpm install --frozen-lockfile', build: 'pnpm build', test: 'pnpm test' },
    ci: { run_id: 456, workflow_name: 'CI', conclusion: 'failure' },
    policy: {
      max_attempts: 3,
      allow_test_changes: false,
      allow_ci_changes: false,
      preserve_public_api: true,
      max_changed_application_files: 10,
    },
    ...overrides,
  };
}

describe('MistralAgentRepairProvider', () => {
  it('is constructible with agent name, client path and api key', () => {
    const provider = new MistralAgentRepairProvider({
      apiKey: 'test-key',
      agentName: 'repair-dependency-update',
      clientPath: '/nonexistent/client.py',
    });
    expect(provider).toBeDefined();
    // status of an unknown session reports in_progress, never a silent pass
    return expect(provider.status('unknown-session')).resolves.toMatchObject({ status: 'in_progress' });
  });
});

describe('parseClientOutput', () => {
  it('parses a completed session output into the framework vocabulary', () => {
    const out = parseClientOutput(
      JSON.stringify({
        session_id: '01a1a89e-c09f-7043-85a7-af2170ff112d',
        turn_id: 'turn-1',
        report: { status: 'pr_created', replacement_pr_number: 42, attempt_count: 1 },
      }),
    );
    expect(out.session_id).toBe('01a1a89e-c09f-7043-85a7-af2170ff112d');
    expect(out.report.status).toBe('pr_created');
    expect(out.report.replacement_pr_number).toBe(42);
  });

  it('maps a busy session to in_progress', () => {
    const out = parseClientOutput(
      JSON.stringify({ session_id: 's1', report: { status: 'in_progress' } }),
    );
    expect(out.report.status).toBe('in_progress');
  });

  it('maps an unknown agent outcome to internal_error (never silently passes)', () => {
    const out = parseClientOutput(
      JSON.stringify({ session_id: 's1', report: { status: 'merged_by_llm' } }),
    );
    expect(out.report.status).toBe('internal_error');
  });

  it('throws when the output lacks session_id or report', () => {
    expect(() => parseClientOutput(JSON.stringify({}))).toThrow('session_id');
    expect(() => parseClientOutput(JSON.stringify({ session_id: 's1' }))).toThrow('report');
  });
});
