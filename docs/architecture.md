# Architecture

## Components

```
src/
├── config/            .maintenance.yml loading, strict validation, defaults
├── policy/            the decision core (pure functions, no I/O)
│   ├── semver.ts      version parsing, update classification, release bumping
│   ├── paths.ts       glob matching over changed file paths
│   ├── dependabot.ts  PR title parsing (dependency movements)
│   ├── manifests.ts   protected-section comparison of package.json snapshots
│   ├── eligibility.ts the PR decision function
│   └── pr.ts          input/output contracts of the decision
├── providers/
│   └── ecosystem-node-pnpm/   ecosystem adapter (allowed dependency files)
└── cli/               validate-config, check-pr
```

## Decision flow

```
GitHub event
   │
   ▼
Consumer wrapper (.github/workflows/maintenance-ci.yml)
   │  uses
   ▼
policy-check.yml (required check, framework repo)
   ├─ checkout consumer repo @ base branch        → trusted .maintenance.yml
   ├─ checkout framework @ pinned ref             → decision engine
   ├─ gh pr view / gh api                          → PR facts JSON
   │    (author, labels, files, head SHA, package.json base/head snapshots)
   ├─ node dist/cli/check-pr.js                    → PolicyDecision
   └─ exit code: rejected → 1 (blocks), otherwise 0
```

The `PolicyDecision` is one of:

| decision | meaning | auto-merge | check |
|---|---|---|---|
| `eligible` | authorized maintenance PR, policy-clean | enabled | pass |
| `not-maintenance` | external/human PR — out of scope | not enabled | pass |
| `needs-human` | recognizable maintenance PR that must not auto-merge (deferred major, unverified update type, disabled circuit) | not enabled | pass |
| `rejected` | policy violation (protected path, weakened tests, unexpected files, AI outside its allowed surface) | not enabled | **fail** |

`needs-human` PRs stay green but never auto-merge: humans keep full control
over every decision the framework cannot guarantee. `rejected` PRs fail the
required check and remain visibly blocked.

## Auto-merge is not the authorization

`auto-merge.yml` only verifies provenance (author login from the event
payload, base branch) and calls `gh pr merge --auto`. The merge happens when
GitHub's branch protection is satisfied: required checks
(`maintenance-policy` included) green on the current head. This keeps a
single source of truth (GitHub rules) and avoids duplicating the deep policy
in a privileged job.

## Idempotence

- Auto-merge enablement is idempotent; duplicated `pull_request_target`
  events are harmless.
- The decision engine is a pure function: replays produce identical
  decisions.
- Release workflow (Phase 2) will key on the last published tag, not on PR
  titles.

## Future circuits

Phase 2 (release) and Phase 3 (AI repair) plug in without touching the Phase 1
core:

- `ReleaseProvider` consumes merged PRs since the last tag, classifies them
  (`dependencies-only` / `ai-assisted`) from GitHub evidence, bumps the
  version, and emits a provenance JSON next to each GitHub Release.
- `RepairProvider` receives a structured request (idempotency key =
  `repo#pr@sha:strategy-version`) and runs one repair attempt to completion:
  the Phase 3 implementation runs the Mistral vibe CLI on the GitHub Actions
  runner, re-verifies the result and returns a validated patch; a
  privileged gateway opens a replacement PR; the same policy engine
  evaluates it with the `ai-assisted` circuit.
