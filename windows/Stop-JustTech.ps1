<#
    Stops JUSTTECH Application Manager (docker compose down). Useful on the
    8 GB Surface Pro to free up RAM when you're done for the day -- the
    desktop shortcut's Start script will bring it back up next time.
#>

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

Write-Host "Stopping JUSTTECH Application Manager (docker compose down)..."
docker compose down
Read-Host "Press Enter to exit"
