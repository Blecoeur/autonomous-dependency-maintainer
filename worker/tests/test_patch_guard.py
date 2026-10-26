import unittest

from repair_worker.patch_guard import (
    check_patch,
    manifest_protected_sections_changed,
    path_is_forbidden,
)

PKG_BEFORE = json_dump = '{"name":"x","scripts":{"test":"vitest run","build":"tsc"},"dependencies":{"multer":"^2.4.0"}}'
PKG_AFTER_DEPENDENCY = '{"name":"x","scripts":{"test":"vitest run","build":"tsc"},"dependencies":{"multer":"^2.5.0"}}'
PKG_AFTER_WEAKENED = '{"name":"x","scripts":{"test":"echo ok","build":"tsc"},"dependencies":{"multer":"^2.5.0"}}'


class TestPathGuard(unittest.TestCase):
    def test_blocks_workflows_and_policy(self):
        for path in (
            ".github/workflows/ci.yml",
            ".github/dependabot.yml",
            ".maintenance.yml",
            "CODEOWNERS",
        ):
            self.assertTrue(path_is_forbidden(path), path)

    def test_blocks_test_files(self):
        for path in (
            "src/app.test.ts",
            "packages/server/src/api.spec.js",
            "src/__tests__/thing.ts",
            "src/__snapshots__/x.snap",
        ):
            self.assertTrue(path_is_forbidden(path), path)

    def test_allows_application_code(self):
        for path in ("src/app.ts", "packages/server/src/routes.ts", "README.md"):
            self.assertFalse(path_is_forbidden(path), path)


class TestManifestGuard(unittest.TestCase):
    def test_dependency_change_passes(self):
        changed = manifest_protected_sections_changed(PKG_BEFORE, PKG_AFTER_DEPENDENCY)
        self.assertEqual(changed, [])

    def test_weakened_test_script_is_detected(self):
        changed = manifest_protected_sections_changed(PKG_BEFORE, PKG_AFTER_WEAKENED)
        self.assertEqual(changed, ["package.json#scripts"])

    def test_unparseable_manifest_is_a_violation(self):
        changed = manifest_protected_sections_changed("not json", PKG_BEFORE)
        self.assertEqual(changed, ["<unparseable manifest>"])


class TestCheckPatch(unittest.TestCase):
    def test_accepts_a_clean_application_patch(self):
        result = check_patch(["src/routes.ts", "src/types.d.ts"])
        self.assertTrue(result.allowed)

    def test_rejects_forbidden_paths(self):
        result = check_patch(["src/routes.ts", ".github/workflows/ci.yml"])
        self.assertFalse(result.allowed)
        self.assertTrue(any("forbidden path" in v for v in result.violations))

    def test_rejects_manifest_weakening(self):
        result = check_patch(
            ["package.json"],
            manifests_before_after={"package.json": (PKG_BEFORE, PKG_AFTER_WEAKENED)},
        )
        self.assertFalse(result.allowed)
        self.assertTrue(any("scripts" in v for v in result.violations))

    def test_rejects_suspicious_paths(self):
        result = check_patch(["/etc/passwd"])
        self.assertFalse(result.allowed)
        result = check_patch(["../../outside.ts"])
        self.assertFalse(result.allowed)


if __name__ == "__main__":
    unittest.main()
