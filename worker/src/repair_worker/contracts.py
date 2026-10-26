"""Framework-owned repair contracts (schema version 1), pydantic edition.

Mirrors src/providers/repair/types.ts of the autonomous-dependency-maintainer
framework. pydantic is required by the Mistral Workflows SDK anyway; the
contract validation (idempotency key, never-allow test/CI changes) lives in
model validators so it applies on every deserialization, not just at one
call site.
"""

from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

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

UpdateType = Literal["major", "minor", "patch"]


class ContractError(ValueError):
    """Raised when a payload does not satisfy the repair contract."""


class DependencyUpdate(BaseModel):
    name: str
    from_version: str
    to_version: str
    update_type: UpdateType


class CiFacts(BaseModel):
    run_id: int
    workflow_name: str
    conclusion: Literal["failure"]


class RepairPolicy(BaseModel):
    max_attempts: int = Field(ge=1, le=10)
    allow_test_changes: Literal[False]
    allow_ci_changes: Literal[False]
    preserve_public_api: bool
    max_changed_application_files: int = Field(ge=1, le=100)


class RepairCommands(BaseModel):
    """Verification commands from the consumer's .maintenance.yml.

    `test` is the required oracle: a repair without verification is never
    accepted. Commands come from the trusted base-branch configuration,
    never from PR content.
    """

    install: str | None = None
    build: str | None = None
    test: str


class RepairRequest(BaseModel):
    schema_version: Literal["1"]
    idempotency_key: str
    repository: str
    base_branch: str
    original_pr_number: int
    original_head_sha: str
    dependency_updates: list[DependencyUpdate] = Field(min_length=1)
    commands: RepairCommands
    ci: CiFacts
    policy: RepairPolicy

    @field_validator("idempotency_key")
    @classmethod
    def _key_shape(cls, value: str) -> str:
        if not re.fullmatch(r"[^@#\s]+#\d+@[0-9a-f]{7,40}:repair-v1", value):
            raise ContractError(f"idempotency key does not match repo#pr@sha:{REPAIR_STRATEGY_VERSION}: {value!r}")
        return value

    @model_validator(mode="after")
    def _key_matches_fields(self) -> "RepairRequest":
        expected = idempotency_key(self.repository, self.original_pr_number, self.original_head_sha)
        if self.idempotency_key != expected:
            raise ContractError(
                f"idempotency key mismatch: got {self.idempotency_key!r}, fields imply {expected!r}"
            )
        return self


class RepairStatusReport(BaseModel):
    """Outcome reported by the worker back to the framework."""

    status: Literal[
        "pr_created",
        "blocked",
        "not_reproducible",
        "transient_failure",
        "budget_exceeded",
        "stale_original_pr",
        "internal_error",
    ]
    idempotency_key: str | None = None
    replacement_pr_number: int | None = None
    attempt_count: int = 0
    reason: str | None = None
    changed_application_files: list[str] = Field(default_factory=list)


def idempotency_key(repository: str, pr_number: int, head_sha: str) -> str:
    return f"{repository}#{pr_number}@{head_sha}:{REPAIR_STRATEGY_VERSION}"
