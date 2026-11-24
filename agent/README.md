# Repair agent (Mistral-managed, Agents SDK)

The Phase 3 coding agent is a **Mistral Studio agent** built with the Agents
SDK (`mistralai-agents`, `from mistralai import agents`), NOT a workflow. You
deploy it once with `agents deploy`; Mistral then hosts the harness and the
tools, keeps every session durable, and runs each session's commands in a
per-session `MistralSandbox` on Mistral Cloud. The session trace shows the
agent's thoughts and every command it ran.

The framework never runs the agent on a GitHub Actions runner: the CI job
only calls the thin `client.py`, which opens a session through the Session
API and prints the final `RepairStatusReport`.

## Layout

```text
agent/
├── pyproject.toml            # mistralai-agents + pydantic, python 3.12
├── main.py                   # the agent: tools + MistralSandbox, name=repair-dependency-update
├── client.py                 # thin Session-API client used by maintenance-repair-run (CI side)
├── repair_agent/
│   ├── contracts.py          # pydantic RepairRequest / RepairStatusReport (schema 1)
│   ├── patch_guard.py        # forbidden paths + protected manifest sections
│   └── REPAIR_DOCTRINE.md    # the repair doctrine, injected as instructions
└── tests/                    # stdlib unittest (contracts + guard; no SDK needed)
```

## The agent

`main.py` defines `agent = agents.Agent(name="repair-dependency-update", ...)`
with tools `list_files`, `read_file`, `apply_edits` (patch-guarded before any
disk write), `run_command` (session sandbox only) and `finish_repair` (must
be called exactly once; its JSON becomes the turn's final message). The
environment is a `MistralSandbox` with a `GitHubBinding`, so git/GitHub access
happens as the session user through the platform — no long-lived write token
in the agent.

One session per repair: the session idempotency key IS the framework's
`repo#pr@sha:repair-v1`, so duplicated GitHub events and CI retries return the
same session and turn instead of starting a duplicate repair.

## Deploy (Mistral-managed)

Per "Let Mistral host the agent: agents deploy" (Studio > Agents > Where it
runs):

1. Commit and push this repository; connect the GitHub connector in Mistral
   Studio so the platform can clone it.
2. `MISTRAL_API_KEY` needs a workspace role with Workflows access (Developer
   or above); an agent with a `MistralSandbox` also needs the `cloud_user`
   role.
3. `uvx --python 3.12 --from mistralai-agents agents deploy` from `agent/`.
   The first deploy writes a `Dockerfile` + `.python-version` — commit, push,
   deploy again. The deploy builds the pushed commit.
4. The agent is live under the name `repair-dependency-update`; try it in
   Vibe Code Web or programmatically via the Session API (`client.py`).

## Framework side (CI)

`maintenance-repair-run --config .maintenance.yml request.json` with
`repair.provider: mistral-agent` shells out to:

```bash
uvx --python 3.12 --from mistralai-agents python agent/client.py run request.json
```

with `MISTRAL_API_KEY` and optional `REPAIR_AGENT_NAME` in the environment.
The client prints `{"session_id", "turn_id", "report"}`; the CLI maps the
report onto the framework's `RepairStatusReport`.

## Testing

```bash
cd agent && python3 -m unittest discover -s tests -v
```

The deterministic parts (contracts, patch guard) are covered without the
Agents SDK. `main.py` needs `mistralai-agents` and is exercised by a deploy
smoke test: start one session with a sample `RepairRequest` and confirm the
turn record shows the sandbox commands and the final report.

## Security posture

- The agent holds no GitHub write credential; the sandbox's git identity is
  the session user via `GitHubBinding`.
- Repository commands run only inside the MistralSandbox; the CI runner never
  checks out PR code for the repair.
- `patch_guard` rejects tests/CI/policy/manifest-section edits before disk;
  the framework gateway re-validates the final patch with the TS policy engine
  before any replacement PR is opened.
