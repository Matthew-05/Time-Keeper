#Requires -Version 5.1
<#
.SYNOPSIS
    Build, tag, and publish a Time Keeper release to GitHub.

.DESCRIPTION
    This script is intentionally strict. It only releases an unchanged main
    commit that exactly matches origin/main. The latest published stable release
    is read from GitHub, while the new version is entered by the user or supplied
    explicitly; VERSION is never used as a default.

.EXAMPLE
    .\scripts\release.ps1 -GenerateNotes
    .\scripts\release.ps1 -CurrentReleaseVersion 1.3.0 -GenerateNotes
    .\scripts\release.ps1 -CurrentReleaseVersion 1.3.0 -NotesFile .\release-notes.md -Draft
#>
param(
    [Alias("Version")]
    [string]$CurrentReleaseVersion = "",
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

function Get-LatestPublishedReleaseVersion {
    # Avoid PowerShell 5.1 promoting native stderr to a terminating error. The
    # exit code is still checked, so GitHub/network failures cannot be ignored.
    $previousErrorActionPreference = $ErrorActionPreference
    $releaseOutput = @()
    $releaseExitCode = 1
    try {
        $ErrorActionPreference = "Continue"
        $releaseOutput = @(& gh release list `
            --repo $ExpectedRepo `
            --exclude-drafts `
            --exclude-pre-releases `
            --limit 1 `
            --json tagName 2>$null)
        $releaseExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($releaseExitCode -ne 0) {
        Fail "Could not retrieve the latest published release from GitHub."
    }

    $releaseJson = ($releaseOutput | Out-String).Trim()
    if (-not $releaseJson -or $releaseJson -eq "[]") { return $null }
    try {
        $release = $releaseJson | ConvertFrom-Json
        $tag = @($release)[0].tagName
    } catch {
        Fail "GitHub returned unreadable release metadata."
    }
    if ($tag -notmatch '^v?(\d+\.\d+\.\d+)$') {
        Fail "Latest published release tag '$tag' does not use vX.Y.Z format."
    }
    return $Matches[1]
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

$LatestReleaseVersion = $null
$LatestTag = $null
$Tag = $null
$Artifact = $null
$Checksum = $null
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

    Step "Fetching and verifying origin/main"
    Sync-OriginMain

    $LatestReleaseVersion = Get-LatestPublishedReleaseVersion
    if ($LatestReleaseVersion) {
        $LatestTag = "v$LatestReleaseVersion"
        Write-Host "  Latest published release: $LatestTag" -ForegroundColor DarkGray
    } else {
        Write-Host "  Latest published release: none (first release)" -ForegroundColor DarkGray
    }
    if (-not $CurrentReleaseVersion) {
        $CurrentReleaseVersion = (Read-Host "Current release version to publish (x.y.z)").Trim()
    }
    if ($CurrentReleaseVersion -notmatch '^\d+\.\d+\.\d+$') {
        Fail "Current release version must use x.y.z format (received '$CurrentReleaseVersion')."
    }
    if (
        $LatestReleaseVersion -and
        [version]$CurrentReleaseVersion -le [version]$LatestReleaseVersion
    ) {
        Fail "Current release version $CurrentReleaseVersion must be newer than latest release version $LatestReleaseVersion."
    }

    $Tag = "v$CurrentReleaseVersion"
    $Artifact = Join-Path $RepoRoot "Build\installer\Time-Keeper-Setup-$CurrentReleaseVersion.exe"
    $Checksum = "$Artifact.sha256"
    Assert-NoTag $Tag

    Step "Building installer and checksum"
    $buildArguments = @(
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", $BuildScript, "-Version", $CurrentReleaseVersion
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
    $latestReleaseAtPublish = Get-LatestPublishedReleaseVersion
    if ($latestReleaseAtPublish -ne $LatestReleaseVersion) {
        Fail "The latest GitHub release changed during the build. Start the release again."
    }
    Assert-NoTag $Tag

    Step "Creating annotated tag $Tag"
    & git tag --annotate $Tag --message "Time Keeper $CurrentReleaseVersion"
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
        if ($LatestTag) {
            $releaseArguments += @("--notes-start-tag", $LatestTag)
        }
    }

    $releaseUrl = & gh @releaseArguments
    if ($LASTEXITCODE -ne 0) { Fail "GitHub release creation failed." }

    Write-Host ""
    Write-Host "Release published successfully." -ForegroundColor Green
    Write-Host "  Version : $CurrentReleaseVersion" -ForegroundColor Green
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
