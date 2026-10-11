# PC側Gate確認の統合ランナー (Windows PowerShell 5.1 / PowerShell 7 互換)。実体は tools/pc-gate-check.mjs。
# 例:
#   .\tools\pc-gate-check.ps1 -DinerBackup "$env:USERPROFILE\Documents\FF14RP-backups\pixies-diner\2026-10-11T04-24-25-783Z" `
#     -TokoBackup "$env:USERPROFILE\Documents\FF14RP-backups\tokowakatei-receipt\2026-10-11T04-24-25-783Z" `
#     -DinerUrl "https://<ダイナーのサイト>" -DinerSrc "<ダイナー保存版ソースのフォルダ>" -TokoUrl "https://<常若亭のサイト>" -TokoSrc "<常若亭保存版ソースのフォルダ>"
param(
  [string]$DinerBackup, [string]$TokoBackup,
  [string]$DinerUrl, [string]$DinerSrc, [string]$TokoUrl, [string]$TokoSrc,
  [string]$Out
)
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)
$npm = "npm"; if ($env:OS -eq "Windows_NT") { $npm = "npm.cmd" }
if (-not (Test-Path "node_modules")) { & $npm install --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
$argsList = New-Object System.Collections.ArrayList
function Add-Opt($name, $value) { if ($value) { if ($value -notmatch "^https?://") { $value = $value.TrimEnd([char]92) } [void]$argsList.Add("--$name"); [void]$argsList.Add($value) } }
Add-Opt "diner-backup" $DinerBackup; Add-Opt "toko-backup" $TokoBackup
Add-Opt "diner-url" $DinerUrl; Add-Opt "diner-src" $DinerSrc; Add-Opt "toko-url" $TokoUrl; Add-Opt "toko-src" $TokoSrc
Add-Opt "out" $Out
& node tools/pc-gate-check.mjs @argsList  # 実行ポリシーで.ps1が止まる場合: powershell -ExecutionPolicy Bypass -File .\tools\pc-gate-check.ps1 ...
exit $LASTEXITCODE
