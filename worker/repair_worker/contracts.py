"""Framework-owned repair contracts (schema version 1).

Mirrors src/providers/repair/types.ts of the autonomous-dependency-maintainer
framework. The JSON contract is owned by the framework; this module is the
Python translation point for the worker. Deliberately stdlib-only so the
contract surface stays testable without provider dependencies.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Optional

REPAIR_STRATEGY_VERSION = "repair-v1"

ALLOWED_OUTCOME_STATUSES = (
    "pr_created",
    "blocked",
    "not_reproducible",
    "transient_failure",
    "budget_exceeded",
    "stale_original_pr",
    "internal_error",
)


class ContractError(ValueError):
    """Raised when a payload does not satisfy the repair contract."""


@dataclass(frozen=True)
class DependencyUpdate:
    name: str
    from_version: str
    to_version: str
    update_type: str  # major | minor | patch

    @staticmethod
    def from_json(data: dict[str, Any]) -> "DependencyUpdate":
        _require(data, ("name", "from_version", "to_version", "update_type"))
        if data["update_type"] not in ("major", "minor", "patch"):
            raise ContractError(f"invalid update_type: {data['update_type']!r}")
        return DependencyUpdate(
            name=data["name"],
            from_version=data["from_version"],
            to_version=data["to_version"],
            update_type=data["update_type"],
        )


@dataclass(frozen=True)
class RepairPolicy:
    max_attempts: int
    allow_test_changes: bool
    allow_ci_changes: bool
    preserve_public_api: bool
    max_changed_application_files: int

    @staticmethod
    def from_json(data: dict[str, Any]) -> "RepairPolicy":
        _require(
            data,
            (
                "max_attempts",
                "allow_test_changes",
                "allow_ci_changes",
                "preserve_public_api",
                "max_changed_application_files",
            ),
        )
        if data["allow_test_changes"] or data["allow_ci_changes"]:
            # The framework never allows these; a request claiming otherwise
            # is a contract violation, not a policy override.
            raise ContractError("repair policy can never allow test or CI changes")
        return RepairPolicy(
            max_attempts=int(data["max_attempts"]),
            allow_test_changes=False,
            allow_ci_changes=False,
            preserve_public_api=bool(data["preserve_public_api"]),
            max_changed_application_files=int(data["max_changed_application_files"]),
        )


@dataclass(frozen=True)
class RepairRequest:
    schema_version: str
    idempotency_key: str
    repository: str
    base_branch: str
    original_pr_number: int
    original_head_sha: str
    dependency_updates: tuple[DependencyUpdate, ...]
    ci_run_id: int
    ci_workflow_name: str
    policy: RepairPolicy

    @staticmethod
    def from_json(data: dict[str, Any]) -> "RepairRequest":
        if data.get("schema_version") != "1":
            raise ContractError(f"unsupported schema_version: {data.get('schema_version')!r}")
        _require(
            data,
            (
                "idempotency_key",
                "repository",
                "base_branch",
                "original_pr_number",
                "original_head_sha",
                "dependency_updates",
                "ci",
                "policy",
            ),
        )
        ci = data["ci"]
        _require(ci, ("run_id", "workflow_name", "conclusion"))
        if ci["conclusion"] != "failure":
            raise ContractError("repair requests are only valid for failed CI runs")
        updates = tuple(DependencyUpdate.from_json(u) for u in data["dependency_updates"])
        if not updates:
            raise ContractError("a repair request must carry at least one dependency update")
        return RepairRequest(
            schema_version="1",
            idempotency_key=data["idempotency_key"],
            repository=data["repository"],
            base_branch=data["base_branch"],
            original_pr_number=int(data["original_pr_number"]),
            original_head_sha=data["original_head_sha"],
            dependency_updates=updates,
            ci_run_id=int(ci["run_id"]),
            ci_workflow_name=ci["workflow_name"],
            policy=RepairPolicy.from_json(data["policy"]),
        )

    @staticmethod
    def parse(text: str) -> "RepairRequest":
        return RepairRequest.from_json(json.loads(text))

    def expected_idempotency_key(self) -> str:
        return idempotency_key(
            self.repository, self.original_pr_number, self.original_head_sha
        )


def idempotency_key(repository: str, pr_number: int, head_sha: str) -> str:
    return f"{repository}#{pr_number}@{head_sha}:{REPAIR_STRATEGY_VERSION}"


@dataclass
class RepairStatusReport:
    """Outcome reported by the worker back to the framework."""

    status: str
    idempotency_key: Optional[str] = None
    replacement_pr_number: Optional[int] = None
    attempt_count: int = 0
    reason: Optional[str] = None
    changed_application_files: list[str] = field(default_factory=list)

    def to_json(self) -> str:
        if self.status not in ALLOWED_OUTCOME_STATUSES:
            raise ContractError(f"unknown repair status: {self.status!r}")
        return json.dumps(
            {
                "schema_version": "1",
                "idempotency_key": self.idempotency_key,
                "status": self.status,
                "replacement_pr_number": self.replacement_pr_number,
                "attempt_count": self.attempt_count,
                "reason": self.reason,
                "changed_application_files": self.changed_application_files,
            },
            indent=2,
        )


def _require(data: dict[str, Any], keys: tuple[str, ...]) -> None:
    missing = [k for k in keys if k not in data]
    if missing:
        raise ContractError(f"missing required fields: {', '.join(missing)}")
