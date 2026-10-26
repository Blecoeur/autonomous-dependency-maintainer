import json
import unittest

from repair_worker.contracts import (
    ContractError,
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
        request = RepairRequest.from_json(VALID_REQUEST)
        self.assertEqual(request.repository, "owner/repo")
        self.assertEqual(request.dependency_updates[0].name, "multer")

    def test_rejects_wrong_schema_version(self):
        payload = {**VALID_REQUEST, "schema_version": "2"}
        with self.assertRaises(ContractError):
            RepairRequest.from_json(payload)

    def test_rejects_non_failure_ci(self):
        payload = json.loads(json.dumps(VALID_REQUEST))
        payload["ci"]["conclusion"] = "cancelled"
        with self.assertRaises(ContractError):
            RepairRequest.from_json(payload)

    def test_rejects_requests_that_allow_test_changes(self):
        payload = json.loads(json.dumps(VALID_REQUEST))
        payload["policy"]["allow_test_changes"] = True
        with self.assertRaises(ContractError):
            RepairRequest.from_json(payload)

    def test_rejects_updates_without_dependencies(self):
        payload = json.loads(json.dumps(VALID_REQUEST))
        payload["dependency_updates"] = []
        with self.assertRaises(ContractError):
            RepairRequest.from_json(payload)

    def test_idempotency_key_is_derivable(self):
        request = RepairRequest.from_json(VALID_REQUEST)
        self.assertEqual(
            request.expected_idempotency_key(),
            idempotency_key("owner/repo", 10, "abcdef123"),
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
        data = json.loads(report.to_json())
        self.assertEqual(data["status"], "pr_created")
        self.assertEqual(data["replacement_pr_number"], 31)

    def test_rejects_unknown_statuses(self):
        with self.assertRaises(ContractError):
            RepairStatusReport(status="everything_is_fine").to_json()


if __name__ == "__main__":
    unittest.main()
