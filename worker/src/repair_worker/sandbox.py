"""Ephemeral workspace for one repair attempt.

Security posture (spec 7.9):
- The worker only ever receives a READ-ONLY git token via environment
  (GITHUB_READ_TOKEN). It has NO GitHub write credentials: the patch it
  produces is pushed by the framework's privileged gateway, never by the
  worker.
- No Mistral or GitHub secrets are exposed to the repository's own scripts;
  the build/test commands run in this workspace with a minimal environment.
- Actual isolation (container, network policy) is the responsibility of the
  Mistral managed deployment hosting this worker; this module only keeps the
  credential surface minimal.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Optional

from .contracts import RepairRequest

BASE_ENV_KEYS = ("PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "GIT_TERMINAL_PROMPT")


class SandboxError(RuntimeError):
    pass


class RepairSandbox:
    def __init__(self, request: RepairRequest, workdir: Path, github_read_token: Optional[str] = None):
        self.request = request
        self.workdir = workdir
        self.github_read_token = github_read_token
        self.repo_dir = workdir / "repo"

    # -- lifecycle ---------------------------------------------------------

    def prepare(self, install_command: str) -> None:
        """Clones the PR head SHA and applies the dependency update to package.json."""
        self.workdir.mkdir(parents=True, exist_ok=True)
        url = f"https://github.com/{self.request.repository}.git"
        env = self._minimal_env()
        if self.github_read_token:
            env["GIT_ASKPASS"] = "/bin/true"
            url = url.replace("https://", f"https://x-access-token:{self.github_read_token}@")
        self._run(["git", "clone", "--quiet", "--depth", "1", "--branch",
                   # depth-1 clone of the head SHA: fetch by SHA needs a refspec
                   self.request.original_head_sha, url, str(self.repo_dir)], env=env, cwd=self.workdir)
        for update in self.request.dependency_updates:
            self._apply_update(update.name, update.to_version)
        self._run(install_command, env=env, cwd=self.repo_dir, shell=True)

    def cleanup(self) -> None:
        subprocess.run(["rm", "-rf", str(self.workdir)], check=False)

    # -- commands ----------------------------------------------------------

    def run(self, command: str, timeout_seconds: int = 600) -> "CommandResult":
        """Runs a repository command with a minimal environment (no secrets)."""
        return self._run(command, env=self._minimal_env(), cwd=self.repo_dir, shell=True,
                         timeout_seconds=timeout_seconds)

    def changed_files(self) -> list[str]:
        out = self._run(["git", "status", "--porcelain"], env=self._minimal_env(), cwd=self.repo_dir)
        paths: list[str] = []
        for line in out.stdout.splitlines():
            line = line.strip()
            if not line:
                continue
            status, _, path = line[0], line[0:2], line[3:] if len(line) > 2 else ""
            paths.append(path.strip())
        return [p for p in paths if p and status in ("M", "A", "D", "R", "C", "U")]

    def produce_patch(self) -> str:
        out = self._run(["git", "diff", "HEAD"], env=self._minimal_env(), cwd=self.repo_dir)
        return out.stdout

    # -- internals ---------------------------------------------------------

    def _apply_update(self, package_name: str, to_version: str) -> None:
        """Applies the dependency requirement bump, Dependabot-style."""
        manifest_path = self.repo_dir / "package.json"
        data = json.loads(manifest_path.read_text())
        for section in ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies"):
            section_data = data.get(section)
            if isinstance(section_data, dict) and package_name in section_data:
                current = section_data[package_name]
                if current.startswith("^"):
                    section_data[package_name] = f"^{to_version}"
                elif current.startswith("~"):
                    section_data[package_name] = f"~{to_version}"
                else:
                    section_data[package_name] = to_version
                break
        else:
            raise SandboxError(f"package {package_name} not found in any dependency section")
        manifest_path.write_text(json.dumps(data, indent=2) + "\n")
        # Refresh the lockfile for the new requirements.
        self._run("pnpm install --no-frozen-lockfile", env=self._minimal_env(),
                  cwd=self.repo_dir, shell=True)

    def _minimal_env(self) -> dict[str, str]:
        env = {k: os.environ[k] for k in BASE_ENV_KEYS if k in os.environ}
        env.setdefault("HOME", str(self.workdir / "home"))
        if self.github_read_token:
            # Only consumed by git for the clone; never exported to scripts.
            pass
        return env

    def _run(self, command, env: dict[str, str], cwd: Path, shell: bool = False,
             timeout_seconds: int = 1200) -> "CommandResult":
        result = subprocess.run(
            command,
            cwd=str(cwd),
            env=env,
            shell=shell,
            text=True,
            capture_output=True,
            timeout=timeout_seconds,
        )
        return CommandResult(returncode=result.returncode, stdout=result.stdout, stderr=result.stderr)


class CommandResult:
    def __init__(self, returncode: int, stdout: str, stderr: str):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr

    @property
    def ok(self) -> bool:
        return self.returncode == 0

    def tail(self, lines: int = 40) -> str:
        out = "\n".join(self.stdout.splitlines()[-lines:])
        err = "\n".join(self.stderr.splitlines()[-lines:])
        return (out + ("\n[stderr]\n" + err if err else "")).strip()
