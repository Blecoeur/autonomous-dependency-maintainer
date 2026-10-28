# Onboarding a repository (GitHub Free, public repo)

## 1. Install the framework files

Copy from `templates/github-public-node-pnpm/`:

| template | destination |
|---|---|
| `.maintenance.yml` | `.maintenance.yml` |
| `dependabot.yml` | `.github/dependabot.yml` |
| `maintenance-ci.yml` | `.github/workflows/maintenance-ci.yml` |
| `maintenance-auto-merge.yml` | `.github/workflows/maintenance-auto-merge.yml` |
| `maintenance-release.yml` | `.github/workflows/maintenance-release.yml` |

The templates are pre-filled with the deployed framework
(`Blecoeur/autonomous-dependency-maintainer`) pinned at `v0.1.0`. When
upgrading the framework, change the pin deliberately — an immutable tag or
full commit SHA, never `main`.

## 2. Adapt the configuration

- `.maintenance.yml`: real build/test commands, required check names,
  forbidden paths, allowed AI paths (leave empty until the AI circuit is
  reviewed).
- `.github/dependabot.yml`: for a pnpm monorepo, verify that the root
  directory covers every workspace manifest, or add `directories:` entries.
- Validate locally:

```bash
node dist/cli/validate-config.js path/to/.maintenance.yml
```

## 3. GitHub settings (manual for now; automation is Phase 5)

Repository settings:

1. **Dependabot**: enable *version updates* (the config file above), and
   enable *security alerts* + *automated security updates*. On a fork this
   requires explicit action in the fork's settings — parent settings are not
   inherited.
2. **Allow auto-merge**: Settings → General → Pull Requests → *Allow
   auto-merge*.
3. **Branch protection on `main`** (or rulesets):
   - require a pull request before merging;
   - require status checks: the repository's own build/test checks **plus**
     the policy check. Note the exact name of a check produced by a
     reusable workflow is `<caller-job> / <called-job>` (e.g.
     `maintenance-policy / maintenance-policy`) — read the real names from
     the first green run, not from the workflow file;
   - do not allow bypassing for any actor;
   - require the branches to be up to date before merging (the framework
     relies on fresh CI against the current base).

## 4. Prove the circuit (definition of done for Phase 1)

1. Open a test PR that bumps a dev dependency by a patch version
   (authored by Dependabot, or by a bot account you list in
   `allowed_authors` for the test).
2. Confirm `maintenance-policy` reports `eligible` in its step summary.
3. Confirm the auto-merge workflow enabled native auto-merge.
4. Confirm GitHub merged the PR only after the required checks passed.
5. Then revert the test author from `allowed_authors` if it was a temporary
   one.

## Keelflow demonstrator specifics (Phase 0 baseline, to verify with the user)

The Keelflow source (github.com/Perruer/keelflow, Apache-2.0, TypeScript,
pnpm + turbo monorepo, active as of 2026-10-24) builds with
`turbo run build` and tests with `turbo run test`. Before onboarding:

- audit what `turbo run test` actually executes per package (an empty or
  skipping test script must not pass as "tested");
- check `pnpm install --frozen-lockfile` reproduces on a clean runner
  (note: `postinstall` runs `husky install`);
- confirm runner resources fit the monorepo (lockfile ~1.4 MB, many
  packages);
- keep the upstream Apache-2.0 license and notices in the demonstrator
  repository;
- Dependabot on a fork requires explicit enablement in the fork's settings.

## Roadmap / not yet implemented

- AI repair circuit via the Mistral vibe CLI on the GitHub Actions runner
  (Phase 3, `RepairProvider`): implemented and unit-tested
  (`src/providers/repair/vibe/`), not yet deployed. The config keys exist
  and are enforced (all AI repairs are currently rejected unless
  `allowed_ai_paths` and `ai_authors` are configured); remaining: create the
  GitHub App gateway that opens replacement PRs from validated patches,
  then enable `repair` in consumer configs.
- Major-version audit reports (Phase 4).
- Installer CLI that generates the wrapper files (Phase 5).
