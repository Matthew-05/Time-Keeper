"""Build Time Keeper's console and windowed PyInstaller application folders."""

import argparse
import importlib
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent
VERSION_PATTERN = re.compile(r"^\d+\.\d+\.\d+$")
REQUIRED_BUILD_IMPORTS = {
    "PyInstaller": "pyinstaller",
    "alembic": "alembic",
    "flask": "flask",
    "flask_admin": "flask-admin",
    "flask_admin.contrib.sqla": "flask-admin",
    "flask_admin.theme": "flask-admin",
    "flask_cors": "flask-cors",
    "flask_migrate": "flask-migrate",
    "flask_sqlalchemy": "flask-sqlalchemy",
    "httpx": "httpx",
    "packaging": "packaging",
    "sqlalchemy": "sqlalchemy",
    "webview": "pywebview",
    "webview.window": "pywebview",
    "werkzeug": "werkzeug",
}


def assert_build_dependencies():
    """Fail before packaging when the selected interpreter cannot run the app."""
    failures = []
    for module, package in REQUIRED_BUILD_IMPORTS.items():
        try:
            importlib.import_module(module)
        except Exception as exc:
            failures.append((module, package, exc))

    if not failures:
        return

    packages = sorted({package for _, package, _ in failures})
    details = "; ".join(
        f"{module}: {type(exc).__name__}: {exc}"
        for module, _, exc in failures
    )
    raise SystemExit(
        "The selected Python interpreter is missing or cannot import required "
        f"build dependencies: {', '.join(packages)}. "
        f"Interpreter: {sys.executable}. Run 'pipenv sync' or install the locked "
        f"dependencies into that interpreter. Import failures: {details}"
    )


def read_version(version_override):
    """Return the validated version explicitly supplied for a packaged build."""
    version = version_override.strip() if version_override is not None else ""
    if not VERSION_PATTERN.fullmatch(version):
        raise SystemExit(f"Version must use x.y.z format (received {version!r}).")
    return version


def write_bundled_version(path, version):
    """Write the runtime VERSION resource injected into the frozen app."""
    validated_version = read_version(version)
    path.write_text(f"{validated_version}\n", encoding="utf-8")


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


def pyinstaller_arguments(version_info, bundled_version):
    return [
        "--noconfirm",
        "--clean",
        "--onedir",
        "--name=Time-Keeper",
        f"--icon={REPO_ROOT / 'icon.ico'}",
        f"--version-file={version_info}",
        f"--add-data={REPO_ROOT / 'templates'};templates",
        f"--add-data={REPO_ROOT / 'static'};static",
        f"--add-data={REPO_ROOT / 'migrations'};migrations",
        f"--add-data={REPO_ROOT / 'toast-icon.png'};.",
        f"--add-data={bundled_version};.",
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


def build_application(version_override):
    if sys.version_info[:2] != (3, 12):
        raise SystemExit(
            "This build must run under Python 3.12 "
            f"(found {sys.version_info.major}.{sys.version_info.minor})."
        )

    version = read_version(version_override)
    assert_build_dependencies()
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
    write_bundled_version(bundled_version, version)
    version_info = staging_dir / "version_info.txt"
    write_version_info(version_info, version)

    common_args = pyinstaller_arguments(version_info, bundled_version)
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

    console_exe = console_dir / "Time-Keeper" / "Time-Keeper.exe"
    windowed_exe = dist_dir / "Time-Keeper" / "Time-Keeper.exe"
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
        required=True,
        help="release version to embed in the executable (x.y.z)",
    )
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    try:
        build_application(args.version_override)
    except subprocess.CalledProcessError as exc:
        raise SystemExit(f"Build command failed with exit code {exc.returncode}.") from exc
