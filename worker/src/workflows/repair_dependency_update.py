"""repair_dependency_update — the Mistral Workflows repair workflow.

Structure per the Mistral Workflows model:
- the WORKFLOW class is deterministic orchestration (guard, then delegate);
- the ACTIVITY holds the real work: sandbox, reproduction, model loop.

The whole repair runs inside ONE activity on purpose: the sandbox is a
filesystem on the executing worker, and activities may run on any worker of
the deployment — state that must flow between steps goes through the
serialized activity result, not the worker's disk. Platform retries resume
the activity as a unit.
"""

from __future__ import annotations

import mistralai.workflows as workflows
from pydantic import BaseModel

from repair_worker.contracts import RepairRequest, RepairStatusReport, idempotency_key
from repair_worker.mistral_client import MistralModelClient
from repair_worker.repairer import AgenticRepairer
from repair_worker.sandbox import RepairSandbox


@workflows.activity()
async def run_repair(request: RepairRequest) -> RepairStatusReport:
    """One repair attempt: clone, reproduce, loop with the model, verify.

    Side effects live here (spec 7.2): the workflow never touches the
    network or the repository itself.
    """
    import os

    from pathlib import Path

    workdir = Path(os.environ.get("REPAIR_WORKDIR", "/tmp/repair-workdir"))
    sandbox = RepairSandbox(
        request,
        workdir=workdir / request.idempotency_key.replace("/", "_"),
        github_read_token=os.environ.get("GITHUB_READ_TOKEN"),
    )
    try:
        model = MistralModelClient()
        repairer = AgenticRepairer(request, sandbox, model=model)
        return repairer.run()
    except Exception as err:  # noqa: BLE001 - reported, never crashes the worker
        return RepairStatusReport(
            status="internal_error",
            idempotency_key=request.idempotency_key,
            reason=f"{type(err).__name__}: {err}",
        )
    finally:
        sandbox.cleanup()


@workflows.workflow.define(
    name="repair_dependency_update",
    workflow_display_name="Repair dependency update",
    workflow_description=(
        "Takes a framework RepairRequest for a CI-red dependency update, "
        "reproduces the failure deterministically, produces a guarded "
        "compatibility patch with a Mistral model, and returns a "
        "RepairStatusReport. Never touches tests, CI workflows or policy "
        "files; never opens PRs (the framework gateway does that)."
    ),
)
class RepairDependencyUpdateWorkflow:
    @workflows.workflow.entrypoint
    async def run(self, input: RepairRequest) -> RepairStatusReport:
        # Deterministic guard: the pydantic contract already refuses
        # idempotency-key mismatches; keep an explicit, auditable check
        # before any side effect.
        expected = idempotency_key(
            input.repository, input.original_pr_number, input.original_head_sha
        )
        if input.idempotency_key != expected:
            return RepairStatusReport(
                status="internal_error",
                idempotency_key=input.idempotency_key,
                reason="idempotency key does not match the request fields; refusing",
            )
        return await run_repair(input)
