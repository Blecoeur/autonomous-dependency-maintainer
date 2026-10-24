# Policy reference

## `.maintenance.yml`

Schema version 1. Missing keys fall back to restrictive defaults; unknown
keys and wrong types are hard errors (validated by
`maintenance-validate-config`).

### project

| key | type | default | notes |
|---|---|---|---|
| `name` | string | required | repository/project name |
| `ecosystem` | `node-pnpm` | `node-pnpm` | only ecosystem in Phase 1 |
| `base_branch` | string | `main` | protected target branch |

### updates

| key | type | default |
|---|---|---|
| `schedule` | `weekly` | `weekly` |
| `cooldown_days` | int 0–90 | `3` |
| `max_open_prs` | int 1–100 | `20` |
| `grouping` | `individual` \| `groups` | `individual` |
| `allow_minor` | bool | `true` |
| `allow_patch` | bool | `true` |
| `major.default` | `defer` \| `allow` | `defer` |
| `major.enable_maintenance_audit` | bool | `true` |
| `major.migrate_if_eol_verified` | bool | `false` |
| `major.migrate_if_security_unpatched` | bool | `true` |

The Dependabot side of these values lives in `.github/dependabot.yml`
(schedule, cooldown, `open-pull-requests-limit`, `ignore` of semver-major).
`.maintenance.yml` mirrors the policy for the decision engine; keep the two
files consistent.

### validation

| key | type | default |
|---|---|---|
| `install` | string | `pnpm install --frozen-lockfile` |
| `build` | string \| null | `pnpm build` |
| `typecheck` | string \| null | `null` |
| `test` | string \| null | `pnpm test` |
| `smoke` | string \| null | `null` |
| `required_checks` | string[] (non-empty) | `["dependency-ci", "maintenance-policy"]` |

At least one of `test` / `smoke` must be set. `required_checks` is
documentation + future automation of the branch-protection setup; the
enforcement itself lives in GitHub settings.

### repair

| key | type | default |
|---|---|---|
| `provider` | `mistral-workflows` \| `none` \| `mock` | `mistral-workflows` |
| `enabled` | bool | `true` |
| `max_attempts` | int 1–10 | `3` |
| `max_parallel_per_repo` | int 1–10 | `1` |
| `max_changed_application_files` | int 1–100 | `10` |
| `preserve_public_api` | bool | `true` |
| `forbidden_paths` | string[] (non-empty) | see below |
| `allowed_ai_paths` | string[] | `[]` |

Default forbidden paths: `.github/**`, `.maintenance.yml`, `CODEOWNERS`,
`**/*.test.*`, `**/*.spec.*`, `**/__tests__/**`, `**/__snapshots__/**`,
`**/*.snap`. Extend, never shrink.

`allowed_ai_paths` is intentionally empty by default: until a repository has
reviewed which application surfaces an AI repair may touch, all
application-code repairs are rejected.

### merge

| key | type | default |
|---|---|---|
| `mode` | `github-auto-merge` | `github-auto-merge` |
| `strategy` | `squash` \| `merge` \| `rebase` | `squash` |
| `allowed_authors` | string[] (non-empty) | `["dependabot[bot]"]` |
| `ai_authors` | string[] | `[]` |

### release

| key | type | default |
|---|---|---|
| `schedule` | string | `weekly-sunday` |
| `versioning` | `source-aware` \| `semver` | `source-aware` |
| `initial_major` | int 0–99 | `3` |
| `publish_github_release` | bool | `true` |
| `publish_ghcr` | bool | `false` |

`source-aware` convention: PATCH when the release contains only dependency
updates; MINOR when at least one AI-assisted application fix is included;
MAJOR never moves. This is deliberately not SemVer and must be documented
in consumer READMEs.

## Decision rules

Evaluation order (first failure wins):

1. **Base branch mismatch** → `not-maintenance` (`wrong-base-branch`).
2. **Author not in `allowed_authors` ∪ `ai_authors`** → `not-maintenance`
   (`author-not-authorized`). Labels are never consulted for identity.
3. **Forbidden path touched** → `rejected` (`forbidden-path-changed`).
4. **Protected manifest section changed** (any `package.json` snapshot shows
   a diff on `scripts`, `lint-staged`, `husky`, `simple-git-hooks`,
   `pre-commit`; or a manifest was added/removed) → `rejected`
   (`protected-manifest-section-changed`).
5. **Dependency-bot circuit** (`allowed_authors`):
   - a changed file outside manifest/lockfile patterns → `rejected`
     (`unexpected-file-changes`);
   - no parsable dependency movement → `needs-human`
     (`update-type-unverified`);
   - major, not a security update → `needs-human` (`major-deferred`);
   - major security update → `needs-human`
     (`major-requires-policy-authorization`);
   - minor/patch while `allow_minor`/`allow_patch` is false → `needs-human`
     (`update-type-not-allowed`);
   - otherwise → **`eligible`**, classification `dependencies-only`.
6. **AI circuit** (`ai_authors`):
   - `repair.enabled` false → `needs-human` (`ai-repair-disabled`);
   - missing `ai-assisted` label → `needs-human` (`missing-ai-label`);
   - major in the repaired update → `needs-human`
     (`major-requires-policy-authorization`);
   - more than `max_changed_application_files` application files →
     `rejected` (`too-many-application-files`);
   - application file outside `allowed_ai_paths` (or no surface declared) →
     `rejected` (`ai-path-not-allowed`);
   - otherwise → **`eligible`**, classification `ai-assisted`.

Exit codes of `maintenance-check-pr`: `rejected` → 1 (fails the required
check); every other decision → 0.
