# Mistral Workflows adapter

> Phase 3 — specified, not yet implemented. Do not treat the JSON contracts
> below as validated APIs; they are framework-owned contracts to be wired to
> the Mistral Workflows SDK at implementation time, after re-reading the
> current Mistral documentation (managed deployments were in public preview
> as of October 2026).

## Role

Mistral Workflows is used **only** for CI-red dependency PRs that need a
compatibility repair. It is never used to check GitHub statuses, to decide
merges, or to publish releases: those stay deterministic and GitHub-native.

## Interface

```ts
interface RepairProvider {
  submit(request: RepairRequest): Promise<RepairExecution>;
  status(executionId: string): Promise<RepairStatus>;
}
```

The framework owns the request/response schemas (`schema_version: "1"`);
the adapter translates them to the Mistral SDK.

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

The agent produces a **patch**; it never receives GitHub or Mistral
credentials. The privileged gateway validates the patch with the policy
engine (forbidden paths, manifest guard, allowed AI surface, file budget)
and opens a replacement PR authored by a GitHub App with the `ai-assisted`
label. The replacement PR goes through the full CI from scratch and is
eligible for the same native auto-merge — the engine's `ai-assisted` circuit
is already implemented and unit-tested.

## System prompt (contractual, per the spec)

> You are a dependency-compatibility repair agent, not a feature developer.
> Modify only what is necessary to make the application compatible with the
> provided dependency update. Preserve existing behavior and public APIs.
> Never modify tests, snapshots, CI workflows, test configuration,
> quality/security rules, release files or policy files. Never delete a test
> or work around a validation. Never propose opportunistic refactors or new
> features. Document the changed files and the precise technical cause. If
> the fix requires a breaking change, a data migration, a policy change or
> disabling tests, report **blocked** instead of pushing a misleading patch.

The prompt is a convenience; enforcement is external (policy engine +
independent CI), never prompt-only.
