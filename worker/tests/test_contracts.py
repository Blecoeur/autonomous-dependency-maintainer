import json
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))

import pydantic

from repair_worker.contracts import (
    RepairRequest,
    RepairStatusReport,
    idempotency_key,
)

VALID_REQUEST = {
    "schema_version": "1",
    "idempotency_key": "owner/repo#10@abcdef123:repair-v1",
    "repository": "owner/repo",
    "base_branch": "main",
    "original_pr_number": 10,
    "original_head_sha": "abcdef123",
    "dependency_updates": [
        {
            "name": "multer",
            "from_version": "2.4.0",
            "to_version": "2.5.0",
            "update_type": "patch",
        }
    ],
    "commands": {
        "install": "pnpm install --frozen-lockfile",
        "build": "pnpm build",
        "test": "pnpm test",
    },
    "ci": {"run_id": 123, "workflow_name": "CI", "conclusion": "failure"},
    "policy": {
        "max_attempts": 3,
        "allow_test_changes": False,
        "allow_ci_changes": False,
        "preserve_public_api": True,
        "max_changed_application_files": 10,
    },
}


class TestContracts(unittest.TestCase):
    def test_parses_a_valid_request(self):
        request = RepairRequest.model_validate(VALID_REQUEST)
        self.assertEqual(request.repository, "owner/repo")
        self.assertEqual(request.dependency_updates[0].name, "multer")
        self.assertEqual(request.commands.test, "pnpm test")

    def test_serializes_back_to_the_framework_schema(self):
        request = RepairRequest.model_validate(VALID_REQUEST)
        data = json.loads(request.model_dump_json())
        self.assertEqual(data["ci"]["conclusion"], "failure")
        self.assertEqual(data["policy"]["allow_test_changes"], False)
        self.assertEqual(data["commands"]["install"], "pnpm install --frozen-lockfile")

    def test_rejects_wrong_schema_version(self):
        payload = {**VALID_REQUEST, "schema_version": "2"}
        with self.assertRaises(pydantic.ValidationError):
            RepairRequest.model_validate(payload)

    def test_rejects_non_failure_ci(self):
        payload = json.loads(json.dumps(VALID_REQUEST))
        payload["ci"]["conclusion"] = "cancelled"
        with self.assertRaises(pydantic.ValidationError):
            RepairRequest.model_validate(payload)

    def test_rejects_requests_that_allow_test_changes(self):
        payload = json.loads(json.dumps(VALID_REQUEST))
        payload["policy"]["allow_test_changes"] = True
        with self.assertRaises(pydantic.ValidationError):
            RepairRequest.model_validate(payload)

    def test_rejects_updates_without_dependencies(self):
        payload = json.loads(json.dumps(VALID_REQUEST))
        payload["dependency_updates"] = []
        with self.assertRaises(pydantic.ValidationError):
            RepairRequest.model_validate(payload)

    def test_rejects_requests_without_a_test_command(self):
        payload = json.loads(json.dumps(VALID_REQUEST))
        payload["commands"]["test"] = None
        with self.assertRaises(pydantic.ValidationError):
            RepairRequest.model_validate(payload)

    def test_rejects_idempotency_key_mismatch(self):
        payload = json.loads(json.dumps(VALID_REQUEST))
        payload["original_pr_number"] = 11  # key still says #10
        with self.assertRaises(pydantic.ValidationError):
            RepairRequest.model_validate(payload)

    def test_rejects_malformed_keys(self):
        payload = json.loads(json.dumps(VALID_REQUEST))
        payload["idempotency_key"] = "not a valid key at all:repair-v1"
        with self.assertRaises(pydantic.ValidationError):
            RepairRequest.model_validate(payload)

    def test_idempotency_key_is_derivable(self):
        request = RepairRequest.model_validate(VALID_REQUEST)
        self.assertEqual(
            idempotency_key("owner/repo", 10, "abcdef123"),
            request.idempotency_key,
        )


class TestStatusReport(unittest.TestCase):
    def test_serializes_allowed_statuses(self):
        report = RepairStatusReport(
            status="pr_created",
            idempotency_key="k",
            replacement_pr_number=31,
            attempt_count=2,
            changed_application_files=["src/a.ts"],
        )
        data = json.loads(report.model_dump_json())
        self.assertEqual(data["status"], "pr_created")
        self.assertEqual(data["replacement_pr_number"], 31)

    def test_rejects_unknown_statuses(self):
        with self.assertRaises(pydantic.ValidationError):
            RepairStatusReport(status="everything_is_fine")


if __name__ == "__main__":
    unittest.main()
