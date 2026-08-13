#Requires -Version 5.1
<#
.SYNOPSIS
    Build, tag, and publish a Time Keeper release to GitHub.

.DESCRIPTION
    This script is intentionally strict. It only releases an unchanged main
    commit that exactly matches origin/main and the tracked VERSION file.

.EXAMPLE
    .\scripts\release.ps1 -Version 1.3.0 -GenerateNotes
    .\scripts\release.ps1 -Version 1.3.0 -NotesFile .\release-notes.md -Draft
#>
param(
    [string]$Version = "",
    [string]$PythonPath = "",
    [string]$IsccPath = "",
    [string]$Notes = "",
    [string]$NotesFile = "",
    [switch]$GenerateNotes,
    [switch]$Draft
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path $PSScriptRoot -Parent
$VersionFile = Join-Path $RepoRoot "VERSION"
$BuildScript = Join-Path $PSScriptRoot "build-installer.ps1"
$ExpectedRepo = "Matthew-05/Time-Keeper"

function Fail([string]$Message) {
    throw "[release] $Message"
}

function Step([string]$Label) {
    Write-Host ""
    Write-Host "==> $Label" -ForegroundColor Cyan
}

function Assert-CleanWorktree {
    $status = & git status --porcelain --untracked-files=normal
    if ($LASTEXITCODE -ne 0) { Fail "Could not inspect the Git worktree." }
    if ($status) {
        $detail = $status -join [Environment]::NewLine
        Fail "The worktree is not clean. Commit or stash every change before releasing:`n$detail"
    }
}

function Assert-NoTag([string]$Tag) {
    & git show-ref --verify --quiet "refs/tags/$Tag"
    if ($LASTEXITCODE -eq 0) { Fail "Local tag $Tag already exists." }
    if ($LASTEXITCODE -ne 1) { Fail "Could not inspect local tag $Tag." }

    $remoteTag = & git ls-remote --tags origin "refs/tags/$Tag" 2>$null
    if ($LASTEXITCODE -ne 0) { Fail "Could not inspect tags on origin." }
    if ($remoteTag) { Fail "Remote tag $Tag already exists on origin." }
}

function Sync-OriginMain {
    & git fetch --prune origin "+refs/heads/main:refs/remotes/origin/main"
    if ($LASTEXITCODE -ne 0) { Fail "Could not fetch origin/main." }

    $head = (& git rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0) { Fail "Could not resolve HEAD." }
    $originMain = (& git rev-parse refs/remotes/origin/main).Trim()
    if ($LASTEXITCODE -ne 0) { Fail "Could not resolve origin/main after fetching." }
    if ($head -ne $originMain) {
        Fail "Local main is not exactly synced with origin/main. Local: $head; origin/main: $originMain"
    }
}

if (-not (Test-Path -LiteralPath $VersionFile -PathType Leaf)) {
    Fail "VERSION file not found at $VersionFile."
}
if (-not $Version) {
    $Version = (Get-Content -Raw -LiteralPath $VersionFile).Trim()
    Write-Host "Using the tracked VERSION value: $Version" -ForegroundColor DarkGray
}
if ($Version -notmatch '^\d+\.\d+\.\d+$') {
    Fail "Version must use x.y.z format (received '$Version')."
}

$notesOptions = 0
if ($PSBoundParameters.ContainsKey("Notes")) { $notesOptions++ }
if ($PSBoundParameters.ContainsKey("NotesFile")) { $notesOptions++ }
if ($GenerateNotes) { $notesOptions++ }
if ($notesOptions -gt 1) {
    Fail "Use only one of -Notes, -NotesFile, or -GenerateNotes."
}
if ($PSBoundParameters.ContainsKey("Notes") -and -not $Notes.Trim()) {
    Fail "-Notes cannot be empty. Omit it to use generated notes."
}

$resolvedNotesFile = $null
if ($PSBoundParameters.ContainsKey("NotesFile")) {
    if (-not (Test-Path -LiteralPath $NotesFile -PathType Leaf)) {
        Fail "Release notes file not found at '$NotesFile'."
    }
    $resolvedNotesFile = (Resolve-Path -LiteralPath $NotesFile).Path
}

$Tag = "v$Version"
$Artifact = Join-Path $RepoRoot "Build\installer\Time-Keeper-Setup-$Version.exe"
$Checksum = "$Artifact.sha256"
$tagCreated = $false
$tagPushed = $false

Push-Location $RepoRoot
try {
    Step "Checking release prerequisites"
    if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) {
        Fail "Git was not found on PATH."
    }
    if (-not (Get-Command gh.exe -ErrorAction SilentlyContinue)) {
        Fail "GitHub CLI (gh) was not found. Install it from https://cli.github.com/."
    }

    & gh auth status --hostname github.com
    if ($LASTEXITCODE -ne 0) { Fail "GitHub CLI is not authenticated. Run 'gh auth login'." }

    $branch = (& git branch --show-current).Trim()
    if ($LASTEXITCODE -ne 0 -or $branch -ne "main") {
        Fail "Releases must be created from main (current branch: '$branch')."
    }
    Assert-CleanWorktree

    $originUrl = (& git remote get-url origin).Trim()
    if ($LASTEXITCODE -ne 0) { Fail "Git remote 'origin' is not configured." }
    if ($originUrl -notmatch '(?i)^(https://github\.com/|git@github\.com:|ssh://git@github\.com/)Matthew-05/Time-Keeper(?:\.git)?/?$') {
        Fail "origin points to '$originUrl', not the expected GitHub repository $ExpectedRepo."
    }

    & git ls-files --error-unmatch -- VERSION 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "VERSION must be tracked by Git before releasing." }
    $committedVersion = ((& git show "HEAD:VERSION") | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { Fail "Could not read VERSION from HEAD." }
    $workingVersion = (Get-Content -Raw -LiteralPath $VersionFile).Trim()
    if ($workingVersion -ne $Version -or $committedVersion -ne $Version) {
        Fail "Release version $Version must exactly match both the working and committed VERSION values (working '$workingVersion', committed '$committedVersion')."
    }

    Step "Fetching and verifying origin/main"
    Sync-OriginMain
    Assert-NoTag $Tag

    Step "Building installer and checksum"
    $buildArguments = @(
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", $BuildScript, "-Version", $Version
    )
    if ($PythonPath) { $buildArguments += @("-PythonPath", $PythonPath) }
    if ($IsccPath) { $buildArguments += @("-IsccPath", $IsccPath) }
    & powershell.exe @buildArguments
    if ($LASTEXITCODE -ne 0) { Fail "build-installer.ps1 failed with exit code $LASTEXITCODE." }

    if (-not (Test-Path -LiteralPath $Artifact -PathType Leaf)) {
        Fail "Expected installer not found at $Artifact."
    }
    if (-not (Test-Path -LiteralPath $Checksum -PathType Leaf)) {
        Fail "Expected checksum not found at $Checksum."
    }
    $actualHash = (Get-FileHash -LiteralPath $Artifact -Algorithm SHA256).Hash.ToLowerInvariant()
    $checksumLine = (Get-Content -Raw -LiteralPath $Checksum).Trim()
    $expectedLine = "$actualHash  $([IO.Path]::GetFileName($Artifact))"
    if ($checksumLine -cne $expectedLine) {
        Fail "Checksum sidecar does not exactly match the installer."
    }

    # Building may regenerate tracked frontend assets. Never tag those changes
    # accidentally, and re-fetch after the long build to close the race where
    # main or the tag changed while packaging was in progress.
    Assert-CleanWorktree
    Step "Rechecking remote state before publishing"
    Sync-OriginMain
    Assert-NoTag $Tag

    Step "Creating annotated tag $Tag"
    & git tag --annotate $Tag --message "Time Keeper $Version"
    if ($LASTEXITCODE -ne 0) { Fail "Could not create annotated tag $Tag." }
    $tagCreated = $true

    Step "Pushing tag $Tag"
    & git push origin "refs/tags/$Tag"
    if ($LASTEXITCODE -ne 0) { Fail "Could not push tag $Tag." }
    $tagPushed = $true

    Step "Creating GitHub release $Tag"
    $releaseArguments = @(
        "release", "create", $Tag, $Artifact, $Checksum,
        "--repo", $ExpectedRepo,
        "--verify-tag",
        "--title", "Time Keeper $Tag"
    )
    if ($Draft) { $releaseArguments += "--draft" }
    if ($PSBoundParameters.ContainsKey("Notes")) {
        $releaseArguments += @("--notes", $Notes)
    } elseif ($resolvedNotesFile) {
        $releaseArguments += @("--notes-file", $resolvedNotesFile)
    } else {
        $releaseArguments += "--generate-notes"
    }

    $releaseUrl = & gh @releaseArguments
    if ($LASTEXITCODE -ne 0) { Fail "GitHub release creation failed." }

    Write-Host ""
    Write-Host "Release published successfully." -ForegroundColor Green
    Write-Host "  Version : $Version" -ForegroundColor Green
    Write-Host "  Tag     : $Tag" -ForegroundColor Green
    Write-Host "  Release : $releaseUrl" -ForegroundColor Green
} catch {
    Write-Host ""
    Write-Host "Release stopped: $($_.Exception.Message)" -ForegroundColor Red
    if ($tagPushed) {
        Write-Host "The tag was already pushed. Do not rerun this script or reuse the version." -ForegroundColor Yellow
        Write-Host "Complete the GitHub release manually; see docs\RELEASING.md." -ForegroundColor Yellow
    } elseif ($tagCreated) {
        Write-Host "The annotated tag exists only locally. Inspect it before deciding whether to delete or retry its push." -ForegroundColor Yellow
    } else {
        Write-Host "No release tag was created." -ForegroundColor DarkGray
    }
    throw
} finally {
    Pop-Location
}
