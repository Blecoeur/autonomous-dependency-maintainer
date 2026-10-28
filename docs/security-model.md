# Security model

## Trust boundaries

| Zone | Trust | Granted |
|---|---|---|
| PR code and CI on PRs | untrusted | read-only token, no secrets |
| CI logs, PR titles, PR bodies, artifacts | untrusted input | parsed, never executed, never interpreted as instructions |
| `.maintenance.yml` on the PR head | untrusted | **never read** — the policy check reads the base branch copy |
| Policy engine | trusted | pure functions, no network, no token |
| `policy-check` workflow | semi-privileged | read-only GitHub API access, required check |
| `auto-merge` workflow | privileged | write token; **never checks out or runs PR code** |
| Framework ref used by consumers | trusted after pinning | immutable tag or full SHA, never `@main` |

## Enforced properties

1. **Labels never grant eligibility.** Only the author login from GitHub's
   event data can classify a PR as maintenance. A human PR carrying
   `dependencies` labels is classified `not-maintenance` and never
   auto-merged.
2. **A PR cannot weaken the rules applied to itself.** `.maintenance.yml`,
   workflow files, and policy code are read from the base branch; and
   `.github/**`, `.maintenance.yml` and `CODEOWNERS` are forbidden paths for
   any maintenance PR.
3. **Tests cannot be silently neutralized by path tricks.** Besides the
   forbidden path globs, the engine compares `package.json` snapshots
   (base vs head) and rejects any change to protected sections
   (`scripts`, `lint-staged`, `husky`, ...). Removing the test script or
   turning `test` into `true` fails the required check.
4. **Ambiguity blocks.** Unparseable updates, grouped PRs without version
   information, majors, disabled circuits: `needs-human` or `rejected`,
   never a quiet merge.
5. **Auto-merge is not the authorization.** The privileged job only checks
   provenance and enables GitHub's native auto-merge; the merge is authorized
   by required checks enforced by GitHub on the protected branch.

## Known limitations (explicit, accepted for the MVP)

- A filename filter cannot be a complete sandbox: a dependency PR is
  verified by paths + manifest-section comparison, but a compromised
  dependency can still execute install scripts. The framework reduces, not
  eliminates, supply-chain risk. Consumers should keep Dependabot alerts on
  and review security advisories.
- `**/package.json` as an allowed dependency file can match test fixtures
  named `package.json` in unusual locations; Dependabot never touches such
  files in practice, and the manifest guard still applies.
- The `auto-merge` circuit trusts that the consumer repository has
  **required checks configured** on the base branch. If branch protection is
  absent, GitHub may merge with insufficient validation. Onboarding makes
  this a hard precondition; an automated verifier is planned.
- Workflows are referenced by immutable tags; third-party actions
  (`actions/checkout@v4`, `actions/setup-node@v4`, `pnpm/action-setup@v4`)
  are pinned by tag here for readability — pin them by commit SHA before
  production use.
- Dependabot token restrictions are subtle (secrets unavailable in
  Dependabot-triggered `pull_request` workflows). The design separates the
  required check (pull_request, read-only, no secrets needed) from the
  auto-merge enablement (`pull_request_target`, base context). This exact
  circuit must be proven on a real Dependabot PR before enabling it on a
  production repository.

## AI repair circuit (Phase 3)

The repair agent is the Mistral vibe CLI, run by the framework's
`repair-request.yml` on a GitHub Actions runner (`docs/vibe-repair-provider.md`).
Trust boundaries:

- The agent runs **without GitHub write credentials**. The job token is
  read-only (`contents: read`, `pull-requests: read`); the clone uses a
  read-only `GITHUB_READ_TOKEN` passed via a git `http.extraheader`, never
  embedded in a URL. The agent returns a patch; an external validator
  (reusing this policy engine) accepts or rejects it; a GitHub App opens
  the replacement PR; the full CI runs from scratch.
- `MISTRAL_API_KEY` is present in the agent process (the CLI needs it), but
  **never reaches repository code**: every install/build/test command the
  harness or the agent runs executes with a scrubbed environment
  (`PATH`/`HOME`/`LANG`/`TMPDIR`/`CI` only) —
  `src/providers/repair/vibe/sandbox.ts`.
- The agent runs with a restricted tool set (`read_file`, `grep`, `edit`,
  `write_file`, `bash`), `outside_workdir = "deny"`, a bash allowlist of the
  configured command names, and a framework-owned `VIBE_HOME`: the PR's own
  `.vibe/` directory, hooks, MCP servers and plugins are never loaded.
- The patch is validated twice with this policy engine: once inside the
  repair job (`validatePatch`, before the artifact is uploaded) and once by
  the privileged gateway before the replacement PR is opened.
- The engine's `ai-assisted` circuit already enforces: `ai-assisted` label,
  configured allowed application paths, file-count budget, protected paths
  and manifest sections — evaluated before any auto-merge.
