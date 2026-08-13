import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class RepositoryHygieneTests(unittest.TestCase):
    def test_private_env_is_ignored_but_example_is_trackable(self):
        private = subprocess.run(
            ["git", "check-ignore", "--quiet", ".env"], cwd=ROOT
        )
        example = subprocess.run(
            ["git", "check-ignore", "--quiet", ".env.example"], cwd=ROOT
        )
        self.assertEqual(private.returncode, 0)
        self.assertNotEqual(example.returncode, 0)

    def test_usage_logger_has_no_hard_coded_endpoint_or_authorization(self):
        main_source = (ROOT / "main.py").read_text(encoding="utf-8")
        logger_source = (ROOT / "usage_logger.py").read_text(encoding="utf-8")
        self.assertNotIn("matthewcodes.xyz/api/project-usage", main_source)
        self.assertNotRegex(main_source, r"(?i)['\"]Authorization['\"]\s*:\s*['\"]")
        self.assertIn("TIMEKEEPER_USAGE_LOG_URL", logger_source)
        self.assertIn("TIMEKEEPER_USAGE_LOG_AUTHORIZATION", logger_source)

    def test_generated_repository_artifacts_are_ignored(self):
        ignored = (ROOT / ".gitignore").read_text(encoding="utf-8")
        for pattern in ("/Build/", "*.spec", "/version_info.txt", "/compiled_templates/"):
            self.assertIn(pattern, ignored)


if __name__ == "__main__":
    unittest.main()
