<#
.SYNOPSIS
    Fetch upstream model source into vendor/, at the SHAs pinned in third_party/MANIFEST.md.

.DESCRIPTION
    Windows counterpart of bootstrap.sh. Same deviation, same reason:

    MIDI-RWKV's .gitmodules points at three personal forks over SSH, so a
    recursive init fails for any anonymous clone. One of them (MIDIMetrics) has
    no detected licence and is an evaluation dependency this pipeline does not
    need. We therefore rewrite the SSH URLs to HTTPS, initialise only what
    inference uses, and skip MIDIMetrics entirely.

    Nothing fetched here is committed -- vendor/ is gitignored.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$vendor = Join-Path $root 'vendor'

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'git is required' }
if (-not (Test-Path $vendor)) { New-Item -ItemType Directory -Path $vendor -Force | Out-Null }

$repos = @(
    @{ Name = 'melodyt5';  Url = 'https://github.com/sanderwood/melodyt5';        Sha = '9fc0e7dd02ba10a77b46f9d4a669451f17885fbc'; Recurse = 'no' }
    @{ Name = 'midi-rwkv'; Url = 'https://github.com/christianazinn/MIDI-RWKV';   Sha = '7c94e9e2980d1f3cdb0d3a9ca2780ef0a5af6530'; Recurse = 'selective' }
    @{ Name = 'rwkv.cpp';  Url = 'https://github.com/RWKV/rwkv.cpp';             Sha = '14663c83b6aba4885a47c1fba91204efc74a49d3'; Recurse = 'yes' }
)

Write-Host 'Rhythmisoze AI Musician -- vendor bootstrap'
Write-Host "  target: $vendor"
Write-Host ''

foreach ($repo in $repos) {
    $target = Join-Path $vendor $repo.Name
    Write-Host "[$($repo.Name)]"

    if (Test-Path (Join-Path $target '.git')) {
        $current = (git -C $target rev-parse HEAD).Trim()
        if ($current -eq $repo.Sha) {
            Write-Host "  already at $($repo.Sha)"
            Write-Host ''
            continue
        }
        Write-Host "  at $current, moving to $($repo.Sha)"
        git -C $target fetch --quiet origin
    } else {
        Write-Host "  cloning $($repo.Url)"
        # No --depth: a pinned SHA is often not the branch tip, and a shallow
        # clone then cannot check it out.
        git clone --quiet $repo.Url $target
    }

    git -C $target checkout --quiet $repo.Sha
    if ($LASTEXITCODE -ne 0) {
        throw "$($repo.Name) has no commit $($repo.Sha). The manifest and upstream disagree; do not guess."
    }

    $actual = (git -C $target rev-parse HEAD).Trim()
    if ($actual -ne $repo.Sha) { throw "$($repo.Name) checked out $actual, expected $($repo.Sha)" }
    Write-Host "  pinned at $($repo.Sha)"

    switch ($repo.Recurse) {
        'yes' {
            git -C $target submodule update --init --recursive --quiet
        }
        'selective' {
            git -C $target config --local 'url.https://github.com/.insteadOf' 'git@github.com:'
            Write-Host '  initialising rwkv.cpp only'
            git -C $target submodule update --init --quiet -- rwkv.cpp 2>$null
            # Stated rather than merely omitted, so the exclusion is visible.
            Write-Host '  SKIPPED MIDIMetrics: no detected licence, and not needed for inference'
            Write-Host '  SKIPPED RWKV-PEFT: training-only'
        }
        default { Write-Host '  no submodules' }
    }
    Write-Host ''
}

Write-Host 'done. Nothing here is committed -- vendor/ is gitignored.'
Write-Host 'Model weights are separate: run scripts/models/bootstrap.ps1'
