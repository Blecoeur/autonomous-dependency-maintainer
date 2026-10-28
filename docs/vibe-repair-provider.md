# AI repair provider: Mistral vibe (CLI on the runner)

> Phase 3 — implemented in code, not yet deployed. The contracts live in
> `src/providers/repair/types.ts`; the provider is
> `src/providers/repair/vibe/provider.ts`; the deterministic guards are
> `src/policy/repair-eligibility.ts` (CLI: `maintenance-repair-request`); the
> patch validator is `src/providers/repair/patch-validation.ts`; the repair
> doctrine is `src/providers/repair/skill/dependency-repair.md`. The vibe CLI
> surface used here follows the mistral-vibe 3.0.x documentation and source
> and must be re-verified at deployment time.

## Role

The vibe CLI is used **only** for CI-red dependency PRs that need a
compatibility repair. It is never used to check GitHub statuses, to decide
merges, or to publish releases: those stay deterministic and GitHub-native.

## Interface

```ts
interface RepairProvider {
  run(request: RepairRequest): Promise<RepairStatusReport>;
}
```

The framework owns the request/response schemas (`schema_version: "1"`);
the provider is the single place that translates them to the vibe CLI.

## Execution model

One GitHub Actions job (`repair` in `.github/workflows/repair-request.yml`)
runs one repair attempt, synchronously, on the runner:

1. **Clone** the PR head at the exact head SHA with a read-only token
   (`GITHUB_READ_TOKEN`, passed via an HTTP extra header, never in the URL).
2. **Apply** the dependency update to `package.json`, Dependabot-style
   (preserving the `^`/`~` range prefix), and run the configured install
   command in a scrubbed environment.
3. **Reproduce**: run the configured build/test commands. If they pass, the
   report is `not_reproducible` and no agent runs.
4. **Repair**: run `vibe --prompt-file ... --output json --output-dir ...`
   pinned by version (`uv tool run --from mistral-vibe==<version>`), in an
   isolated `VIBE_HOME` (see below), with:
   - `--max-turns` / `--time-limit` bounding the run;
   - `--enabled-tools read_file,grep,edit,write_file,bash` and a denylist of
     `task`, `todo`, `ask_user_question`, `web_fetch`, `web_search`, `skill`;
   - `--trust` only for the framework-generated `VIBE_HOME` (the PR's own
     `.vibe/` directory is never loaded — headless runs start untrusted and
     the project config layer stays empty);
   - the repair doctrine as `system_prompt_id`, loaded from the framework's
     copy in `VIBE_HOME/prompts/`;
   - `outside_workdir = "deny"` and a `[tools.bash]` allowlist of
     `git`/`pnpm`/`npm`/`node` plus the configured command names, so shell
     execution stays within the workspace and the trusted command set.
5. **Re-verify**: the harness re-runs the build/test commands itself. The
   agent's claim of success is never trusted.
6. **Validate**: `validatePatch` re-evaluates the diff against the policy
   engine — forbidden paths, protected manifest sections, the allowed AI
   surface, the file budget.
7. **Report**: `pr_created` with the validated unified diff (uploaded as a
   job artifact for the gateway), `blocked`, `not_reproducible`,
   `transient_failure`, `budget_exceeded` or `internal_error`.

The agent never receives GitHub or Mistral credentials beyond the
`MISTRAL_API_KEY` the vibe process itself needs; repository commands run
with an environment scrubbed to `PATH`/`HOME`/`LANG`/`TMPDIR`/`CI`
(`src/providers/repair/vibe/sandbox.ts`), so PR-controlled install scripts
cannot exfiltrate secrets. The privileged gateway validates the patch with
the policy engine (again) and opens a replacement PR authored by a GitHub
App with the `ai-assisted` label. The replacement PR goes through the full
CI from scratch and is eligible for the same native auto-merge — the
engine's `ai-assisted` circuit is already implemented and unit-tested.

## Input contract (framework-owned)

```json
{
  "schema_version": "1",
  "idempotency_key": "owner/repo#123@abcdef...:repair-v1",
  "repository": "owner/keelflow-auto-maintained",
  "base_branch": "main",
  "original_pr_number": 123,
  "original_head_sha": "abcdef...",
  "dependency_updates": [
    { "name": "example-package", "from_version": "2.3.1", "to_version": "2.4.0", "update_type": "minor" }
  ],
  "ci": { "run_id": 456789, "conclusion": "failure" },
  "policy": {
    "max_attempts": 3,
    "allow_test_changes": false,
    "allow_ci_changes": false,
    "preserve_public_api": true,
    "max_changed_application_files": 10
  }
}
```

The idempotency key is `(repository, pr_number, head_sha, strategy_version)`.
Duplicated events and retries must map to the same logical repair.

## Output contract (framework-owned)

Allowed statuses: `pr_created`, `blocked`, `not_reproducible`,
`transient_failure`, `budget_exceeded`, `stale_original_pr`,
`internal_error`.

On `pr_created` the report carries `patch` (a unified diff) and
`changed_application_files`. The patch is applied by the privileged gateway,
never pushed by the agent.

## Repair doctrine (contractual, per the spec)

Lives in `src/providers/repair/skill/dependency-repair.md` — a reviewable
artifact, loaded as vibe's system prompt via `system_prompt_id`:

> You are a dependency-compatibility repair agent, not a feature developer.
> Modify only what is necessary to make the application compatible with the
> provided dependency update. Preserve existing behavior and public APIs.
> Never modify tests, snapshots, CI workflows, test configuration,
> quality/security rules, release files or policy files. Never delete a test
> or work around a validation. Never propose opportunistic refactors or new
> features. Document the changed files and the precise technical cause. If
> the fix requires a breaking change, a data migration, a policy change or
> disabling tests, report **BLOCKED** instead of pushing a misleading patch.

The prompt is a convenience; enforcement is external (policy engine +
independent re-verification), never prompt-only.

## Environment variables

| variable | role |
|---|---|
| `MISTRAL_API_KEY` | vibe's model credential; never exported to repository commands |
| `GITHUB_READ_TOKEN` | read-only clone token for the PR head; passed via git `http.extraheader` |
| `REPAIR_VIBE_VERSION` | pinned mistral-vibe version (default `3.0.3`) |
| `REPAIR_MODEL_NAME` | model override (default: vibe's unpinned default, currently `mistral-medium-3.5`) |
| `REPAIR_PATCH_FILE` | where `maintenance-repair-run` writes the validated patch |
