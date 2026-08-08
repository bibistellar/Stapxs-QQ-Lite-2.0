import json
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
VALIDATE_SCOPE = ROOT / "scripts/ai-pr/validate-change-scope.py"
VALIDATE_REVIEW = ROOT / "scripts/ai-pr/validate-review.py"
REVIEW_SCHEMA = ROOT / ".github/ai-pr/review.schema.json"


class ChangeScopeTests(unittest.TestCase):
    def run_validator(self, patch: str) -> subprocess.CompletedProcess[str]:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8") as handle:
            handle.write(patch)
            handle.flush()
            return subprocess.run(
                [str(VALIDATE_SCOPE), handle.name],
                check=False,
                capture_output=True,
                text=True,
            )

    def test_accepts_bounded_text_change(self) -> None:
        result = self.run_validator(
            "--- baseline/docs/example.md\n"
            "+++ work/docs/example.md\n"
            "@@ -1 +1 @@\n"
            "-old\n"
            "+new\n"
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_rejects_workflow_change(self) -> None:
        result = self.run_validator(
            "--- baseline/.github/workflows/ci.yml\n"
            "+++ work/.github/workflows/ci.yml\n"
            "@@ -1 +1 @@\n"
            "-old\n"
            "+new\n"
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("protected paths", result.stderr)

    def test_rejects_secret_manifest(self) -> None:
        result = self.run_validator(
            "--- baseline/manifests/app/secrets.yaml\n"
            "+++ work/manifests/app/secrets.yaml\n"
            "@@ -1 +1 @@\n"
            "-old\n"
            "+new\n"
        )
        self.assertNotEqual(result.returncode, 0)


class ReviewTests(unittest.TestCase):
    def test_schema_declares_every_property_type(self) -> None:
        schema = json.loads(REVIEW_SCHEMA.read_text(encoding="utf-8"))
        self.assertEqual(set(schema["required"]), set(schema["properties"]))
        for name, definition in schema["properties"].items():
            self.assertIn("type", definition, name)

    def run_validator(self, payload: dict, sha: str) -> subprocess.CompletedProcess[str]:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8") as handle:
            json.dump(payload, handle)
            handle.flush()
            return subprocess.run(
                [str(VALIDATE_REVIEW), handle.name, sha],
                check=False,
                capture_output=True,
                text=True,
            )

    def test_accepts_matching_approval(self) -> None:
        sha = "a" * 40
        result = self.run_validator(
            {
                "schema_version": 1,
                "head_sha": sha,
                "verdict": "approve",
                "blocking_findings": [],
                "summary": "The focused change satisfies the issue.",
                "confidence": 0.9,
            },
            sha,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_rejects_stale_sha(self) -> None:
        result = self.run_validator(
            {
                "schema_version": 1,
                "head_sha": "a" * 40,
                "verdict": "approve",
                "blocking_findings": [],
                "summary": "Looks good.",
                "confidence": 0.8,
            },
            "b" * 40,
        )
        self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
