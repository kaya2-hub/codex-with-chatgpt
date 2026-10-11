# ローカルバックアップの隔離復元検証(Windows PowerShell 5.1 / PowerShell 7)
# 前提: Node.js 20+ と Java 11+ (Firestoreエミュレータ用)。本番へは接続しません(demo-プロジェクト/localhostのみ)。
# 使い方(例): .\tools\verify-backup.ps1 -BackupDir "$env:USERPROFILE\Documents\FF14RP-backups\pixies-diner\2026-10-11T04-24-25-783Z" -Project demo-restore-diner -ExpectDocs 821 -ExpectCollections 3
param(
  [Parameter(Mandatory = $true)][string]$BackupDir,
  [Parameter(Mandatory = $true)][string]$Project,
  [int]$ExpectDocs = 0,
  [int]$ExpectCollections = 0,
  [switch]$ProbeOnly
)
$ErrorActionPreference = "Stop"
if (-not (Test-Path -LiteralPath $BackupDir)) { throw "BackupDir が見つかりません" }
Set-Location (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path "node_modules")) { npm install --no-audit --no-fund }
$env:FF14_BACKUP_DIR = (Resolve-Path -LiteralPath $BackupDir).Path
$env:FF14_RESTORE_PROJECT = $Project
if ($ExpectDocs -gt 0) { $env:FF14_EXPECT_DOCS = "$ExpectDocs" }
if ($ExpectCollections -gt 0) { $env:FF14_EXPECT_COLLECTIONS = "$ExpectCollections" }
if ($ProbeOnly) { node tools/backup-verify.mjs probe; exit $LASTEXITCODE }
npx firebase emulators:exec --only firestore --project $Project "node tools/backup-verify.mjs verify"
exit $LASTEXITCODE
