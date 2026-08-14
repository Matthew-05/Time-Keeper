# Time Keeper

Time Keeper is a Windows desktop time-tracking application built with Flask,
pywebview/WebView2, SQLite, and PyInstaller. User data lives under
`%LOCALAPPDATA%\TimeKeeper`; installing or upgrading the application does not
replace that data.

## Development

The project requires Python 3.12 and Node.js. Install the locked dependencies,
build the offline frontend assets, and run the source application:

```powershell
pipenv sync
npm ci
npm run build
pipenv run python main.py
```

Run the automated checks with:

```powershell
pipenv run python -m unittest discover -s tests -p "test_*.py"
npm test
```

## Installer and releases

PowerShell is the canonical Windows build and release interface:

```powershell
.\scripts\build-installer.ps1
.\scripts\release.ps1 -GenerateNotes
```

These commands run the complete Python and JavaScript test suites, including
the versioning, installer-scope, updater-security, and publishing safeguards.
Any failure stops the build before an artifact or tag is published.

The build produces a per-user installer and SHA-256 sidecar under
`Build\installer`. See [docs/RELEASING.md](docs/RELEASING.md) for prerequisites,
upgrade testing, signing considerations, publishing safeguards, and recovery.
Installation and application-driven updates remain entirely in the current
user's profile and do not request administrator credentials or a UAC elevation.

## Private configuration

Usage logging is opt-in and its endpoint and authorization value are never kept
in source. Copy `.env.example` to `.env` for a source checkout. An installed
build reads `%LOCALAPPDATA%\TimeKeeper\.env` instead. Environment variables set
by the process take precedence over the file.

Do not distribute a privileged shared credential with the desktop installer.
Anything available to a desktop process can ultimately be inspected by that
computer's user. See [docs/SECRETS.md](docs/SECRETS.md) for configuration,
credential rotation, and the repository-history cleanup procedure.
