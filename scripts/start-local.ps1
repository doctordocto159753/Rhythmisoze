<#
.SYNOPSIS
    Bring the whole Rhythmisoze stack up on Windows. CPU by default, GPU if present.
#>
[CmdletBinding()]
param([switch]$NoGpu)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$files = @('-f', 'compose.yaml')

# GPU is an accelerator, never a requirement. Detected rather than configured,
# so the same command works on a laptop with a 4060 and on a CPU-only VPS.
if (-not $NoGpu) {
    $gpu = $null
    try { $gpu = (& nvidia-smi --query-gpu=name --format=csv,noheader 2>$null | Select-Object -First 1) } catch {}
    if ($gpu) {
        Write-Host "  NVIDIA GPU detected: $gpu"
        $runtimes = docker info --format '{{json .Runtimes}}' 2>$null
        if ($runtimes -and $runtimes -match 'nvidia') {
            $files += @('-f', 'compose.gpu.yaml')
            Write-Host '  using the GPU profile'
        } else {
            Write-Host '  Docker cannot see the NVIDIA runtime; using CPU'
            Write-Host '  (Docker Desktop -> Settings -> Resources -> WSL Integration)'
        }
    } else {
        Write-Host '  no NVIDIA GPU detected; using CPU (this is the supported baseline)'
    }
}

if (-not (Test-Path (Join-Path $root 'models/melodyt5'))) {
    Write-Host ''
    Write-Host '  Model weights are missing. Run ./scripts/bootstrap.ps1 first.' -ForegroundColor Yellow
    Write-Host '  The stack will still start; the Musician will report itself unavailable.'
    Write-Host ''
}

& docker compose @files up --build -d
if ($LASTEXITCODE -ne 0) { throw 'docker compose failed' }

$port = if ($env:WEB_PORT) { $env:WEB_PORT } else { '3000' }
Write-Host -NoNewline "`n  Waiting for the app"
foreach ($_ in 1..60) {
    try {
        $null = Invoke-WebRequest -Uri "http://localhost:$port/api/musician/status" -UseBasicParsing -TimeoutSec 3
        Write-Host "`n`n  Ready:  http://localhost:$port`n" -ForegroundColor Green
        exit 0
    } catch {
        Write-Host -NoNewline '.'
        Start-Sleep -Seconds 2
    }
}

Write-Host "`n`n  The app did not become ready. Logs:" -ForegroundColor Yellow
Write-Host '    docker compose logs -f web'
exit 1
