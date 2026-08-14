import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from app_version import read_app_version
from build import read_version, write_bundled_version


class AppVersionTests(unittest.TestCase):
    def test_source_runtime_uses_tracked_version(self):
        expected = Path("VERSION").read_text(encoding="utf-8").strip()
        self.assertEqual(read_app_version(), expected)

    def test_runtime_rejects_malformed_version_resource(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "VERSION"
            path.write_text("release-candidate\n", encoding="utf-8")
            with self.assertRaises(RuntimeError):
                read_app_version(path)

    def test_build_accepts_injected_semantic_version(self):
        self.assertEqual(read_version("2.3.4"), "2.3.4")

    def test_build_requires_an_injected_version(self):
        with self.assertRaises(SystemExit):
            read_version(None)

    def test_dist_runtime_resource_uses_injected_version(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "VERSION"
            write_bundled_version(path, "8.7.6")
            self.assertEqual(read_app_version(path), "8.7.6")

    def test_build_rejects_injected_non_release_version(self):
        with self.assertRaises(SystemExit):
            read_version("2.3")


if __name__ == "__main__":
    unittest.main()
