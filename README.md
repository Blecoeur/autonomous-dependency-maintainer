# autonomous-dependency-maintainer

A reusable, GitHub-native framework that keeps a repository's dependencies up
to date with **no human review for the ordinary case**, and **explicit,
auditable blocking** for everything it cannot guarantee.

Design contract: [AUTONOMOUS_DEPENDENCY_MAINTENANCE_SPEC.md](../AUTONOMOUS_DEPENDENCY_MAINTENANCE_SPEC.md) (RFC v0.1.0, in French).

## What it does

- **Weekly Dependabot scans** with a 3-day cooldown, one PR per dependency,
  ordinary major updates deferred.
- **Policy engine** deciding, deterministically, whether a PR is an eligible
  automated maintenance PR: author identity, changed paths, protected
  manifest sections, update types.
- **GitHub native auto-merge** for eligible PRs. No AI in the loop when CI is
  green — the merge is authorized by GitHub's required checks, not by a model.
- **Explicit blocking**: majors, unverifiable updates, test weakening, and CI
  workflow changes stay visible instead of being silently merged.
- An optional, not-yet-implemented **AI repair circuit** behind a
  `RepairProvider` interface (Mistral Workflows adapter planned in Phase 3).

## Status

Phase 1 (policy + automerge, no AI) and Phase 2 (weekly release with
source-aware versioning and provenance) are implemented. See
[docs/onboarding.md](docs/onboarding.md) for the deployment checklist and the
roadmap section below for what is intentionally missing.

## How it works

```
Consumer repository                      This framework (pinned ref)
────────────────────                     ───────────────────────────
.github/dependabot.yml
      │ weekly PRs
      ▼
maintenance-ci.yml ──── uses ───► node-pnpm-ci.yml      (build/test, no secrets)
      │                   └────► policy-check.yml       (deep policy decision,
      │                                                   required check)
maintenance-auto-merge.yml
      (pull_request_target) ── uses ─► auto-merge.yml   (provenance check +
      │                                                  native auto-merge)
      ▼
GitHub merges only when every required check passes
```

- The policy engine is a pure function: the workflow collects PR facts via
  the GitHub API, the engine decides, no LLM and no token involved.
- The configuration (`.maintenance.yml`) is always read from the **base
  branch**, so a PR cannot weaken the rules applied to itself.
- The auto-merge job never checks out or executes PR code.

## Self-hosted

This repository is maintained by its own framework: Dependabot npm
updates go through the same policy check and auto-merge circuit as any
consumer, with the wrappers pinned to the **last released** tag. A PR
that modifies the policy engine is therefore evaluated by the previously
released engine — the framework cannot weaken its own rules mid-flight.
`github-actions` updates are deliberately absent: this repository's
workflows are the trust engine, updated manually. Framework releases are
tagged manually and deliberately; consumers bump their pins in an
explicit, reviewable change.

## Install into a repository

1. Copy `templates/github-public-node-pnpm/` files into the target repo
   (`.maintenance.yml`, `.github/dependabot.yml`, three workflow wrappers).
2. The wrappers are pre-pinned to `Blecoeur/autonomous-dependency-maintainer@v0.1.6`;
   if you use your own deployment, replace that reference with yours, always an
   immutable tag or full commit SHA. Never reference `@main`.
3. Adjust the validation commands in `.maintenance.yml` and the CI wrapper to
   the real commands of the repository.
4. Follow the GitHub settings checklist in
   [docs/onboarding.md](docs/onboarding.md) (branch protection, required
   checks, auto-merge, Dependabot).

## Development

```bash
pnpm install
pnpm build      # compiles the CLI to dist/
pnpm test       # unit tests of the decision rules
```

CLI entry points (also usable locally against a JSON PR snapshot):

```bash
node dist/cli/validate-config.js path/to/.maintenance.yml
node dist/cli/check-pr.js --config .maintenance.yml --pr pr.json
```

## Documentation

- [docs/architecture.md](docs/architecture.md) — components and data flow
- [docs/security-model.md](docs/security-model.md) — trust boundaries, threats, mitigations
- [docs/policy-reference.md](docs/policy-reference.md) — `.maintenance.yml` reference and decision rules
- [docs/onboarding.md](docs/onboarding.md) — deployment checklist, GitHub settings, roadmap

## License

MIT (provisional — adjust before publishing; the Keelflow demonstrator keeps
its upstream Apache-2.0 obligations, which are independent of this framework's
license).

## Roadmap

- Phase 3 (next): `RepairProvider` interface, Mistral Workflows adapter
  (Python worker), GitHub App for replacement PRs, isolated repair sandbox.
- Phase 4: major-version audit circuit (`deferred` / `migration-required` /
  `unknown` reports).
- Phase 5: installer CLI, second-ecosystem adapters.

Shipped:
- Phase 1: policy engine, `maintenance-policy` required check, native
  auto-merge circuit, templates, minimal example.
- Phase 2: weekly release workflow (`release.yml`), source-aware versioning
  (PATCH for dependency-only, MINOR when an AI-assisted fix is included),
  generated release notes and machine-readable provenance.
