# ローカルバックアップの隔離復元検証 (Windows PowerShell 5.1 / PowerShell 7 互換)
# 前提: Node.js 20以上 と Java 11以上(Firestoreエミュレータ用)。本番へは接続しません(demo-プロジェクト/localhostのみ)。
# 例: .\tools\verify-backup.ps1 -BackupDir "$env:USERPROFILE\Documents\FF14RP-backups\pixies-diner\2026-10-11T04-24-25-783Z" -Project demo-restore-diner -ExpectDocs 821 -ExpectCollections 3
param(
  [Parameter(Mandatory = $true)][string]$BackupDir,
  [Parameter(Mandatory = $true)][string]$Project,
  [int]$ExpectDocs = 0,
  [int]$ExpectCollections = 0,
  [switch]$ProbeOnly
)
$ErrorActionPreference = "Stop"
if (-not (Test-Path -LiteralPath $BackupDir)) { throw "BackupDir was not found: $BackupDir" }
Set-Location (Split-Path -Parent $PSScriptRoot)
$isWin = ($env:OS -eq "Windows_NT")
$npm = "npm"; $npx = "npx"
if ($isWin) { $npm = "npm.cmd"; $npx = "npx.cmd" }
if (-not (Test-Path "node_modules")) { & $npm install --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
$env:FF14_BACKUP_DIR = (Resolve-Path -LiteralPath $BackupDir).Path
$env:FF14_RESTORE_PROJECT = $Project
if ($ExpectDocs -gt 0) { $env:FF14_EXPECT_DOCS = "$ExpectDocs" }
if ($ExpectCollections -gt 0) { $env:FF14_EXPECT_COLLECTIONS = "$ExpectCollections" }
if ($ProbeOnly) { & node tools/backup-verify.mjs probe; exit $LASTEXITCODE }
& $npx firebase emulators:exec --only firestore --project $Project "node tools/backup-verify.mjs verify"
exit $LASTEXITCODE
