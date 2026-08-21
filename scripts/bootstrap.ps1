<#
.SYNOPSIS
    One-time setup for the self-hosted edition on Windows.

.DESCRIPTION
    Fetches upstream model source and weights, and creates a .env to start from.
    Deliberately does not build or start anything: bootstrapping downloads about
    1.4 GB, and a script that then silently started a stack would make it
    impossible to tell which step failed.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Info($m) { Write-Host "`n$m" -ForegroundColor White }
function Ok($m)   { Write-Host "  [ok] $m" -ForegroundColor Green }

Info 'Rhythmisoze - self-hosted bootstrap'

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'Docker Desktop is required. Install it, enable the WSL2 backend, and start it.'
}
docker compose version *> $null
if ($LASTEXITCODE -ne 0) { throw 'Docker Compose v2 is required (`docker compose`).' }
Ok "docker $((docker --version) -replace 'Docker version ','' -replace ',.*','')"

Info '1/3  Upstream model source'
& "$root/scripts/vendor/bootstrap.ps1"

Info '2/3  Model weights (~1.4 GB)'
& "$root/scripts/models/bootstrap.ps1"

Info '3/3  Configuration'
$envPath = Join-Path $root '.env'
if (Test-Path $envPath) {
    Ok '.env already exists, leaving it alone'
} else {
    Copy-Item (Join-Path $root '.env.production.example') $envPath

    # A secret nobody chose beats a default everybody shares.
    function New-Secret([int]$bytes = 32) {
        $buffer = New-Object byte[] $bytes
        [System.Security.Cryptography.RandomNumberGenerator]::Fill($buffer)
        ($buffer | ForEach-Object { $_.ToString('x2') }) -join ''
    }

    $content = Get-Content $envPath -Raw
    $content = $content -replace '(?m)^PUBLISH_SECRET=.*',   "PUBLISH_SECRET=$(New-Secret)"
    $content = $content -replace '(?m)^MAINTENANCE_TOKEN=.*', "MAINTENANCE_TOKEN=$(New-Secret)"
    $content = $content -replace '(?m)^POSTGRES_PASSWORD=.*', "POSTGRES_PASSWORD=$(New-Secret 16)"
    Set-Content $envPath $content -Encoding utf8 -NoNewline
    Ok 'generated .env with fresh secrets'
}

Info 'Done.'
Write-Host @'
  Next:
    local        ./scripts/start-local.ps1
    verify       ./scripts/verify-real-stack.ps1
'@
