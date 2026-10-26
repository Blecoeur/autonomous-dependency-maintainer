# Repair worker (Python, Mistral Workflows)

The Phase 3 coding agent: it takes a framework `RepairRequest`, reproduces
the failing dependency update deterministically, asks a Mistral model for a
minimal compatibility fix, and returns a `RepairStatusReport` plus a patch.
The worker **never** holds GitHub write credentials — the trusted gateway
(framework side) validates the patch with the policy engine and opens the
replacement PR.

## Layout

```text
worker/
├── repair_worker/
│   ├── contracts.py     # RepairRequest / RepairStatusReport (schema 1, mirrors TS)
│   ├── patch_guard.py   # worker-side forbidden-path + manifest guard (defense in depth)
│   ├── sandbox.py       # clone at head SHA, apply update, run build/test, no secrets
│   ├── repairer.py      # the repair loop (spec 7.7 system prompt, attempt budget)
│   ├── mistral_client.py# lazy mistralai SDK adapter
│   └── handler.py       # entry point: request JSON in, status report out
└── tests/               # stdlib unittest; no provider dependencies needed
```

## Contract

Input: the framework's `RepairRequest` JSON (schema_version 1) on stdin or
in `$REPAIR_REQUEST_FILE`. The idempotency key must match the request
fields; mismatches are refused as `internal_error`.

Output: `RepairStatusReport` JSON on stdout — one of `pr_created`, `blocked`,
`not_reproducible`, `transient_failure`, `budget_exceeded`,
`stale_original_pr`, `internal_error`.

## Security posture (spec 7.9)

- `GITHUB_READ_TOKEN` (read-only) is the only GitHub credential; it is used
  for the clone and never exported to repository scripts.
- No Mistral key reaches the repository's build/test commands: the sandbox
  runs them with a minimal environment.
- `patch_guard` rejects any model-produced change to tests, CI workflows,
  `.maintenance.yml`, `CODEOWNERS`, or a weakened `package.json` `scripts`
  section — and reports `blocked`. This is the worker's own check; the
  authoritative validation happens in the framework gateway before any PR.
- Model answers that declare `BLOCKED` are honored: no patch is pushed.

## Testing

```bash
cd worker && python3 -m unittest discover -s tests -v
```

The deterministic parts (contracts, guard) are fully covered; the model loop
is testable with a stubbed `ModelClient`. The `mistralai` SDK surface used
by `mistral_client.py` must be re-verified against the current SDK at
deployment time.

## Deployment (Mistral managed, to verify before production)

- Deploy this directory as a Mistral Workflows worker
  (`repair_dependency_update`), Python 3.11+.
- Provide `MISTRAL_API_KEY` and a repo-scoped read-only `GITHUB_READ_TOKEN`
  as worker secrets.
- The framework calls `POST /v1/workflows/{name}/execute` with the request
  JSON (see `src/providers/repair/mistral/adapter.ts`); execution states map
  onto the framework's status vocabulary.
- Container isolation and network policy are the deployment's
  responsibility: the worker assumes it runs untrusted repository code in
  an isolated environment.
