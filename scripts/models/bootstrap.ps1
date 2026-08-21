<#
.SYNOPSIS
    Fetch the AI Musician model weights described in models/manifest.json.

.DESCRIPTION
    The Windows counterpart of bootstrap.sh, with identical behaviour:

      * download only what is missing;
      * resume a partial download rather than starting over;
      * verify sha256 against the manifest, always;
      * fail loudly and non-zero on a mismatch;
      * never re-download a file that is already correct.

    A wrong checkpoint that loads is worse than one that does not, because it
    produces plausible output from the wrong model. That is why a mismatch is
    fatal rather than a warning.

.PARAMETER Force
    Re-download even if the file is present and verified.

.EXAMPLE
    pwsh scripts/models/bootstrap.ps1
#>
[CmdletBinding()]
param(
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$manifestPath = Join-Path $root 'models/manifest.json'
$modelsDir = if ($env:MUSICIAN_MODELS_DIR) { $env:MUSICIAN_MODELS_DIR } else { Join-Path $root 'models' }

if (-not (Test-Path $manifestPath)) {
    throw "manifest not found at $manifestPath"
}

$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$totalGb = [math]::Round($manifest.totalBytes / 1e9, 2)

Write-Host 'Rhythmisoze AI Musician -- model bootstrap'
Write-Host "  manifest : $manifestPath"
Write-Host "  target   : $modelsDir"
Write-Host "  full set : $totalGb GB"
Write-Host ''

if (-not (Test-Path $modelsDir)) {
    New-Item -ItemType Directory -Path $modelsDir -Force | Out-Null
}

# Disk space check. A 1.36 GB download that dies at 99% because the volume was
# full is a bad first experience, and the check costs nothing.
try {
    $driveLetter = (Resolve-Path $modelsDir).Path.Substring(0, 1)
    $drive = Get-PSDrive -Name $driveLetter -ErrorAction Stop
    $freeGb = [math]::Round($drive.Free / 1e9, 2)
    Write-Host "  free space: $freeGb GB"
    if ($drive.Free -lt $manifest.totalBytes * 1.2) {
        throw "not enough free disk space: need about $totalGb GB plus headroom, have $freeGb GB"
    }
    Write-Host ''
} catch [System.Management.Automation.DriveNotFoundException] {
    Write-Host '  (could not determine free space; continuing)'
}

function Get-Sha256([string]$Path) {
    (Get-FileHash -Path $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

$fetched = 0
$skipped = 0

foreach ($model in $manifest.models) {
    $artifact = $model.artifact
    $target = Join-Path $modelsDir $artifact.destination
    $targetDir = Split-Path -Parent $target
    if (-not (Test-Path $targetDir)) {
        New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
    }

    Write-Host "[$($model.name)]"

    if ((Test-Path $target) -and -not $Force) {
        $actualBytes = (Get-Item $target).Length
        if ($actualBytes -eq $artifact.expectedBytes) {
            Write-Host '  present, verifying checksum...'
            $actualSha = Get-Sha256 $target
            if ($actualSha -eq $artifact.sha256.ToLowerInvariant()) {
                Write-Host '  verified, nothing to do'
                $skipped++
                Write-Host ''
                continue
            }
            throw @"
$target exists but its checksum does not match the manifest.
  expected $($artifact.sha256)
  actual   $actualSha
Delete the file and re-run. Do NOT use it: a checkpoint that loads but is not
the one recorded produces plausible output from the wrong model.
"@
        }
        Write-Host "  partial file found ($actualBytes of $($artifact.expectedBytes) bytes), restarting"
        Remove-Item $target -Force
    }

    Write-Host "  downloading from $($artifact.downloadUrl)"

    # curl.exe is preferred: it resumes, and Invoke-WebRequest buffers a 1.36 GB
    # body in memory before writing it, which is not acceptable here.
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if ($curl) {
        & $curl.Source --fail --location --continue-at - --progress-bar --output $target $artifact.downloadUrl
        if ($LASTEXITCODE -ne 0) { throw "download failed for $($model.name) (curl exit $LASTEXITCODE)" }
    } else {
        Write-Host '  (curl.exe not found; falling back to Invoke-WebRequest, which cannot resume)'
        Invoke-WebRequest -Uri $artifact.downloadUrl -OutFile $target -UseBasicParsing
    }

    Write-Host '  verifying checksum...'
    $actualSha = Get-Sha256 $target
    if ($actualSha -ne $artifact.sha256.ToLowerInvariant()) {
        throw @"
checksum mismatch for $($model.name) after download.
  expected $($artifact.sha256)
  actual   $actualSha
"@
    }

    Write-Host '  verified'
    $fetched++
    Write-Host ''
}

Write-Host "done: $fetched downloaded, $skipped already present and verified"
