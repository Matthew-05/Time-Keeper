import re
import unittest
from pathlib import Path
from unittest.mock import patch

import build


ROOT = Path(__file__).resolve().parents[1]


class InstallerScopeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.config = (ROOT / "installer.iss").read_text(encoding="utf-8")

    def test_installer_is_current_user_without_elevation(self):
        self.assertRegex(self.config, r"(?m)^PrivilegesRequired=lowest\s*$")
        self.assertRegex(
            self.config,
            r"(?m)^DefaultDirName=\{localappdata\}\\Programs\\\{#MyAppName\}\s*$",
        )
        self.assertNotRegex(
            self.config,
            r"(?im)^PrivilegesRequired=(?:admin|poweruser)\s*$|\{autopf\}|\{common",
        )

    def test_shortcuts_are_current_user_only(self):
        for location in ("userprograms", "userdesktop", "userstartup"):
            self.assertIn(f'Name: "{{{location}}}\\{{#MyAppName}}";', self.config)


class ReleaseGuardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.script = (ROOT / "scripts" / "release.ps1").read_text(encoding="utf-8")

    def test_release_verifies_tag_and_repository_state(self):
        for guard in (
            "Assert-CleanWorktree",
            "Sync-OriginMain",
            "Assert-NoTag",
            "--verify-tag",
            "Matthew-05/Time-Keeper",
        ):
            self.assertIn(guard, self.script)

    def test_release_script_does_not_request_elevation(self):
        self.assertNotRegex(self.script, re.compile(r"\bRunAs\b", re.IGNORECASE))

    def test_release_gate_runs_complete_configured_suites(self):
        build_script = (ROOT / "scripts" / "build-installer.ps1").read_text(
            encoding="utf-8"
        )
        for full_suite_command in (
            '"-m", "unittest", "discover"',
            "npm.cmd test",
        ):
            self.assertIn(full_suite_command, build_script)
        self.assertNotIn("FullTests", build_script)
        self.assertNotIn("FullTests", self.script)

    def test_installer_build_prefers_the_locked_pipenv_interpreter(self):
        build_script = (ROOT / "scripts" / "build-installer.ps1").read_text(
            encoding="utf-8"
        )
        self.assertIn("Get-Command pipenv", build_script)
        self.assertIn("$pipenv.Source --py", build_script)
        self.assertIn('$ErrorActionPreference = "Continue"', build_script)
        self.assertIn("$pipenvExitCode = $LASTEXITCODE", build_script)


class PyInstallerConfigurationTests(unittest.TestCase):
    def test_build_stops_when_runtime_dependencies_are_missing(self):
        def import_module(name):
            if name == "flask":
                raise ModuleNotFoundError("No module named 'flask'")
            return object()

        with patch.object(build.importlib, "import_module", side_effect=import_module):
            with self.assertRaisesRegex(SystemExit, "flask.*pipenv sync"):
                build.assert_build_dependencies()

    def test_repository_assets_are_absolute_when_spec_lives_under_build(self):
        arguments = build.pyinstaller_arguments(
            Path("C:/Python312/python312.dll"),
            Path("C:/staging/version_info.txt"),
            Path("C:/staging/VERSION"),
        )
        for source in ("icon.ico", "templates", "static", "migrations", "toast-icon.png"):
            expected = str(ROOT / source)
            self.assertTrue(
                any(argument.startswith(("--icon=", "--add-data=")) and expected in argument
                    for argument in arguments),
                f"PyInstaller source path must be absolute: {source}",
            )


if __name__ == "__main__":
    unittest.main()
