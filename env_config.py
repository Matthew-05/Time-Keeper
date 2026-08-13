"""Small, dependency-free loader for Time Keeper's private environment file."""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path


_ENV_KEY = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def default_env_path() -> Path:
    """Return the source or installed-app environment file location."""
    override = os.environ.get("TIMEKEEPER_ENV_FILE")
    if override:
        return Path(override).expanduser()
    if getattr(sys, "frozen", False):
        local_app_data = Path(
            os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local")
        )
        return local_app_data / "TimeKeeper" / ".env"
    return Path(__file__).resolve().with_name(".env")


def _parse_value(raw_value: str) -> str:
    value = raw_value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
        value = value[1:-1]
    return value


def load_env_file(path: str | os.PathLike | None = None) -> Path | None:
    """Load missing variables from ``.env`` without overriding the process.

    Only simple ``NAME=value`` assignments are supported. Existing process
    variables always win, which keeps CI and release environments predictable.
    """
    env_path = Path(path) if path is not None else default_env_path()
    try:
        lines = env_path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return None

    for line_number, raw_line in enumerate(lines, start=1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        if "=" not in line:
            raise ValueError(f"Invalid environment assignment at {env_path}:{line_number}")
        key, raw_value = line.split("=", 1)
        key = key.strip()
        if not _ENV_KEY.fullmatch(key):
            raise ValueError(f"Invalid environment key at {env_path}:{line_number}")
        os.environ.setdefault(key, _parse_value(raw_value))
    return env_path
