"""repair-dependency-update — the Mistral-managed repair agent.

Run modes (docs: "Where it runs"):
- local, in-process:  `uv run python main.py` style harness (development)
- self-hosted:        `agents serve` — harness and tools on your servers
- Mistral-managed:    `agents deploy` — Mistral builds this repo from git and
  runs the harness + tools; sessions survive restarts. This is the mode the
  framework uses.

The agent receives one framework `RepairRequest` (JSON, schema 1) per session
message and must end every session by calling `finish_repair` with a
`RepairStatusReport` JSON as its final message. Commands it runs execute in
the session's `MistralSandbox` (Mistral Cloud), never on a GitHub runner.
The sandbox gets GitHub access through a `GitHubBinding` as the session user,
so the clone uses the platform identity — the worker never holds a long-lived
write credential.
"""

from __future__ import annotations

import json
from pathlib import Path

from mistralai import agents

from repair_agent.contracts import RepairRequest, RepairStatusReport
from repair_agent.patch_guard import (
    DEFAULT_FORBIDDEN_PATHS,
    check_patch,
    manifest_edit_violations,
    path_is_forbidden,
)

DOCTRINE = (Path(__file__).parent / "repair_agent" / "REPAIR_DOCTRINE.md").read_text()


@agents.tool
async def list_files(root: str = ".", pattern: str = "**/*") -> str:
    """List files under root (capped). Use to explore the cloned repository."""
    import fnmatch

    base = Path(root)
    out = []
    for p in sorted(base.glob(pattern))[:500]:
        if p.is_file():
            out.append(str(p))
    return "\n".join(out) or "(no files)"


@agents.tool
async def read_file(path: str, max_bytes: int = 200_000) -> str:
    """Read a UTF-8 file from the session sandbox (size-capped)."""
    data = Path(path).read_bytes()[:max_bytes]
    return data.decode("utf-8", errors="replace")


@agents.tool
async def apply_edits(path: str, edits: list[dict[str, str]]) -> str:
    """Apply exact in-place text replacements to one file.

    Each edit is {"old_text": ..., "new_text": ...}; old_text must occur
    exactly once. Every edit passes the patch guard BEFORE touching disk:
    forbidden paths (tests, CI, policy files, snapshots) and protected
    manifest sections are rejected outright.
    """
    target = Path(path)
    guard = check_patch([str(target)], forbidden_paths=tuple(DEFAULT_FORBIDDEN_PATHS))
    if not guard.allowed:
        return f"REJECTED by patch guard: {guard.violations}"
    current = target.read_text(encoding="utf-8")
    for edit in edits:
        old_text, new_text = edit["old_text"], edit["new_text"]
        if str(target).endswith("package.json"):
            violations = manifest_edit_violations(str(target), current, old_text, new_text)
            if violations:
                return f"REJECTED: protected manifest section: {violations}"
        if current.count(old_text) != 1:
            return f"REJECTED: old_text occurs {current.count(old_text)} times in {path} (need exactly 1)"
        current = current.replace(old_text, new_text, 1)
    target.write_text(current, encoding="utf-8")
    return f"OK: applied {len(edits)} edit(s) to {path}"


@agents.tool
async def run_command(command: str, timeout_seconds: int = 600) -> str:
    """Run a shell command in the session sandbox.

    Only the verification commands carried in the RepairRequest (install /
    build / test from the consumer's .maintenance.yml) plus read-only
    inspection commands (git, ls, cat, pnpm why, ...) are acceptable; the
    doctrine forbids anything else. Output is truncated.
    """
    import asyncio
    import subprocess

    proc = await asyncio.create_subprocess_shell(
        command,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        cwd=str(Path.cwd()),
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout_seconds)
    except asyncio.TimeoutError:
        proc.kill()
        return f"TIMEOUT after {timeout_seconds}s: {command}"
    return out.decode("utf-8", errors="replace")[-20_000:]


@agents.tool
async def finish_repair(report_json: str) -> str:
    """End the repair. report_json must be a RepairStatusReport:
    {"status": "pr_created"|"blocked"|"not_reproducible"|"transient_failure"|
    "budget_exceeded"|"stale_original_pr", "reason": ..., "patch": ...}.
    Call exactly once, as the final action. The report becomes the turn's
    final message and is read by the framework client."""
    report = RepairStatusReport.model_validate(json.loads(report_json))
    return report.model_dump_json()


agent = agents.Agent(
    name="repair-dependency-update",
    model="mistral-large-4",
    instructions=(
        DOCTRINE
        + "\n\nYou receive one RepairRequest JSON per message. Workflow: clone the "
        "repository at original_head_sha (git is preconfigured via the session's "
        "GitHubBinding), apply the dependency update, run the request's verification "
        "commands with run_command, fix application code with apply_edits (never "
        "tests/CI/policy files), then call finish_repair exactly once with the "
        "RepairStatusReport JSON. If the failure cannot be reproduced or the fix "
        "is out of policy, finish_repair with the honest blocked/not_reproducible "
        "status instead of a misleading patch."
    ),
    tools=[list_files, read_file, apply_edits, run_command, finish_repair],
    environment=agents.MistralSandbox(
        bindings=[agents.GitHubBinding()],
    ),
)
