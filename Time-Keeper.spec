# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_submodules

hiddenimports = ['flask_sqlalchemy', 'flask', 'webview', 'flask_migrate', 'flask_admin', 'flask_cors', 'sqlalchemy', 'werkzeug', 'alembic', 'webview.platforms.winforms', 'clr', 'webview.window', 'sqlite3', 'sqlalchemy.ext.declarative', 'sqlalchemy.orm', 'sqlalchemy.dialects.sqlite', 'sqlalchemy.sql.default_comparator', 'sqlalchemy.event', 'sqlalchemy.pool', 'flask_sqlalchemy.model', 'flask_sqlalchemy.extension', 'flask_migrate.cli', 'flask_migrate.templates', 'sqlalchemy.dialects.sqlite.pysqlite', 'sqlalchemy.engine.result', 'sqlalchemy.sql.functions', 'sqlalchemy.sql.schema', 'sqlalchemy.dialects.sqlite.base', 'alembic.runtime.migration', 'alembic.context', 'alembic.script', 'alembic.ddl']
hiddenimports += collect_submodules('flask_sqlalchemy')
hiddenimports += collect_submodules('flask')
hiddenimports += collect_submodules('sqlalchemy')
hiddenimports += collect_submodules('flask_migrate')
hiddenimports += collect_submodules('alembic')


a = Analysis(
    ['main.py'],
    pathex=[],
    binaries=[('C:\\Users\\Matthew\\AppData\\Local\\Programs\\Python\\Python312\\python312.dll', '.')],
    datas=[('templates', 'templates'), ('static', 'static'), ('migrations', 'migrations')],
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='Time-Keeper',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    version='version_info.txt',
    icon=['icon.ico'],
)
