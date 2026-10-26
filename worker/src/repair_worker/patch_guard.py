"""Worker-side patch guard (defense in depth).

The AUTHORITATIVE enforcement lives in the framework's policy engine, applied
by the trusted gateway before any replacement PR is opened. This module is the
worker's own pre-flight check: an agent-produced patch that touches protected
paths is rejected here and reported as `blocked` instead of ever reaching the
gateway. Mirrors the default forbidden paths and protected manifest keys.
"""

from __future__ import annotations

import fnmatch
import json
import re
from dataclasses import dataclass

DEFAULT_FORBIDDEN_PATHS = (
    ".github/**",
    ".maintenance.yml",
    "CODEOWNERS",
    "**/*.test.*",
    "**/*.spec.*",
    "**/__tests__/**",
    "**/__snapshots__/**",
    "**/*.snap",
)

PROTECTED_MANIFEST_KEYS = ("scripts", "lint-staged", "husky", "simple-git-hooks", "pre-commit")


@dataclass(frozen=True)
class GuardResult:
    allowed: bool
    violations: tuple[str, ...]

    @property
    def summary(self) -> str:
        return "; ".join(self.violations)


def path_is_forbidden(path: str, forbidden_paths: tuple[str, ...] = DEFAULT_FORBIDDEN_PATHS) -> bool:
    """fnmatch-based mirror of the framework's picomatch globs."""
    for pattern in forbidden_paths:
        # '**/' prefix collapses to '' in fnmatch terms: match at any depth.
        if pattern.startswith("**/"):
            if fnmatch.fnmatch(path, pattern[3:]):
                return True
        # 'dir/**' protects everything under dir (including dir itself).
        if pattern.endswith("/**"):
            prefix = pattern[:-3]
            if path == prefix or path.startswith(prefix + "/"):
                return True
        if fnmatch.fnmatch(path, pattern):
            return True
    return False


def manifest_protected_sections_changed(before: str, after: str) -> list[str]:
    """Compares package.json snapshots; returns the changed protected keys.

    Invalid JSON counts as a violation: the guard never guesses.
    """
    try:
        before_json = json.loads(before)
        after_json = json.loads(after)
    except (json.JSONDecodeError, TypeError):
        return ["<unparseable manifest>"]
    if not isinstance(before_json, dict) or not isinstance(after_json, dict):
        return ["<manifest is not an object>"]
    changed: list[str] = []
    for key in PROTECTED_MANIFEST_KEYS:
        if _stable(before_json.get(key)) != _stable(after_json.get(key)):
            changed.append(f"package.json#{key}")
    return changed


def manifest_edit_violations(path: str, current: str, old_text: str, new_text: str) -> list[str]:
    """Checks a single in-place edit of a manifest for protected-section drift.

    Returns violations when the edit would change any protected key of a
    package.json (scripts, lint-staged, husky, ...). Unparseable results on
    either side are violations: the guard never guesses.
    """
    if not path.endswith("package.json"):
        return []
    if old_text not in current:
        return [f"edit anchor not found in {path}"]
    candidate = current.replace(old_text, new_text, 1)
    return [
        f"protected manifest section: {path}#{k}"
        for k in manifest_protected_sections_changed(current, candidate)
    ]


def check_patch(
    changed_paths: list[str],
    manifests_before_after: dict[str, tuple[str | None, str | None]] | None = None,
    forbidden_paths: tuple[str, ...] = DEFAULT_FORBIDDEN_PATHS,
) -> GuardResult:
    """Validates the set of files an agent wants to change."""
    violations: list[str] = []
    for path in changed_paths:
        if path_is_forbidden(path, forbidden_paths):
            violations.append(f"forbidden path: {path}")
    if manifests_before_after:
        for path, (before, after) in manifests_before_after.items():
            if before is None or after is None:
                violations.append(f"manifest added/removed: {path}")
            else:
                for changed in manifest_protected_sections_changed(before, after):
                    violations.append(f"protected manifest section: {changed}")
    if not violations:
        # Guard against path traversal or absolute escapes in produced patches.
        for path in changed_paths:
            if path.startswith("/") or ".." in path.split("/") or re.search(r"\s", path):
                violations.append(f"suspicious path: {path}")
    return GuardResult(allowed=not violations, violations=tuple(violations))


def _stable(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))
