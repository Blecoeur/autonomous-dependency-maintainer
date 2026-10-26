"""The repair agent loop.

Receives a failing dependency update, runs the deterministic build/test
commands, and asks a Mistral model for minimal compatibility fixes when —
and only when — those commands fail. The system prompt is the contractual
one from the spec (section 7.7); the guard (patch_guard) enforces the rules
externally, because prompts are never security boundaries.

The Mistral client is imported lazily: the loop logic is unit-testable with
a stubbed model.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional, Protocol

from .contracts import RepairRequest, RepairStatusReport
from .patch_guard import check_patch
from .sandbox import CommandResult, RepairSandbox

SYSTEM_PROMPT = """You are an agent of dependency-compatibility repair, not a feature developer.
Only modify what is necessary to make the application compatible with the
provided dependency update. Preserve existing behavior and public APIs.
Never modify tests, snapshots, CI workflows, test configuration,
quality/security rules, release files or policy files. Never delete a test
or work around a validation. Never propose opportunistic refactors or new
features. Document the changed files and the precise technical cause. If the
fix requires a breaking change, a data migration, a policy change or
disabling tests, report the case as blocked instead of pushing a misleading
patch."""

MAX_FAILURE_CONTEXT_LINES = 60


class ModelClient(Protocol):
    """Minimal chat interface; implemented by the Mistral SDK adapter."""

    def complete(self, system: str, user: str) -> str: ...


class Repairer:
    def __init__(
        self,
        request: RepairRequest,
        sandbox: RepairSandbox,
        model: Optional[ModelClient] = None,
        build_command: str = "pnpm build",
        test_command: str = "pnpm test",
    ):
        self.request = request
        self.sandbox = sandbox
        self.model = model
        self.build_command = build_command
        self.test_command = test_command

    def run(self) -> RepairStatusReport:
        """Drives the repair loop within the policy budget."""
        base = {
            "idempotency_key": self.request.idempotency_key,
            "changed_application_files": [],
        }

        # Reproduce the failure deterministically first: the dependency update
        # alone must break the build/tests before any model call.
        if not self.sandbox.repo_dir.exists():
            self.sandbox.prepare(install_command="pnpm install --no-frozen-lockfile")
        reproduce = self._verify()
        if reproduce.ok:
            return RepairStatusReport(
                status="not_reproducible",
                attempt_count=0,
                reason="the dependency update passes build and tests as-is",
                **base,
            )

        attempts = 0
        last_failure = reproduce
        while attempts < self.request.policy.max_attempts:
            attempts += 1
            if self.model is None:
                return RepairStatusReport(
                    status="internal_error",
                    attempt_count=attempts,
                    reason="no model client configured",
                    **base,
                )

            user_prompt = self._user_prompt(last_failure, attempts)
            try:
                answer = self.model.complete(system=SYSTEM_PROMPT, user=user_prompt)
            except Exception as err:  # noqa: BLE001 - provider errors are reported, not raised
                return RepairStatusReport(
                    status="transient_failure",
                    attempt_count=attempts,
                    reason=f"model call failed: {err}",
                    **base,
                )

            if _declares_blocked(answer):
                return RepairStatusReport(
                    status="blocked",
                    attempt_count=attempts,
                    reason=_blocked_reason(answer),
                    **base,
                )

            changed = self.sandbox.changed_files()
            guard = check_patch(changed)
            if not guard.allowed:
                return RepairStatusReport(
                    status="blocked",
                    attempt_count=attempts,
                    reason=f"agent patch violates the policy guard: {guard.summary}",
                    **base,
                )
            if len(changed) > self.request.policy.max_changed_application_files:
                return RepairStatusReport(
                    status="blocked",
                    attempt_count=attempts,
                    reason=(
                        f"agent changed {len(changed)} files, policy allows "
                        f"{self.request.policy.max_changed_application_files}"
                    ),
                    **base,
                )

            # apply the model's file edits
            try:
                self._apply_edits(answer)
            except ValueError as err:
                return RepairStatusReport(
                    status="internal_error",
                    attempt_count=attempts,
                    reason=f"could not apply model edits: {err}",
                    **base,
                )

            verification = self._verify()
            if verification.ok:
                return RepairStatusReport(
                    status="pr_created",
                    attempt_count=attempts,
                    reason="build and tests pass with the compatibility fix",
                    changed_application_files=changed,
                    idempotency_key=self.request.idempotency_key,
                )
            last_failure = verification

        return RepairStatusReport(
            status="budget_exceeded",
            attempt_count=attempts,
            reason=f"repair did not pass within {self.request.policy.max_attempts} attempts",
            **base,
        )

    # -- internals ---------------------------------------------------------

    def _verify(self) -> CommandResult:
        build = self.sandbox.run(self.build_command)
        if not build.ok:
            return build
        return self.sandbox.run(self.test_command)

    def _user_prompt(self, failure: CommandResult, attempt: int) -> str:
        updates = ", ".join(
            f"{u.name} {u.from_version} -> {u.to_version}" for u in self.request.dependency_updates
        )
        return (
            f"Repository: {self.request.repository} (branch {self.request.base_branch}, "
            f"head {self.request.original_head_sha}).\n"
            f"Dependency update under repair: {updates}.\n"
            f"Attempt {attempt} of {self.request.policy.max_attempts}.\n\n"
            f"Failing command output (tail):\n```\n{failure.tail(MAX_FAILURE_CONTEXT_LINES)}\n```\n\n"
            "Return your fix as a unified-diff-like list of FILE blocks, one per file: "
            "<<<FILE path/to/file.ts then the full new file content, ended by END OF FILE>>>. "
            "Only include files that must change. Never touch tests, workflows or policy files."
        )

    def _apply_edits(self, answer: str) -> None:
        """Applies the model's FILE blocks (full-file replacements)."""
        pattern = re.compile(r"<<<FILE\s+(\S+?)\s*\n(.*?)\nEND OF FILE>>>", re.DOTALL)
        matches = pattern.findall(answer)
        if not matches:
            raise ValueError("model answer contained no FILE blocks")
        for path, content in matches:
            target = (self.sandbox.repo_dir / path).resolve()
            repo_root = self.sandbox.repo_dir.resolve()
            if repo_root not in target.parents:
                raise ValueError(f"model tried to write outside the repository: {path}")
            target.write_text(content)


def _declares_blocked(answer: str) -> bool:
    return bool(re.search(r"\bBLOCKED\b", answer.upper()))


def _blocked_reason(answer: str) -> str:
    match = re.search(r"BLOCKED[:\s]*(.*)", answer, re.IGNORECASE | re.DOTALL)
    return (match.group(1).strip()[:500] if match else "model declared the repair blocked") or "model declared the repair blocked"
