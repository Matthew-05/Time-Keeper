import os
import subprocess
import shutil
import site

VERSION = "1.0.0"  # Match the version in main.py

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
    input('Check you have updated the main.py version number and press enter to continue')
    input('Check you have updated the build.py version number and press enter to continue')
    input('Check you have set DEV_MODE in .env to False and press enter to continue')
    
    # Path to Inno Setup compiler - update this path if needed
    iscc_path = r"C:/Program Files (x86)/Inno Setup 6/ISCC.exe"
    
    # Path to Python DLL - update this path to match your Python installation
    python_dll = r"C:/Program Files/Python313/python313.dll"

    if os.path.exists('Build'):
        shutil.rmtree('Build')
    ensure_build_directories()

    update_version_in_files()

    # Common PyInstaller arguments
    common_args = [
        '--noconfirm',
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

    # Only create installer if builds succeeded
    if windowed_result.returncode == 0 and os.path.exists('Build/dist/Time-Keeper'):
        # Create or update installer.iss file
        create_installer_script()
        
        # Run Inno Setup compiler
        subprocess.run([
            iscc_path,
            '/O"Build/dist"',
            'installer.iss'
        ])

def create_installer_script():
    """Create the Inno Setup script file for Time-Keeper"""
    inno_script = f"""
#define MyAppName "Time Keeper"
#define MyAppVersion "{VERSION}"
#define MyAppPublisher "Matthew Codes"
#define MyAppExeName "Time-Keeper.exe"

[Setup]
AppId={{{{F8E24CA1-1A41-4F94-9A37-78D7C145A77E}}}}
AppName={{#MyAppName}}
AppVersion={{#MyAppVersion}}
AppPublisher={{#MyAppPublisher}}
DefaultDirName={{autopf}}\\{{#MyAppName}}
DisableProgramGroupPage=yes
OutputDir=Build\\dist
OutputBaseFilename=Time-Keeper-Setup-{VERSION}
Compression=lzma
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{{cm:CreateDesktopIcon}}"; GroupDescription: "{{cm:AdditionalIcons}}"
Name: "startupicon"; Description: "Start at system startup"; GroupDescription: "{{cm:AdditionalIcons}}"

[Files]
Source: "Build\\dist\\Time-Keeper\\*"; DestDir: "{{app}}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{{autoprograms}}\\{{#MyAppName}}"; Filename: "{{app}}\\{{#MyAppExeName}}"
Name: "{{autodesktop}}\\{{#MyAppName}}"; Filename: "{{app}}\\{{#MyAppExeName}}"; Tasks: desktopicon
Name: "{{commonstartup}}\\{{#MyAppName}}"; Filename: "{{app}}\\{{#MyAppExeName}}"; Tasks: startupicon

[Run]
Filename: "{{app}}\\{{#MyAppExeName}}"; Description: "{{cm:LaunchProgram,{{#StringChange(MyAppName, '&', '&&')}}}}"; Flags: nowait postinstall skipifsilent
"""
    with open('installer.iss', 'w') as f:
        f.write(inno_script)

if __name__ == '__main__':
    build_application()
