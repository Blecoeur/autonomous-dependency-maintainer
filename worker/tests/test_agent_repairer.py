import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))

from repair_worker.contracts import RepairRequest
from repair_worker.repairer import AgenticRepairer, ModelTurn, ToolCall
from repair_worker.sandbox import CommandResult

VALID_REQUEST = {
    "schema_version": "1",
    "idempotency_key": "owner/repo#10@abcdef123:repair-v1",
    "repository": "owner/repo",
    "base_branch": "main",
    "original_pr_number": 10,
    "original_head_sha": "abcdef123",
    "dependency_updates": [
        {"name": "multer", "from_version": "2.4.0", "to_version": "2.5.0", "update_type": "patch"}
    ],
    "commands": {"install": "true", "build": None, "test": "make test"},
    "ci": {"run_id": 123, "workflow_name": "CI", "conclusion": "failure"},
    "policy": {
        "max_attempts": 2,
        "allow_test_changes": False,
        "allow_ci_changes": False,
        "preserve_public_api": True,
        "max_changed_application_files": 10,
    },
}

APP_BROKEN = "export const handle = (req) => multer.legacyApi(req);\n"
APP_FIXED = "export const handle = (req) => multer.parseRequest(req);\n"


class FakeSandbox:
    """Minimal in-memory sandbox: verification passes once app.ts contains FIXED."""

    def __init__(self, already_passing: bool = False):
        self.repo_dir = pathlib.Path(tempfile.mkdtemp()) / "repo"
        (self.repo_dir / "src").mkdir(parents=True)
        (self.repo_dir / "src" / "app.ts").write_text(APP_FIXED if already_passing else APP_BROKEN)
        self.prepare_calls = 0
        self.commands_run: list[str] = []

    def prepare(self, install_command: str) -> None:
        self.prepare_calls += 1

    def run(self, command: str, timeout_seconds: int = 600) -> CommandResult:
        self.commands_run.append(command)
        content = (self.repo_dir / "src" / "app.ts").read_text()
        if "multer.parseRequest" in content:
            return CommandResult(0, "all good", "")
        return CommandResult(1, "TypeError: multer.legacyApi is not a function", "")

    def changed_files(self) -> list[str]:
        return ["src/app.ts"] if (self.repo_dir / "src" / "app.ts").read_text() == APP_FIXED else []

    def produce_patch(self) -> str:
        return "diff --git fake"

    def cleanup(self) -> None:
        pass


class ScriptedModel:
    """Replays a fixed sequence of turns; records the messages it saw."""

    def __init__(self, turns: list[ModelTurn]):
        self.turns = list(turns)
        self.seen_system: str | None = None
        self.seen_messages: list = []

    def turn(self, system, messages, tools):
        self.seen_system = system
        self.seen_messages = [dict(m) for m in messages]
        if not self.turns:
            raise AssertionError("scripted model exhausted")
        return self.turns.pop(0)


def make_repairer(sandbox: FakeSandbox, model: ScriptedModel) -> AgenticRepairer:
    return AgenticRepairer(RepairRequest.model_validate(VALID_REQUEST), sandbox, model)


def call(name: str, **arguments) -> ToolCall:
    return ToolCall(id=f"call-{name}", name=name, arguments=arguments)


class TestAgenticRepairer(unittest.TestCase):
    def test_happy_path_explores_edits_and_finishes(self):
        sandbox = FakeSandbox()
        model = ScriptedModel(
            [
                ModelTurn(content=None, tool_calls=[call("read_file", path="src/app.ts")]),
                ModelTurn(
                    content=None,
                    tool_calls=[
                        call(
                            "apply_edits",
                            edits=[{"path": "src/app.ts", "old_text": APP_BROKEN, "new_text": APP_FIXED}],
                        )
                    ],
                ),
                ModelTurn(
                    content=None,
                    tool_calls=[call("finish", status="pr_created", reason="API renamed in 2.5.0")],
                ),
            ]
        )
        report = make_repairer(sandbox, model).run()
        self.assertEqual(report.status, "pr_created")
        self.assertEqual(report.changed_application_files, ["src/app.ts"])
        self.assertEqual(report.attempt_count, 3)
        self.assertIn("Dependency repair skill", model.seen_system or "")
        self.assertIn("multer 2.4.0 -> 2.5.0", model.seen_messages[0]["content"])

    def test_not_reproducible_when_the_update_already_passes(self):
        sandbox = FakeSandbox(already_passing=True)
        model = ScriptedModel([])  # must never be called
        report = make_repairer(sandbox, model).run()
        self.assertEqual(report.status, "not_reproducible")

    def test_forbidden_edits_are_rejected_then_blocked(self):
        sandbox = FakeSandbox()
        model = ScriptedModel(
            [
                ModelTurn(
                    content=None,
                    tool_calls=[
                        call(
                            "apply_edits",
                            edits=[
                                {
                                    "path": ".github/workflows/ci.yml",
                                    "old_text": "run: pnpm test",
                                    "new_text": "run: true",
                                }
                            ],
                        )
                    ],
                ),
                ModelTurn(content=None, tool_calls=[call("finish", status="blocked", reason="cannot fix")]),
            ]
        )
        report = make_repairer(sandbox, model).run()
        self.assertEqual(report.status, "blocked")
        tool_results = [m for m in model.seen_messages if m.get("role") == "tool"]
        self.assertIn("REJECTED by the policy guard", tool_results[0]["content"])

    def test_manifest_weakening_edit_is_rejected(self):
        sandbox = FakeSandbox()
        (sandbox.repo_dir / "package.json").write_text('{"scripts": {"test": "make test"}}')
        model = ScriptedModel(
            [
                ModelTurn(
                    content=None,
                    tool_calls=[
                        call(
                            "apply_edits",
                            edits=[
                                {
                                    "path": "package.json",
                                    "old_text": '"test": "make test"',
                                    "new_text": '"test": "true"',
                                }
                            ],
                        )
                    ],
                ),
                ModelTurn(content=None, tool_calls=[call("finish", status="blocked", reason="cannot fix")]),
            ]
        )
        report = make_repairer(sandbox, model).run()
        self.assertEqual(report.status, "blocked")
        tool_results = [m for m in model.seen_messages if m.get("role") == "tool"]
        self.assertIn("protected manifest section", tool_results[0]["content"])
        # the manifest was not modified
        self.assertEqual(
            (sandbox.repo_dir / "package.json").read_text(),
            '{"scripts": {"test": "make test"}}',
        )

    def test_premature_success_claim_is_refused_then_blocked(self):
        sandbox = FakeSandbox()
        model = ScriptedModel(
            [
                ModelTurn(content=None, tool_calls=[call("finish", status="pr_created", reason="done")]),
                ModelTurn(content=None, tool_calls=[call("finish", status="blocked", reason="cannot fix")]),
            ]
        )
        report = make_repairer(sandbox, model).run()
        self.assertEqual(report.status, "blocked")
        tool_results = [m for m in model.seen_messages if m.get("role") == "tool"]
        self.assertIn("REFUSED", tool_results[0]["content"])

    def test_budget_exhaustion_when_never_finishing(self):
        sandbox = FakeSandbox()
        rounds = VALID_REQUEST["policy"]["max_attempts"] * 5 + 2
        model = ScriptedModel([ModelTurn(content=None, tool_calls=[call("read_file", path="src/app.ts")])] * rounds)
        report = make_repairer(sandbox, model).run()
        self.assertEqual(report.status, "budget_exceeded")

    def test_verification_command_comes_from_the_request(self):
        sandbox = FakeSandbox()
        model = ScriptedModel(
            [ModelTurn(content=None, tool_calls=[call("finish", status="blocked", reason="nope")])]
        )
        make_repairer(sandbox, model).run()
        self.assertIn("make test", sandbox.commands_run)


if __name__ == "__main__":
    unittest.main()
