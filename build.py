import os
import subprocess
import shutil
import sys

VERSION = "1.2.0"  # Match the version in main.py

def ensure_build_directories():
    build_dirs = ['Build/Console', 'Build/dist']
    for dir in build_dirs:
        os.makedirs(dir, exist_ok=True)

def update_version_in_files():
    version_parts = VERSION.split('.')
    while len(version_parts) < 4:
        version_parts.append('0')
    
    version_info = f"""# UTF-8
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
        [StringStruct(u'FileVersion', u'{VERSION}'),
         StringStruct(u'ProductVersion', u'{VERSION}'),
         StringStruct(u'ProductName', u'Time Keeper'),
         StringStruct(u'CompanyName', u'Matthew Codes')])
      ]),
    VarFileInfo([VarStruct(u'Translation', [1033, 1200])])
  ]
)"""
    with open('version_info.txt', 'w') as f:
        f.write(version_info)

def build_application():
    if sys.version_info[:2] != (3, 12):
        raise SystemExit(
            f"This build must run under Python 3.12 (found {sys.version_info.major}.{sys.version_info.minor}). "
            "Use `py -3.12 build.py` or activate a 3.12 venv."
        )

    input('Check you have updated the main.py version number and press enter to continue')
    input('Check you have updated the build.py version number and press enter to continue')
    input('Check you have set DEV_MODE in .env to False and press enter to continue')

    python_dll = os.path.join(
        sys.base_prefix,
        f"python{sys.version_info.major}{sys.version_info.minor}.dll",
    )
    if not os.path.isfile(python_dll):
        raise SystemExit(f"Python DLL not found at {python_dll!r}; install Python 3.12 or fix base_prefix.")

    if os.path.exists('Build'):
        shutil.rmtree('Build')
    ensure_build_directories()

    update_version_in_files()

    # Common PyInstaller arguments (--onefile: single .exe, no _internal folder)
    common_args = [
        '--noconfirm',
        '--onefile',
        '--name=Time-Keeper',
        '--icon=icon.ico',
        '--version-file=version_info.txt',
        '--add-data=templates;templates',
        '--add-data=static;static',
        '--add-data=migrations;migrations',
        f'--add-binary={python_dll};.',
        # Explicitly include all required modules
        '--hidden-import=flask_sqlalchemy',
        '--hidden-import=flask',
        '--hidden-import=webview',
        '--hidden-import=flask_migrate',
        '--hidden-import=flask_admin',
        '--hidden-import=flask_cors',
        '--hidden-import=sqlalchemy',
        '--hidden-import=werkzeug',
        '--hidden-import=alembic',
        # Include all submodules
        '--collect-submodules=flask_sqlalchemy',
        '--collect-submodules=flask',
        '--collect-submodules=sqlalchemy',
        '--collect-submodules=flask_migrate',
        '--collect-submodules=alembic',
        '--hidden-import=webview.platforms.winforms',
        '--hidden-import=clr',
        '--hidden-import=webview.window',
        '--hidden-import=sqlite3',
    ]

    # Add specific imports for SQLAlchemy components
    sqlalchemy_imports = [
        '--hidden-import=sqlalchemy.ext.declarative',
        '--hidden-import=sqlalchemy.orm',
        '--hidden-import=sqlalchemy.dialects.sqlite',
        '--hidden-import=sqlalchemy.sql.default_comparator',
        '--hidden-import=sqlalchemy.event',
        '--hidden-import=sqlalchemy.pool',
    ]
    
    # Add specific imports for Flask-SQLAlchemy components
    flask_sqlalchemy_imports = [
        '--hidden-import=flask_sqlalchemy.model',
        '--hidden-import=flask_sqlalchemy.extension',
    ]
    
    # Add specific imports for Flask-Migrate components
    flask_migrate_imports = [
        '--hidden-import=flask_migrate.cli',
        '--hidden-import=flask_migrate.templates',
        '--hidden-import=sqlalchemy.dialects.sqlite.pysqlite',
        '--hidden-import=sqlalchemy.engine.result',
        '--hidden-import=sqlalchemy.sql.functions',
        '--hidden-import=sqlalchemy.sql.schema',
        '--hidden-import=sqlalchemy.dialects.sqlite.base',
    ]
    
    # Add specific imports for Alembic components
    alembic_imports = [
        '--hidden-import=alembic.runtime.migration',
        '--hidden-import=alembic.context',
        '--hidden-import=alembic.script',
        '--hidden-import=alembic.ddl',
    ]

    # Combine all arguments
    all_args = common_args + sqlalchemy_imports + flask_sqlalchemy_imports + flask_migrate_imports + alembic_imports

    # Build console version (useful for debugging)
    console_result = subprocess.run([
        'pyinstaller',
        *all_args,
        '--console',
        '--distpath=Build/Console',
        'main.py'
    ])

    # Build windowed version
    windowed_result = subprocess.run([
        'pyinstaller',
        *all_args,
        '--windowed',
        '--distpath=Build/dist',
        'main.py'
    ])

    if console_result.returncode != 0:
        raise SystemExit("Console build failed (see PyInstaller output above).")
    if windowed_result.returncode != 0:
        raise SystemExit("Windowed build failed (see PyInstaller output above).")

    console_exe = os.path.abspath("Build/Console/Time-Keeper.exe")
    windowed_exe = os.path.abspath("Build/dist/Time-Keeper.exe")
    if not os.path.isfile(console_exe) or not os.path.isfile(windowed_exe):
        raise SystemExit("Build reported success but expected .exe output was missing.")
    print("Build complete.")
    print(f"  Console:  {console_exe}")
    print(f"  Windowed: {windowed_exe}")


if __name__ == '__main__':
    build_application()
