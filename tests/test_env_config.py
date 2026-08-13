import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from env_config import load_env_file


class EnvironmentFileTests(unittest.TestCase):
    def test_loads_assignments_and_preserves_existing_environment(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / ".env"
            path.write_text(
                "# private settings\n"
                "TIMEKEEPER_TEST_VALUE='from file'\n"
                "export TIMEKEEPER_TEST_SECOND=second\n",
                encoding="utf-8",
            )
            with patch.dict(
                os.environ,
                {"TIMEKEEPER_TEST_VALUE": "from process"},
                clear=False,
            ):
                os.environ.pop("TIMEKEEPER_TEST_SECOND", None)
                self.assertEqual(load_env_file(path), path)
                self.assertEqual(os.environ["TIMEKEEPER_TEST_VALUE"], "from process")
                self.assertEqual(os.environ["TIMEKEEPER_TEST_SECOND"], "second")
                os.environ.pop("TIMEKEEPER_TEST_SECOND", None)

    def test_missing_file_is_optional(self):
        with TemporaryDirectory() as directory:
            self.assertIsNone(load_env_file(Path(directory) / "missing.env"))

    def test_rejects_malformed_assignment(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / ".env"
            path.write_text("not an assignment\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "Invalid environment assignment"):
                load_env_file(path)


if __name__ == "__main__":
    unittest.main()
