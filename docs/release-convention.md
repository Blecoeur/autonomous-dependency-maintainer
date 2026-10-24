# Release convention

> Phase 2 — implemented. The reusable workflow is
> `.github/workflows/release.yml`, the plan computation lives in
> `src/release/plan.ts` (CLI: `maintenance-release`), and the template wrapper
> is `templates/github-public-node-pnpm/maintenance-release.yml`.

## Versioning: `source-aware`

For the Keelflow demonstrator, the distribution version `X.Y.Z`:

- `X` is **fixed** for the current fork generation. Automated maintenance
  never produces a major bump.
- `Z` increases when the release contains **only** dependency updates
  without AI-assisted application changes.
- `Y` increases (and `Z` resets to 0) when the release contains **at least
  one AI-assisted application fix**.

This is deliberately **not SemVer**: the MINOR digit encodes provenance
(AI-assisted change included), not a new feature. Consumer READMEs must
display this warning prominently:

> **Experimental, automatically maintained distribution.** This project
> automatically updates dependencies and may use AI-generated compatibility
> fixes. All changes are checked by an automated CI pipeline, but passing
> tests do not guarantee functional compatibility, reliability, or
> security. There is no human review requirement for eligible automated
> updates. No warranty or support commitment is provided. Production users
> should pin versions, keep backups and independently validate releases.

Other repositories can select `release.versioning: semver` instead.

## Weekly cadence

- Dependabot works from Monday; the release job runs Sunday
  (`0 08 * * 0` UTC) so updates have the week to be validated.
- A release is created **only** when eligible maintenance PRs were merged
  since the last published tag (idempotence: rerunning the release job with
  no new merges must not create a new tag).
- Release jobs must be serialized (`concurrency` group) to avoid concurrent
  tag creation.
- The next version is computed from the **last published tag**, never from
  PR titles.

## Provenance

Each release ships a machine-readable provenance JSON (schema version 1)
containing, per merged PR: number, classification (`dependencies-only` /
`ai-assisted`), dependency names and versions, AI provider when applicable,
commit SHAs, workflow run references, and the framework version used. The
classification must be derived from verifiable GitHub evidence (author
identity, diff shape, check runs on the merged SHA), not from
manually-editable labels alone — the same evidence rules as the policy
engine.
