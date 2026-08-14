# Releasing Time Keeper

`scripts/build-installer.ps1` and `scripts/release.ps1` are the canonical release
tools. They target Windows PowerShell 5.1 or newer; a shell wrapper would add no
portability because PyInstaller and Inno Setup must run on Windows.

The application, installer, updater, build script, and release script never
self-elevate or invoke `RunAs`. Installation is user-scope under
`%LOCALAPPDATA%\Programs\Time Keeper`, shortcuts are created only for the current
user, and installing an update does not request administrator credentials or a
UAC elevation. Installing the prerequisite developer tools is outside these
scripts and may be governed by the tool vendor's installer.

## Prerequisites

- Python 3.12 with the locked Pipenv dependencies installed.
- Node.js/npm.
- Inno Setup 6 (`ISCC.exe` on PATH, installed normally, or supplied with
  `-IsccPath` to the installer-build script).
- For publishing: Git, GitHub CLI, and `gh auth login` completed.

`VERSION` is used by source/development runs only. Packaged builds never read it
automatically. The release script retrieves the latest published stable release
from GitHub, displays it, and then prompts for the current version being
published. That entered version is injected into the executable's runtime
`VERSION` resource, Windows file metadata, installer metadata, filename, tag,
and GitHub release. If GitHub has no releases, it treats the run as the first
release.

If Python 3.12 is installed somewhere the script cannot auto-discover, pass its
executable with `-PythonPath`. Both `-PythonPath` and `-IsccPath` are forwarded
by `release.ps1` to the installer build.

## Build and test an installer

From the repository root:

```powershell
pipenv sync
.\scripts\build-installer.ps1
```

The installer build automatically prefers the interpreter returned by
`pipenv --py`, including when Pipenv stores it outside the repository. If a
different interpreter is required, select it explicitly with `-PythonPath`.

This runs the Python and JavaScript tests, builds frontend assets and a standard
PyInstaller one-directory application, then compiles that complete runtime into
the per-user Inno installer. PyInstaller discovers and packages its own Python
DLL; the build does not locate or inject one manually. It writes:

```text
Build\installer\Time-Keeper-Setup-<version>.exe
Build\installer\Time-Keeper-Setup-<version>.exe.sha256
```

The build runs the complete Python and JavaScript test suites. Any failure stops
the build. `-SkipTests` remains an explicit emergency/manual verification option
for local installer work and should not be used for a public release; the
release script deliberately provides no test-skipping option.

Before compilation, the script statically verifies that `installer.iss` still
uses `PrivilegesRequired=lowest`, LocalAppData, and current-user shortcuts and
contains no machine-scope paths or registry roots, privilege override, COM
registration, or `RunAs` directives.

Before the first public release, test in Windows Sandbox or a disposable VM:

1. Install the previous version, launch it, and create recognizable test data.
2. Leave Time Keeper running and launch the new installer. Confirm it closes the
   app, upgrades the same per-user installation, and can relaunch it.
3. Confirm `%LOCALAPPDATA%\TimeKeeper\clients.db` and `settings.json` survive.
4. Exercise startup/desktop shortcuts, reminders, the `timekeeper://` handler,
   and uninstall. Uninstall must not remove the user-data directory.
5. Independently compare `Get-FileHash -Algorithm SHA256` with the sidecar.

## Update cycle

Every packaged-app launch checks stable GitHub Releases in the background. If a
new release exists, a modal offers to download it, shows verification progress,
and then offers to open the installer and restart. The same controls remain on
the Settings page. A usable release must have a `v<version>` tag and these exact
assets:

- `Time-Keeper-Setup-<version>.exe`
- `Time-Keeper-Setup-<version>.exe.sha256`

The app ignores drafts and prereleases. It downloads the installer from the
expected repository, verifies its size and SHA-256 (GitHub's asset digest or the
sidecar), re-verifies immediately before launch, then opens Inno Setup and exits.
The stable Inno `AppId` makes that installation an upgrade rather than a second
product.

## Publish

Commit the version and all intended changes, then ensure `main` is clean. Run:

```powershell
.\scripts\release.ps1 -GenerateNotes
```

For non-interactive use, supply the current version explicitly:

```powershell
.\scripts\release.ps1 `
    -CurrentReleaseVersion 1.2.0 `
    -GenerateNotes
```

Use `-Notes "..."` or `-NotesFile .\notes.md` instead of `-GenerateNotes` for
curated notes. Add `-Draft` to create a draft release; drafts are not offered by
the updater.

The script verifies GitHub authentication, the expected origin repository, a
clean `main`, exact synchronization with freshly fetched `origin/main`, a
current version newer than the retrieved latest release, and absence of the new
tag locally and remotely. Generated notes start at the retrieved latest release
tag. After a successful build it rechecks repository state, creates and pushes
an annotated tag, then creates the GitHub release with both assets and
`--verify-tag`. It never edits, commits, or pushes a branch.

## Code-signing caveat

The current installer is unsigned. Windows SmartScreen may warn first-release
users until a trusted Authenticode signing process is added. Signing changes the
installer bytes, so signing must occur before the SHA-256 sidecar is generated
and before publishing. Do not sign an installer after its checksum or GitHub
release has been created. Add signing inside `build-installer.ps1`, immediately
before its checksum step, when a certificate is available.

## Recovery after a publish failure

- Before tag creation: fix the reported issue and rerun; nothing was published.
- Local tag created but push failed: inspect it with `git show vX.Y.Z`. Retry
  `git push origin refs/tags/vX.Y.Z`, or delete only the unpushed local tag with
  `git tag -d vX.Y.Z` after confirming the remote tag is absent.
- Tag pushed but `gh release create` failed: do not delete or recreate the tag.
  Complete the release manually with:

  ```powershell
  gh release create vX.Y.Z `
    Build\installer\Time-Keeper-Setup-X.Y.Z.exe `
    Build\installer\Time-Keeper-Setup-X.Y.Z.exe.sha256 `
    --repo Matthew-05/Time-Keeper --verify-tag `
    --title "Time Keeper vX.Y.Z" --generate-notes
  ```

- Release exists but an asset upload failed: inspect what arrived with
  `gh release view vX.Y.Z --repo Matthew-05/Time-Keeper --json assets`, verify the
  local checksum, then upload **only the missing asset** with
  `gh release upload vX.Y.Z <missing-file> --repo Matthew-05/Time-Keeper`.
  Do not use `--clobber` unless you have independently confirmed the remote
  asset is incomplete and the local bytes are the original release artifact.

Once a tag or installer has been published, never reuse that version for
different bytes. Correct it with a new patch release.
