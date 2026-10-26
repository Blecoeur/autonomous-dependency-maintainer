"""Agentic repair loop.

The model explores the repository and iterates a fix through a bounded tool
set (read_file, list_files, apply_edits, run_verification, finish). The
harness — not the model — provides the robustness:

- every edit passes the patch guard BEFORE touching disk;
- `finish(pr_created)` is only accepted after the harness itself re-runs the
  build/test verification;
- rounds are budgeted, commands are the consumer's configured build/test
  commands (no arbitrary shell), and the whole repair runs inside one
  Mistral Workflows activity.

The doctrine injected as the system prompt lives in
skills/dependency_repair/SKILL.md — a reviewable artifact, not code.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional, Protocol

from .contracts import RepairRequest, RepairStatusReport
from .patch_guard import check_patch, manifest_edit_violations
from .sandbox import RepairSandbox

SKILL_PATH = Path(__file__).parent / "skills" / "dependency_repair" / "SKILL.md"

MAX_FILE_BYTES = 40_000
MAX_LIST_ENTRIES = 200
MAX_FAILURE_CONTEXT_LINES = 60
ROUNDS_PER_ATTEMPT = 5
LIST_SKIP_DIRS = {".git", "node_modules", "dist", "build", ".turbo", "coverage", ".next", "__pycache__"}


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: dict[str, Any]


@dataclass
class ModelTurn:
    content: Optional[str]
    tool_calls: list[ToolCall] = field(default_factory=list)


class ToolModelClient(Protocol):
    """One agentic model exchange: messages in, one turn (with tool calls) out."""

    def turn(self, system: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> ModelTurn: ...


def tool_specs() -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Read a file from the repository (bounded size).",
                "parameters": {
                    "type": "object",
                    "properties": {"path": {"type": "string"}},
                    "required": ["path"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "list_files",
                "description": "List repository files under a path, optionally filtered by a substring pattern.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "Directory to list ('' for the repository root)"},
                        "pattern": {"type": "string", "description": "Optional substring filter"},
                    },
                    "required": [],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "apply_edits",
                "description": "Apply exact in-place text replacements (old_text must appear verbatim). Edits touching protected paths are rejected.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "edits": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "path": {"type": "string"},
                                    "old_text": {"type": "string"},
                                    "new_text": {"type": "string"},
                                },
                                "required": ["path", "old_text", "new_text"],
                            },
                        }
                    },
                    "required": ["edits"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "run_verification",
                "description": "Run the configured build and test commands; returns exit codes and output tails.",
                "parameters": {"type": "object", "properties": {}, "required": []},
            },
        },
        {
            "type": "function",
            "function": {
                "name": "finish",
                "description": "End the repair. status: 'pr_created' (verification passed) or 'blocked' (fix requires a forbidden change).",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "status": {"type": "string", "enum": ["pr_created", "blocked"]},
                        "reason": {"type": "string"},
                    },
                    "required": ["status", "reason"],
                },
            },
        },
    ]


class AgenticRepairer:
    def __init__(self, request: RepairRequest, sandbox: RepairSandbox, model: ToolModelClient):
        self.request = request
        self.sandbox = sandbox
        self.model = model
        self.changed: list[str] = []

    # -- entry -------------------------------------------------------------

    def run(self) -> RepairStatusReport:
        self.sandbox.prepare(install_command=self.request.commands.install or "true")
        base = {"idempotency_key": self.request.idempotency_key}

        reproduce = self._verify()
        if reproduce.ok:
            return RepairStatusReport(
                status="not_reproducible",
                attempt_count=0,
                reason="the dependency update passes build and tests as-is",
                **base,
            )

        system = SKILL_PATH.read_text()
        messages: list[dict[str, Any]] = [
            {
                "role": "user",
                "content": self._initial_context(reproduce),
            }
        ]

        max_rounds = self.request.policy.max_attempts * ROUNDS_PER_ATTEMPT
        no_tool_warnings = 0
        for round_index in range(1, max_rounds + 1):
            try:
                turn = self.model.turn(system, messages, tool_specs())
            except Exception as err:  # noqa: BLE001
                return RepairStatusReport(
                    status="transient_failure",
                    attempt_count=round_index,
                    reason=f"model call failed: {err}",
                    **base,
                )

            if not turn.tool_calls:
                if (turn.content or "").strip().upper().startswith("BLOCKED"):
                    return RepairStatusReport(
                        status="blocked",
                        attempt_count=round_index,
                        reason=(turn.content or "").strip()[:500],
                        **base,
                    )
                no_tool_warnings += 1
                if no_tool_warnings >= 2:
                    return RepairStatusReport(
                        status="blocked",
                        attempt_count=round_index,
                        reason="model produced no actionable tool calls",
                        **base,
                    )
                messages.append({"role": "user", "content": "Use the tools. Call finish when done."})
                continue

            messages.append(
                {
                    "role": "assistant",
                    "content": turn.content or "",
                    "tool_calls": [
                        {"id": c.id, "name": c.name, "arguments": json.dumps(c.arguments)}
                        for c in turn.tool_calls
                    ],
                }
            )

            for call in turn.tool_calls:
                result, finished = self._dispatch(call)
                messages.append(
                    {"role": "tool", "tool_call_id": call.id, "name": call.name, "content": result}
                )
                if finished is not None:
                    finished["attempt_count"] = round_index
                    return RepairStatusReport(**{**base, **finished})

        return RepairStatusReport(
            status="budget_exceeded",
            attempt_count=max_rounds,
            reason=f"repair did not finish within {max_rounds} rounds",
            **base,
        )

    # -- tools --------------------------------------------------------------

    def _dispatch(self, call: ToolCall) -> tuple[str, Optional[dict[str, Any]]]:
        """Executes one tool call; the second element ends the loop when set."""
        try:
            if call.name == "read_file":
                return self._tool_read_file(call.arguments), None
            if call.name == "list_files":
                return self._tool_list_files(call.arguments), None
            if call.name == "apply_edits":
                return self._tool_apply_edits(call.arguments), None
            if call.name == "run_verification":
                return self._tool_run_verification(), None
            if call.name == "finish":
                return self._tool_finish(call.arguments)
        except Exception as err:  # noqa: BLE001 - tool errors are model feedback
            return f"tool error: {type(err).__name__}: {err}", None
        return f"unknown tool: {call.name}", None

    def _tool_read_file(self, args: dict[str, Any]) -> str:
        path = self._safe_path(str(args.get("path", "")))
        content = path.read_text(errors="replace")[:MAX_FILE_BYTES]
        return content if content else "(empty file)"

    def _tool_list_files(self, args: dict[str, Any]) -> str:
        root = self.sandbox.repo_dir
        base = self._safe_path(str(args.get("path", "") or "."))
        pattern = str(args.get("pattern", "") or "")
        entries: list[str] = []
        for candidate in sorted(root.rglob("*")):
            if len(entries) >= MAX_LIST_ENTRIES:
                entries.append("… (truncated)")
                break
            rel = candidate.relative_to(root).as_posix()
            if any(part in LIST_SKIP_DIRS for part in rel.split("/")):
                continue
            if candidate.is_dir():
                continue
            if pattern and pattern not in rel:
                continue
            entries.append(rel)
        if not entries:
            return "(no matching files)"
        return "\n".join(entries)

    def _tool_apply_edits(self, args: dict[str, Any]) -> str:
        edits = args.get("edits", [])
        if not edits:
            return "no edits provided"
        staged_paths = [str(e.get("path", "")) for e in edits]
        guard = check_patch([p for p in staged_paths if p not in self.changed] + self.changed)
        if not guard.allowed:
            return f"REJECTED by the policy guard: {guard.summary}. These paths are untouchable."

        results: list[str] = []
        for edit in edits:
            rel = str(edit.get("path", ""))
            path = self._safe_path(rel)
            current = path.read_text(errors="replace")
            old_text = str(edit.get("old_text", ""))
            new_text = str(edit.get("new_text", ""))
            violations = manifest_edit_violations(rel, current, old_text, new_text)
            if violations:
                return f"REJECTED: {'; '.join(violations)}"
            if old_text not in current:
                results.append(f"{rel}: old_text not found (file unchanged)")
                continue
            path.write_text(current.replace(old_text, new_text, 1))
            if rel not in self.changed:
                self.changed.append(rel)
            results.append(f"{rel}: applied")

        if len(self.changed) > self.request.policy.max_changed_application_files:
            self.changed = []
            return (
                f"REJECTED: budget of {self.request.policy.max_changed_application_files} "
                "changed application files exceeded; all edits were reverted"
            )
        return "; ".join(results)

    def _tool_run_verification(self) -> str:
        result = self._verify()
        tail = result.tail(MAX_FAILURE_CONTEXT_LINES)
        verdict = "PASSED" if result.ok else f"FAILED (exit {result.returncode})"
        return f"verification {verdict}\n```\n{tail}\n```"

    def _tool_finish(self, args: dict[str, Any]) -> tuple[str, Optional[dict[str, Any]]]:
        status = str(args.get("status", ""))
        reason = str(args.get("reason", ""))[:500] or "no reason given"
        if status == "blocked":
            return "repair finished: blocked", {
                "status": "blocked",
                "reason": reason,
                "changed_application_files": list(self.changed),
            }
        if status == "pr_created":
            verify = self._verify()
            if verify.ok:
                return "verification confirmed; repair accepted", {
                    "status": "pr_created",
                    "reason": reason,
                    "changed_application_files": list(self.changed),
                }
            return (
                "finish(pr_created) REFUSED: the harness re-ran the verification and it "
                f"still fails (exit {verify.returncode}). Continue fixing or call finish(blocked).",
                None,
            )
        return f"unknown finish status: {status}", None

    # -- internals -----------------------------------------------------------

    def _verify(self):
        if self.request.commands.build:
            build = self.sandbox.run(self.request.commands.build)
            if not build.ok:
                return build
        return self.sandbox.run(self.request.commands.test)

    def _safe_path(self, rel: str) -> Path:
        path = (self.sandbox.repo_dir / rel).resolve()
        root = self.sandbox.repo_dir.resolve()
        if root != path and root not in path.parents:
            raise ValueError(f"path escapes the repository: {rel}")
        if not path.exists():
            raise FileNotFoundError(rel)
        return path

    def _initial_context(self, failure) -> str:
        updates = ", ".join(
            f"{u.name} {u.from_version} -> {u.to_version}" for u in self.request.dependency_updates
        )
        return (
            f"Repository: {self.request.repository} (head {self.request.original_head_sha}).\n"
            f"Dependency update under repair: {updates}.\n"
            f"Budget: {self.request.policy.max_attempts * ROUNDS_PER_ATTEMPT} tool rounds; "
            f"at most {self.request.policy.max_changed_application_files} changed application files.\n\n"
            f"Verification fails as follows (tail):\n```\n{failure.tail(MAX_FAILURE_CONTEXT_LINES)}\n```\n\n"
            "Find the cause, apply the minimal fix with apply_edits, verify with "
            "run_verification, then call finish."
        )
