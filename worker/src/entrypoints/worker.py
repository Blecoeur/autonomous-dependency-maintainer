"""Worker entrypoint (Mistral Workflows).

Starts the worker process that connects to the Mistral Workflows platform
and registers the repair workflow. Environment:

- MISTRAL_API_KEY  — workspace API key (which deployment/workspace)
- DEPLOYMENT_NAME  — the named worker group that receives executions
- GITHUB_READ_TOKEN — read-only GitHub token used inside the sandbox
  activity for the clone; NEVER a write credential
- REPAIR_WORKDIR   — scratch space for sandboxes (default /tmp/repair-workdir)

The worker runs until stopped; any other worker with the same deployment
name and workflow set is interchangeable (stateless, platform-routed).
"""

from __future__ import annotations

import asyncio

import mistralai.workflows as workflows

from repair_worker.contracts import RepairRequest  # noqa: F401  (registers the input model)
from workflows.repair_dependency_update import RepairDependencyUpdateWorkflow


async def main() -> None:
    await workflows.run_worker([RepairDependencyUpdateWorkflow])


if __name__ == "__main__":
    asyncio.run(main())
