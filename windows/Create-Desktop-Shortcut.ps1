<#
    One-time setup: creates a "JUSTTECH Application Manager" shortcut on
    your Windows Desktop that runs Start-JustTech.ps1 with the JUSTTECH
    icon. Safe to re-run -- it just overwrites the existing shortcut.

    Usage: right-click this file in File Explorer -> "Run with PowerShell".
    (If Windows blocks it as an untrusted script, right-click ->
    Properties -> check "Unblock" -> OK, then try again.)
#>

$ErrorActionPreference = "Stop"

$WindowsDir = $PSScriptRoot
$RepoRoot = Split-Path -Parent $WindowsDir
$StartScript = Join-Path $WindowsDir "Start-JustTech.ps1"
$IconPath = Join-Path $WindowsDir "justtech.ico"
$DesktopPath = [Environment]::GetFolderPath("Desktop")
$ShortcutPath = Join-Path $DesktopPath "JUSTTECH Application Manager.lnk"

if (-not (Test-Path $StartScript)) {
    throw "Could not find Start-JustTech.ps1 next to this script at $StartScript"
}
if (-not (Test-Path $IconPath)) {
    throw "Could not find justtech.ico next to this script at $IconPath"
}

$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = "powershell.exe"
$Shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Normal -File `"$StartScript`""
$Shortcut.WorkingDirectory = $RepoRoot
$Shortcut.IconLocation = $IconPath
$Shortcut.Description = "Open JUSTTECH Application Manager"
$Shortcut.Save()

Write-Host "Created desktop shortcut: $ShortcutPath" -ForegroundColor Green
Write-Host "Double-click it any time to start JUSTTECH and open the dashboard." -ForegroundColor Green
