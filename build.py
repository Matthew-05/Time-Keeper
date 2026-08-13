"""Build Time Keeper's console and windowed PyInstaller executables."""

import argparse
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent
DEFAULT_VERSION_FILE = REPO_ROOT / "VERSION"
VERSION_PATTERN = re.compile(r"^\d+\.\d+\.\d+$")


def read_version(version_override=None):
    """Return the validated release version, optionally supplied by automation."""
    version = (
        version_override.strip()
        if version_override is not None
        else DEFAULT_VERSION_FILE.read_text(encoding="utf-8").strip()
    )
    if not VERSION_PATTERN.fullmatch(version):
        raise SystemExit(f"Version must use x.y.z format (received {version!r}).")
    return version


def write_version_info(path, version):
    version_parts = version.split(".") + ["0"]
    path.write_text(
        f"""# UTF-8
VSVersionInfo(
  ffi=FixedFileInfo(
    filevers=({','.join(version_parts)}),
    prodvers=({','.join(version_parts)}),
    mask=0x3f,
    flags=0x0,
    OS=0x40004,
    fileType=0x1,
    subtype=0x0,
    date=(0, 0)
  ),
  kids=[
    StringFileInfo([
      StringTable(
        u'040904B0',
        [StringStruct(u'FileVersion', u'{version}'),
         StringStruct(u'ProductVersion', u'{version}'),
         StringStruct(u'ProductName', u'Time Keeper'),
         StringStruct(u'CompanyName', u'Matthew Codes')])
      ]),
    VarFileInfo([VarStruct(u'Translation', [1033, 1200])])
  ]
)
""",
        encoding="utf-8",
    )


def build_frontend():
    """Rebuild all offline frontend assets from the lock file."""
    npm = shutil.which("npm")
    if not npm:
        raise SystemExit("npm was not found on PATH; install Node.js before building.")

    print("Building frontend assets ...", flush=True)
    subprocess.run(
        [npm, "ci", "--no-audit", "--no-fund"],
        cwd=REPO_ROOT,
        check=True,
        shell=os.name == "nt",
    )
    subprocess.run(
        [npm, "run", "build"],
        cwd=REPO_ROOT,
        check=True,
        shell=os.name == "nt",
    )


def pyinstaller_arguments(python_dll, version_info, bundled_version):
    return [
        "--noconfirm",
        "--clean",
        "--onefile",
        "--name=Time-Keeper",
        f"--icon={REPO_ROOT / 'icon.ico'}",
        f"--version-file={version_info}",
        f"--add-data={REPO_ROOT / 'templates'};templates",
        f"--add-data={REPO_ROOT / 'static'};static",
        f"--add-data={REPO_ROOT / 'migrations'};migrations",
        f"--add-data={REPO_ROOT / 'toast-icon.png'};.",
        f"--add-data={bundled_version};.",
        f"--add-binary={python_dll};.",
        "--hidden-import=flask_sqlalchemy",
        "--hidden-import=flask",
        "--hidden-import=webview",
        "--hidden-import=flask_migrate",
        "--hidden-import=flask_admin",
        "--hidden-import=flask_cors",
        "--hidden-import=sqlalchemy",
        "--hidden-import=werkzeug",
        "--hidden-import=alembic",
        "--collect-submodules=flask_sqlalchemy",
        "--collect-submodules=flask",
        "--collect-submodules=sqlalchemy",
        "--collect-submodules=flask_migrate",
        "--collect-submodules=alembic",
        "--hidden-import=webview.platforms.winforms",
        "--hidden-import=clr",
        "--hidden-import=webview.window",
        "--hidden-import=sqlite3",
        "--hidden-import=winotify",
        "--hidden-import=winreg",
        "--hidden-import=packaging",
        "--hidden-import=sqlalchemy.ext.declarative",
        "--hidden-import=sqlalchemy.orm",
        "--hidden-import=sqlalchemy.dialects.sqlite",
        "--hidden-import=sqlalchemy.sql.default_comparator",
        "--hidden-import=sqlalchemy.event",
        "--hidden-import=sqlalchemy.pool",
        "--hidden-import=flask_sqlalchemy.model",
        "--hidden-import=flask_sqlalchemy.extension",
        "--hidden-import=flask_migrate.cli",
        "--hidden-import=flask_migrate.templates",
        "--hidden-import=sqlalchemy.dialects.sqlite.pysqlite",
        "--hidden-import=sqlalchemy.engine.result",
        "--hidden-import=sqlalchemy.sql.functions",
        "--hidden-import=sqlalchemy.sql.schema",
        "--hidden-import=sqlalchemy.dialects.sqlite.base",
        "--hidden-import=alembic.runtime.migration",
        "--hidden-import=alembic.context",
        "--hidden-import=alembic.script",
        "--hidden-import=alembic.ddl",
    ]


def run_pyinstaller(common_args, mode, dist_path, work_path, spec_path):
    command = [
        sys.executable,
        "-m",
        "PyInstaller",
        *common_args,
        f"--{mode}",
        f"--distpath={dist_path}",
        f"--workpath={work_path}",
        f"--specpath={spec_path}",
        str(REPO_ROOT / "main.py"),
    ]
    print(f"Building {mode} executable ...", flush=True)
    subprocess.run(command, cwd=REPO_ROOT, check=True)


def build_application(version_override=None):
    if sys.version_info[:2] != (3, 12):
        raise SystemExit(
            "This build must run under Python 3.12 "
            f"(found {sys.version_info.major}.{sys.version_info.minor})."
        )

    version = read_version(version_override)
    python_dll = Path(sys.base_prefix) / "python312.dll"
    if not python_dll.is_file():
        raise SystemExit(
            f"Python DLL not found at {python_dll}; install a complete Python 3.12 runtime."
        )

    print(f"Building Time Keeper {version}", flush=True)
    build_frontend()

    build_root = REPO_ROOT / "Build"
    if build_root.exists():
        shutil.rmtree(build_root)

    staging_dir = build_root / "staging"
    spec_dir = build_root / "spec"
    staging_dir.mkdir(parents=True)
    spec_dir.mkdir(parents=True)

    bundled_version = staging_dir / "VERSION"
    bundled_version.write_text(f"{version}\n", encoding="utf-8")
    version_info = staging_dir / "version_info.txt"
    write_version_info(version_info, version)

    common_args = pyinstaller_arguments(python_dll, version_info, bundled_version)
    console_dir = build_root / "Console"
    dist_dir = build_root / "dist"
    run_pyinstaller(
        common_args,
        "console",
        console_dir,
        build_root / "work" / "console",
        spec_dir,
    )
    run_pyinstaller(
        common_args,
        "windowed",
        dist_dir,
        build_root / "work" / "windowed",
        spec_dir,
    )

    console_exe = console_dir / "Time-Keeper.exe"
    windowed_exe = dist_dir / "Time-Keeper.exe"
    missing = [str(path) for path in (console_exe, windowed_exe) if not path.is_file()]
    if missing:
        raise SystemExit(f"Build completed without expected output(s): {', '.join(missing)}")

    print("Build complete.")
    print(f"  Version:  {version}")
    print(f"  Console:  {console_exe}")
    print(f"  Windowed: {windowed_exe}")
    return windowed_exe


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--version",
        dest="version_override",
        help="release version to embed (x.y.z); defaults to the tracked VERSION file",
    )
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    try:
        build_application(args.version_override)
    except subprocess.CalledProcessError as exc:
        raise SystemExit(f"Build command failed with exit code {exc.returncode}.") from exc
