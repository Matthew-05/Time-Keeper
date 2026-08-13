"""Canonical application-version loader.

Source runs read the tracked ``VERSION`` file beside this module. Release builds
bundle a generated ``VERSION`` resource, allowing the build script to inject a
version without rewriting application source files.
"""

import re
import sys
from pathlib import Path


VERSION_PATTERN = re.compile(r"^\d+\.\d+\.\d+$")


def version_file_path():
    """Return the version resource used by this source or frozen build."""
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent)) / "VERSION"
    return Path(__file__).with_name("VERSION")


def read_app_version(path=None):
    """Read and validate an ``x.y.z`` application version."""
    version_path = Path(path) if path is not None else version_file_path()
    version = version_path.read_text(encoding="utf-8").strip()
    if not VERSION_PATTERN.fullmatch(version):
        raise RuntimeError(
            f"Invalid application version {version!r} in {version_path}; expected x.y.z"
        )
    return version


APP_VERSION = read_app_version()
