# Repair worker (Python, Mistral Workflows)

The Phase 3 coding agent, implemented as a **Mistral Workflows worker**:
the repair runs as the `repair_dependency_update` workflow, orchestrated
durably by the Mistral platform, executed by this worker process. The
worker takes a framework `RepairRequest`, reproduces the failing dependency
update deterministically, repairs it with an agentic model loop, and
returns a `RepairStatusReport` plus a patch. The worker **never** holds
GitHub write credentials — the trusted gateway (framework side) validates
the patch with the policy engine and opens the replacement PR.

## Layout (Mistral Workflows src-layout project)

```text
worker/
├── pyproject.toml                # src layout; mistralai + pydantic
├── src/
│   ├── workflows/
│   │   └── repair_dependency_update.py  # @workflows.workflow.define + activity
│   ├── entrypoints/
│   │   └── worker.py             # run_worker([RepairDependencyUpdateWorkflow])
│   └── repair_worker/
│       ├── contracts.py          # pydantic RepairRequest/StatusReport (schema 1)
│       ├── patch_guard.py        # worker-side forbidden-path + manifest guard
│       ├── sandbox.py            # clone at head SHA, apply update, run commands
│       ├── repairer.py           # the agentic tool loop (harness)
│       ├── mistral_client.py     # tool-calling chat adapter (mistralai SDK)
│       └── skills/dependency_repair/SKILL.md   # the repair doctrine (system prompt)
└── tests/                        # stdlib unittest; pydantic only, no SDK needed
```

One workflow, one activity — on purpose: activities may run on any worker
of the deployment, and the sandbox is a worker-local filesystem, so the
entire repair executes as a single activity; platform retries resume it
as a unit.

## The agentic repair loop

Inside the activity, the repair is an **agent loop with a bounded tool
set** — not a one-shot "log in, fix out" call. The model explores the
repository and iterates:

| tool | what it does |
|---|---|
| `read_file` / `list_files` | explore (sizes and entry counts capped) |
| `apply_edits` | exact in-place text replacements — every edit passes the patch guard **before** touching disk; manifest edits are checked for protected-section drift |
| `run_verification` | runs the consumer's configured build/test commands (carried in the `RepairRequest`, never arbitrary shell) |
| `finish` | end the repair (`pr_created` / `blocked`) |

Robustness lives in the harness, not the model:

- `finish(pr_created)` is only accepted after the harness itself re-runs
  the verification — the model's claim of success is never trusted.
- Rounds are budgeted (`max_attempts * 5` tool rounds), changed-file counts
  are capped by policy, and tool errors become model feedback.
- The **skill** — the repair doctrine injected as the system prompt — lives
  in `src/repair_worker/skills/dependency_repair/SKILL.md`: a reviewable
  artifact you can iterate without touching code. It encodes the spec 7.7
  rules (minimal fix, never tests/CI/policy, honest `blocked`).
- Verification commands come from the consumer's `.maintenance.yml` via the
  request (`commands.install/build/test`), so the worker is not hardcoded
  to pnpm/Node: the sandbox's dependency-apply step is npm-specific for now
  (ecosystem adapters are the spec's Phase 5).

The loop is fully testable without the Mistral SDK:
`tests/test_agent_repairer.py` drives it with a scripted model and a fake
sandbox (happy path, forbidden edit, manifest weakening, premature success
claim, budget exhaustion, command sourcing).

## Running the worker

```bash
cd worker
uv sync                          # or: pip install -r requirements.txt
MISTRAL_API_KEY=... \
DEPLOYMENT_NAME=autonomous-maintenance \
GITHUB_READ_TOKEN=... \
  uv run python src/entrypoints/worker.py
```

- `MISTRAL_API_KEY` selects the workspace; workers sharing a
  `DEPLOYMENT_NAME` form the interchangeable worker group.
- `GITHUB_READ_TOKEN` is READ-ONLY, used only for the sandbox clone and
  never exported to the repository's build/test commands.
- The workflow appears in Studio after registration and can be triggered
  from the Console, the Python SDK, or the API.

## Contract

Input: the framework's `RepairRequest` JSON (schema 1). The pydantic model
refuses: wrong schema version, non-`failure` CI conclusions, any request
claiming test/CI changes are allowed, a missing test command, and
idempotency keys that do not match the request fields.

Output: `RepairStatusReport` — `pr_created`, `blocked`,
`not_reproducible`, `transient_failure`, `budget_exceeded`,
`stale_original_pr`, `internal_error`.

## Security posture (spec 7.9)

- Read-only GitHub token only; no write credentials in the worker.
- Model answers declaring `BLOCKED` are honored; no patch is produced.
- `patch_guard` rejects changes to tests, CI workflows, `.maintenance.yml`,
  `CODEOWNERS` or weakened `package.json` scripts → `blocked`. Defense in
  depth only — the authoritative validation is the framework gateway.
- Build/test commands run in a scrubbed environment (no Mistral/GitHub
  secrets); container isolation and network policy are the deployment's
  responsibility.

## Testing

```bash
cd worker && python3 -m unittest discover -s tests -v
```

The deterministic parts (contracts, guard, agent harness) are covered by
stdlib unittest (pydantic required; the Mistral SDK is not). The workflow
module requires the `mistralai` package and is exercised by the deployment
smoke test below.

## Deploy checklist

1. Verify the SDK surface (`mistralai.workflows`, `run_worker`,
   `@workflows.activity`, chat tool-calling) against the current docs.
2. `uv sync` and start the worker with `DEPLOYMENT_NAME`.
3. Smoke: trigger the workflow from Studio with a sample `RepairRequest`;
   confirm the execution timeline shows the activity and the report.
4. Framework side: `maintenance-repair-submit` calls the Workflows API to
   start executions; verify that endpoint shape against the API reference.
