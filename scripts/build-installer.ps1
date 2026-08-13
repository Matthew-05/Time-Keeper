#Requires -Version 5.1
<#
.SYNOPSIS
    Build Time Keeper and produce a versioned per-user installer and checksum.

.EXAMPLE
    .\scripts\build-installer.ps1
    .\scripts\build-installer.ps1 -Version 1.3.0
    .\scripts\build-installer.ps1 -Version 1.3.0 -SkipTests
#>
param(
    [string]$Version = "",
    [string]$PythonPath = "",
    [string]$IsccPath = "",
    [switch]$SkipTests
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path $PSScriptRoot -Parent
$VersionFile = Join-Path $RepoRoot "VERSION"
$InstallerScript = Join-Path $RepoRoot "installer.iss"

function Fail([string]$Message) {
    throw "[build-installer] $Message"
}

function Step([string]$Label) {
    Write-Host ""
    Write-Host "==> $Label" -ForegroundColor Cyan
}

function Assert-PerUserInstallerConfig {
    $config = Get-Content -Raw -LiteralPath $InstallerScript
    $requiredLines = @(
        '(?m)^PrivilegesRequired=lowest\s*$',
        '(?m)^DefaultDirName=\{localappdata\}\\Programs\\\{#MyAppName\}\s*$',
        '(?m)^Name: "\{userprograms\}\\\{#MyAppName\}";',
        '(?m)^Name: "\{userdesktop\}\\\{#MyAppName\}";',
        '(?m)^Name: "\{userstartup\}\\\{#MyAppName\}";'
    )
    foreach ($required in $requiredLines) {
        if ($config -notmatch $required) {
            Fail "installer.iss no longer satisfies the required per-user, no-elevation configuration."
        }
    }

    $forbidden = @(
        '(?im)^PrivilegesRequired=(?:admin|poweruser)\s*$',
        '(?im)^PrivilegesRequiredOverridesAllowed\s*=',
        '\{(?:auto)?pf(?:32|64)?\}',
        '\{(?:win|sys|sysnative)\}',
        '\{common(?:appdata|desktop|programs|startup)\}',
        '(?im)^Root:\s*(?:HKLM|HKCR|HKU)\b',
        '(?i)\bregserver\b',
        '(?i)runas'
    )
    foreach ($pattern in $forbidden) {
        if ($config -match $pattern) {
            Fail "installer.iss contains a machine-scope or elevation directive ('$($Matches[0])')."
        }
    }
}

function Find-Python312([string]$RequestedPath) {
    if ($RequestedPath) {
        if (-not (Test-Path -LiteralPath $RequestedPath -PathType Leaf)) {
            Fail "Python was not found at '$RequestedPath'."
        }
        $resolved = (Resolve-Path -LiteralPath $RequestedPath).Path
        $minor = & $resolved -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"
        if ($LASTEXITCODE -ne 0 -or $minor -ne "3.12") {
            Fail "-PythonPath must point to a working Python 3.12 executable."
        }
        return @{ Command = $resolved; Prefix = @() }
    }

    $venvPython = Join-Path $RepoRoot ".venv\Scripts\python.exe"
    if (Test-Path -LiteralPath $venvPython) {
        $minor = & $venvPython -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"
        if ($LASTEXITCODE -eq 0 -and $minor -eq "3.12") {
            return @{ Command = $venvPython; Prefix = @() }
        }
    }

    $python = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($python) {
        $minor = & $python.Source -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"
        if ($LASTEXITCODE -eq 0 -and $minor -eq "3.12") {
            return @{ Command = $python.Source; Prefix = @() }
        }
    }

    $localPrograms = [Environment]::GetFolderPath("LocalApplicationData")
    $standardInstalls = @(
        (Join-Path $localPrograms "Programs\Python\Python312\python.exe"),
        "C:\Python312\python.exe",
        (Join-Path ${env:ProgramFiles} "Python312\python.exe")
    )
    foreach ($candidate in $standardInstalls) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            $minor = & $candidate -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"
            if ($LASTEXITCODE -eq 0 -and $minor -eq "3.12") {
                return @{ Command = $candidate; Prefix = @() }
            }
        }
    }

    $launcher = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($launcher) {
        $minor = & $launcher.Source -3.12 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"
        if ($LASTEXITCODE -eq 0 -and $minor -eq "3.12") {
            return @{ Command = $launcher.Source; Prefix = @("-3.12") }
        }
    }

    Fail "Python 3.12 was not found. Install it or create .venv with Python 3.12."
}

function Invoke-Python312($Python, [string[]]$Arguments) {
    $command = $Python.Command
    $pythonArguments = @($Python.Prefix) + $Arguments
    & $command @pythonArguments
    if ($LASTEXITCODE -ne 0) {
        Fail "Python command failed with exit code $LASTEXITCODE."
    }
}

function Find-Iscc([string]$RequestedPath) {
    if ($RequestedPath) {
        if (-not (Test-Path -LiteralPath $RequestedPath -PathType Leaf)) {
            Fail "ISCC.exe was not found at '$RequestedPath'."
        }
        return (Resolve-Path -LiteralPath $RequestedPath).Path
    }

    $onPath = Get-Command ISCC.exe -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }

    $registryPaths = @(
        "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\ISCC.exe",
        "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\ISCC.exe",
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\ISCC.exe"
    )
    foreach ($registryPath in $registryPaths) {
        if (Test-Path $registryPath) {
            $candidate = (Get-Item -LiteralPath $registryPath).GetValue("")
            if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
                return $candidate
            }
        }
    }

    $programRoots = @(${env:ProgramFiles}, ${env:ProgramFiles(x86)}) |
        Where-Object { $_ } | Select-Object -Unique
    foreach ($programRoot in $programRoots) {
        $installs = Get-ChildItem -LiteralPath $programRoot -Directory -Filter "Inno Setup *" -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending
        foreach ($install in $installs) {
            $candidate = Join-Path $install.FullName "ISCC.exe"
            if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
        }
    }

    Fail "Inno Setup Compiler (ISCC.exe) was not found. Install Inno Setup 6 or pass -IsccPath."
}

if (-not (Test-Path -LiteralPath $VersionFile -PathType Leaf)) {
    Fail "VERSION file not found at $VersionFile."
}
if (-not $Version) {
    $Version = (Get-Content -Raw -LiteralPath $VersionFile).Trim()
}
if ($Version -notmatch '^\d+\.\d+\.\d+$') {
    Fail "Version must use x.y.z format (received '$Version')."
}

Assert-PerUserInstallerConfig
$Python = Find-Python312 $PythonPath
$Iscc = Find-Iscc $IsccPath
Write-Host "  Version : $Version"
Write-Host "  Python  : $($Python.Command) $($Python.Prefix -join ' ')"
Write-Host "  ISCC    : $Iscc"

Push-Location $RepoRoot
try {
    if (-not $SkipTests) {
        Step "Running the full Python test suite"
        Invoke-Python312 $Python @("-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py")

        Step "Running the full JavaScript test suite"
        & npm.cmd test
        if ($LASTEXITCODE -ne 0) { Fail "JavaScript tests failed with exit code $LASTEXITCODE." }
    }

    Step "Building Time Keeper $Version"
    Invoke-Python312 $Python @("build.py", "--version", $Version)

    $Executable = Join-Path $RepoRoot "Build\dist\Time-Keeper.exe"
    if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) {
        Fail "Expected executable not found at $Executable."
    }

    Step "Compiling per-user installer"
    & $Iscc "/DMyAppVersion=$Version" $InstallerScript
    if ($LASTEXITCODE -ne 0) { Fail "ISCC failed with exit code $LASTEXITCODE." }

    $Artifact = Join-Path $RepoRoot "Build\installer\Time-Keeper-Setup-$Version.exe"
    if (-not (Test-Path -LiteralPath $Artifact -PathType Leaf)) {
        Fail "Expected installer not found at $Artifact."
    }

    Step "Writing SHA-256 checksum"
    $Hash = (Get-FileHash -LiteralPath $Artifact -Algorithm SHA256).Hash.ToLowerInvariant()
    $ChecksumPath = "$Artifact.sha256"
    Set-Content -LiteralPath $ChecksumPath -Value "$Hash  $([IO.Path]::GetFileName($Artifact))" -Encoding ascii

    Write-Host ""
    Write-Host "Installer build complete." -ForegroundColor Green
    Write-Host "  Installer: $Artifact" -ForegroundColor Green
    Write-Host "  Checksum : $ChecksumPath" -ForegroundColor Green
    Write-Host "  SHA-256  : $Hash" -ForegroundColor Green
} finally {
    Pop-Location
}
