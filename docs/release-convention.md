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
- A release is created **only** when merges not yet covered by the last
  published tag exist. "New" is decided by **merge-SHA ancestry** (the
  workflow compares the base branch against the tag and passes the
  not-yet-tagged merge SHAs to the CLI), never by timestamp comparison:
  the tagged commit's date can precede the `mergedAt` of the last merged
  PR, which would re-count an already released PR on every rerun and
  publish empty releases. Idempotence: rerunning the release job with no
  new merges must not create a new tag.
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
