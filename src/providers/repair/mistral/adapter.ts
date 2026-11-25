import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RepairExecution, RepairRequest, RepairStatusReport } from '../types.js';
import type { RepairProvider } from '../provider.js';

export interface MistralAgentAdapterOptions {
  /** Mistral API key. In CI this comes from a secret, never from PR content. */
  apiKey: string;
  /** Deployed agent name, e.g. 'repair-dependency-update'. */
  agentName: string;
  /**
   * Path to the framework's thin Session-API client (agent/client.py).
   * The runner executes ONLY this client — the agent itself runs
   * Mistral-managed (agents deploy), in the session's MistralSandbox.
   */
  clientPath: string;
  /** Python launcher prefix, e.g. ['uvx', '--python', '3.12', '--from', 'mistralai-agents', 'python']. */
  pythonLauncher?: string[];
  baseUrl?: string;
}

interface ClientOutput {
  session_id: string;
  turn_id?: string;
  report: RepairStatusReport;
}

/**
 * Provider for a Mistral Studio MANAGED AGENT (Agents SDK, "agents deploy"),
 * driven through the Session API by a thin Python client (agent/client.py):
 *
 *   agent = agents.Agent.load_from(agent_name=...)
 *   session = await agent.start_session(idempotency_key=request.idempotency_key)
 *   state = await session.run(json.dumps(request), idempotency_key=key + ':turn')
 *
 * The session idempotency key is the framework's idempotency key, so
 * duplicated GitHub events and CI retries return the SAME session and turn
 * server-side — replays never start a duplicate repair. `status()` re-binds
 * the stored session by id and replays the same turn key to read the record.
 *
 * The API shapes follow the Mistral Agents SDK documentation (public
 * preview) and MUST be re-verified at deploy time; this adapter (via the
 * client) is the single translation point.
 */
export class MistralAgentRepairProvider implements RepairProvider {
  private readonly reports = new Map<string, RepairStatusReport>();
  private readonly requests = new Map<string, RepairRequest>();

  constructor(private readonly options: MistralAgentAdapterOptions) {}

  async submit(request: RepairRequest): Promise<RepairExecution> {
    const output = await this.client('run', request);
    this.reports.set(output.session_id, output.report);
    this.requests.set(output.session_id, request);
    return {
      provider: 'mistral-agent',
      execution_id: output.session_id,
      idempotency_key: request.idempotency_key,
    };
  }

  async status(executionId: string): Promise<RepairStatusReport> {
    const cached = this.reports.get(executionId);
    if (cached) {
      return cached;
    }
    const request = this.requests.get(executionId);
    if (!request) {
      return { status: 'in_progress', reason: `unknown session ${executionId} in this process` };
    }
    const output = await this.client('status', request, executionId);
    if (output.report.status !== 'in_progress') {
      this.reports.set(executionId, output.report);
    }
    return output.report;
  }

  private client(mode: 'run' | 'status', request: RepairRequest, sessionId?: string): Promise<ClientOutput> {
    const dir = mkdtempSync(join(tmpdir(), 'repair-request-'));
    const requestPath = join(dir, 'request.json');
    writeFileSync(requestPath, JSON.stringify(request));

    const launcher = this.options.pythonLauncher ?? [
      'uvx', '--python', '3.12', '--from', 'mistralai-agents', 'python',
    ];
    const args = [...launcher, this.options.clientPath, mode, requestPath, ...(sessionId ? [sessionId] : [])];

    return new Promise((resolve, reject) => {
      const child = spawn(args[0] as string, args.slice(1), {
        env: {
          ...process.env,
          MISTRAL_API_KEY: this.options.apiKey,
          REPAIR_AGENT_NAME: this.options.agentName,
          ...(this.options.baseUrl ? { MISTRAL_API_URL: this.options.baseUrl } : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`repair agent client exited ${code}: ${stderr.slice(0, 500)}`));
          return;
        }
        try {
          resolve(parseClientOutput(stdout));
        } catch (err) {
          reject(err);
        }
      });
    });
  }
}

/** Parses the client's stdout JSON into the framework vocabulary. */
export function parseClientOutput(stdout: string): ClientOutput {
  const raw = JSON.parse(stdout) as Partial<ClientOutput>;
  if (!raw.session_id || !raw.report) {
    throw new Error('repair agent client output missing session_id or report');
  }
  return {
    session_id: raw.session_id,
    turn_id: raw.turn_id,
    report: normalizeReport(raw.report),
  };
}

function normalizeReport(report: Partial<RepairStatusReport>): RepairStatusReport {
  const allowed: RepairStatusReport['status'][] = [
    'pr_created',
    'blocked',
    'not_reproducible',
    'transient_failure',
    'budget_exceeded',
    'stale_original_pr',
    'internal_error',
    'in_progress',
  ];
  const status = allowed.includes(report.status as RepairStatusReport['status'])
    ? (report.status as RepairStatusReport['status'])
    : 'internal_error';
  return { ...report, status };
}
