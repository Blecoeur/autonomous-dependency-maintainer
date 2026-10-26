"""Worker entry point for Mistral Workflows.

Receives a framework RepairRequest (JSON on stdin or REPAIR_REQUEST_FILE),
runs the deterministic reproduction + agent repair loop, and prints a
RepairStatusReport JSON on stdout. The patch is written to a file named by
PATCH_OUTPUT_PATH for the trusted gateway to pick up; the worker itself has
no GitHub write credentials.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from .contracts import ContractError, RepairRequest, RepairStatusReport
from .mistral_client import MistralModelClient
from .repairer import Repairer
from .sandbox import RepairSandbox


def handle(request_payload: str, workdir: Path, model_client=None) -> RepairStatusReport:
    request = RepairRequest.parse(request_payload)
    if request.idempotency_key != request.expected_idempotency_key():
        return RepairStatusReport(
            status="internal_error",
            idempotency_key=request.idempotency_key,
            reason="idempotency key does not match the request fields; refusing",
        )
    sandbox = RepairSandbox(
        request,
        workdir=workdir,
        github_read_token=os.environ.get("GITHUB_READ_TOKEN"),
    )
    try:
        model = model_client or MistralModelClient()
        repairer = Repairer(request, sandbox, model=model)
        return repairer.run()
    except ContractError as err:
        return RepairStatusReport(
            status="internal_error",
            idempotency_key=request.idempotency_key,
            reason=f"contract violation: {err}",
        )
    except Exception as err:  # noqa: BLE001 - reported, never crashes the deployment
        return RepairStatusReport(
            status="internal_error",
            idempotency_key=request.idempotency_key,
            reason=f"{type(err).__name__}: {err}",
        )
    finally:
        sandbox.cleanup()


def main() -> int:
    payload_path = os.environ.get("REPAIR_REQUEST_FILE")
    payload = (
        Path(payload_path).read_text() if payload_path else sys.stdin.read()
    )
    workdir = Path(os.environ.get("REPAIR_WORKDIR", "/tmp/repair-workdir"))
    report = handle(payload, workdir)

    patch_path = os.environ.get("PATCH_OUTPUT_PATH")
    if patch_path and report.status == "pr_created":
        # The gateway validates this patch with the framework policy engine
        # before opening any replacement PR; the worker never pushes.
        Path(patch_path).write_text(_patch_file_payload(report))

    print(report.to_json())
    return 0


def _patch_file_payload(report: RepairStatusReport) -> str:
    return json.dumps(
        {
            "idempotency_key": report.idempotency_key,
            "changed_application_files": report.changed_application_files,
            "note": "sandbox patch data is embedded by the deployment wrapper",
        },
        indent=2,
    )


if __name__ == "__main__":
    sys.exit(main())
