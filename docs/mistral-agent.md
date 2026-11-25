# Mistral managed agent (repair provider)

> Phase 3 — implemented in code, not yet deployed. The agent project lives in
> `agent/` (Agents SDK, `mistralai-agents`); the TS adapter is
> `src/providers/repair/mistral/adapter.ts`; the thin Session-API client is
> `agent/client.py`; the deterministic guards are
> `src/policy/repair-eligibility.ts` (CLI: `maintenance-repair-request`); the
> CLI that drives one repair is `maintenance-repair-run`. API shapes follow
> the Mistral Agents SDK documentation (public preview) and must be
> re-verified at deploy time.

## Role

The repair agent is a **Mistral Studio agent** deployed Mistral-managed
(`agents deploy`), used **only** for CI-red dependency PRs that need a
compatibility repair. It is never used to check GitHub statuses, to decide
merges, or to publish releases: those stay deterministic and GitHub-native.

## Run mode: Mistral-managed (`agents deploy`)

Per "Where it runs > Mistral-managed: agents deploy": Mistral builds the
framework repository from git (GitHub connector) and hosts the agent harness
and tools; sessions are durable and survive restarts. Each session's shell
commands and files run in a per-session `MistralSandbox` on Mistral Cloud
(needs the `cloud_user` role); git/GitHub access goes through a
`GitHubBinding` as the session user. The session trace shows every thought
and every command the agent ran.

The GitHub Actions runner never executes agent or PR code: the CI job runs
only the thin `agent/client.py`, which talks to the Session API.

## Driving the agent (Session API)

```python
agent = agents.Agent.load_from(agent_name="repair-dependency-update")
session = await agent.start_session(idempotency_key=request["idempotency_key"])
state = await session.run(json.dumps(request), idempotency_key=key + ":turn")
# state: agents.Completed -> state.text is the final RepairStatusReport JSON
#        agents.Busy      -> await state.turn.result()
```

```ts
interface RepairProvider {
  submit(request: RepairRequest): Promise<RepairExecution>; // execution_id = session id
  status(executionId: string): Promise<RepairStatusReport>;  // re-bind session, replay turn key
}
```

The framework owns the request/response schemas (`schema_version: "1"`); the
adapter + client translate them to the Agents SDK.

## Input contract (framework-owned)

Same `RepairRequest` JSON as before (see `src/providers/repair/types.ts`):
`idempotency_key` = `owner/repo#123@abcdef...:repair-v1`, repository, base
branch, PR number/head SHA, dependency updates, verification commands, CI
facts, policy. Duplicated events and retries map to the same session/turn.

## Output contract (framework-owned)

The agent must end every session by calling its `finish_repair` tool once;
the `RepairStatusReport` JSON becomes the turn's final message:
`pr_created`, `blocked`, `not_reproducible`, `transient_failure`,
`budget_exceeded`, `stale_original_pr`, `internal_error` (plus framework-side
`in_progress` while the turn runs).

The agent produces a **patch**; it never receives GitHub or Mistral write
credentials. The privileged gateway validates the patch with the policy
engine (forbidden paths, manifest guard, allowed AI surface, file budget)
and opens a replacement PR authored by a GitHub App with the `ai-assisted`
label. The replacement PR goes through the full CI from scratch and is
eligible for the same native auto-merge — the engine's `ai-assisted` circuit
is already implemented and unit-tested.

## Deploy checklist

1. Push the repo; connect the GitHub connector in Mistral Studio.
2. `MISTRAL_API_KEY` with a workspace role that has Workflows access;
   `cloud_user` role for the `MistralSandbox`.
3. `cd agent && uvx --python 3.12 --from mistralai-agents agents deploy`
   (first run writes `Dockerfile` + `.python-version` — commit, push, retry).
4. Smoke: `agent/client.py run sample-request.json` → confirm the session
   trace shows sandbox commands and the final report.
