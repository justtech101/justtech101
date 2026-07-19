<#
    Launches JUSTTECH Application Manager via docker-compose and opens the
    dashboard in the default browser. This is the script the desktop icon
    points at -- see Create-Desktop-Shortcut.ps1 to generate that icon.

    MANUAL SETUP REQUIRED (one-time, before first use):
      1. Install Docker Desktop for Windows (with WSL2 backend) and make
         sure it's running.
      2. From the repo root, copy .env.example to .env and fill in
         JUSTTECH_ENCRYPTION_KEY and N8N_WEBHOOK_SHARED_SECRET -- see the
         comments in .env.example and README.md section 4.2.
      3. Run Create-Desktop-Shortcut.ps1 once (right-click -> Run with
         PowerShell) to add the "JUSTTECH Application Manager" icon to
         your Desktop.
#>

$ErrorActionPreference = "Stop"

# Repo root is the parent of this script's directory (windows/..).
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

if (-not (Test-Path (Join-Path $RepoRoot ".env"))) {
    Write-Host "No .env file found at $RepoRoot\.env" -ForegroundColor Yellow
    Write-Host "Copy .env.example to .env and fill in the required values first (see README.md section 4.2)." -ForegroundColor Yellow
    Read-Host "Press Enter to exit"
    exit 1
}

docker info *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Docker Desktop does not appear to be running. Start it, then re-run this shortcut." -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host "Starting JUSTTECH Application Manager (docker compose up -d)..."
docker compose up -d --build

Write-Host "Waiting for the backend to become healthy..."
$backendUrl = "http://localhost:8000/api/health"
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
    try {
        $response = Invoke-WebRequest -Uri $backendUrl -UseBasicParsing -TimeoutSec 2
        if ($response.StatusCode -eq 200) { $ready = $true; break }
    } catch {
        Start-Sleep -Seconds 2
    }
}

if (-not $ready) {
    Write-Host "Backend did not become healthy in time. Check the logs with: docker compose logs backend" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host "Backend is healthy. Opening the dashboard..." -ForegroundColor Green
Start-Process "http://localhost:5173"
