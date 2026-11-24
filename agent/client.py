#!/usr/bin/env python3
"""Thin client for the Mistral-managed repair agent (Session API).

This process runs on the GitHub Actions runner ONLY to forward JSON to the
hosted agent — the agent harness, its tools and every repository command run
on Mistral (Mistral-managed deployment), inside the session's MistralSandbox.
No PR code is ever checked out or executed here.

Usage:
    uvx --python 3.12 --from mistralai-agents python client.py run <request.json>
    uvx --python 3.12 --from mistralai-agents python client.py status <request.json> <session_id>

Environment:
    MISTRAL_API_KEY      workspace API key (required)
    REPAIR_AGENT_NAME    deployed agent name (default: repair-dependency-update)

Output (stdout, JSON):
    {"session_id": ..., "turn_id": ..., "report": <RepairStatusReport>}

Idempotence: the session idempotency key is the framework's request
idempotency key, and the turn key is derived from it, so a replayed event
returns the SAME session and turn (the SDK guarantees this) instead of
starting a duplicate repair.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys

from mistralai import agents


def agent_name() -> str:
    return os.environ.get("REPAIR_AGENT_NAME", "repair-dependency-update")


async def run_repair(request_path: str) -> dict:
    with open(request_path, encoding="utf-8") as fh:
        request = json.load(fh)
    key = request["idempotency_key"]

    agent = agents.Agent.load_from(agent_name=agent_name())
    session = await agent.start_session(idempotency_key=key)
    state = await session.run(json.dumps(request), idempotency_key=f"{key}:turn")
    if isinstance(state, agents.Busy):
        # Another process is driving this session's turn; wait for the record.
        state = await state.turn.result()

    report = json.loads(state.text) if isinstance(state, agents.Completed) else None
    if report is None:
        report = {"status": "internal_error", "reason": f"turn did not complete: {type(state).__name__}"}
    report["idempotency_key"] = key
    return {
        "session_id": session.id,
        "turn_id": getattr(state, "turn_id", None),
        "report": report,
    }


async def check_session(request_path: str, session_id: str) -> dict:
    """Re-bind a stored session and replay the same turn idempotency key:
    returns the recorded turn if it finished, in_progress while it runs."""
    with open(request_path, encoding="utf-8") as fh:
        request = json.load(fh)
    key = request["idempotency_key"]
    agent = agents.Agent.load_from(agent_name=agent_name())
    session = agent.session(session_id)  # binds by id, sends no request
    state = await session.run(json.dumps(request), idempotency_key=f"{key}:turn")
    if isinstance(state, agents.Busy):
        return {"session_id": session_id, "report": {"status": "in_progress", "idempotency_key": key}}
    if isinstance(state, agents.Completed):
        report = json.loads(state.text)
    else:
        report = {"status": "internal_error", "reason": f"turn did not complete: {type(state).__name__}"}
    report["idempotency_key"] = key
    return {"session_id": session_id, "report": report}


def main() -> int:
    if len(sys.argv) == 3 and sys.argv[1] == "run":
        request_path, session_id = sys.argv[2], None
    elif len(sys.argv) == 4 and sys.argv[1] == "status":
        request_path, session_id = sys.argv[2], sys.argv[3]
    else:
        sys.stderr.write(__doc__ or "")
        return 2
    if not os.environ.get("MISTRAL_API_KEY"):
        sys.stderr.write("MISTRAL_API_KEY is not set; cannot reach the repair agent.\n")
        return 2
    result = asyncio.run(
        run_repair(request_path) if session_id is None else check_session(request_path, session_id)
    )
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
