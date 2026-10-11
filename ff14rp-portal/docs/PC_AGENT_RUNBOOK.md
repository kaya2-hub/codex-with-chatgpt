# PC側実行エージェント向け手順(実データ依存のGate確認)

目的: クラウドで確認できない3点(バックアップ983件の隔離復元、現行Hosting差分、Ver186件の基準値)を、**1コマンド**で判定する。顧客データを外部へ送らない。本番Firestoreへ書き込まない。

## 前提
Windows 10/11、Node.js 20以上、Java 11以上(Firestoreエミュレータ)。このリポジトリを取得し `ff14rp-portal` で実行。ブラウザで店舗アプリを開かない(開くと起動時書込みが走り得る)。

## 実行(PowerShell 5.1 でコピー実行できる形)
```powershell
cd <リポジトリ>\ff14rp-portal
.\tools\pc-gate-check.ps1 `
  -DinerBackup "$env:USERPROFILE\Documents\FF14RP-backups\pixies-diner\2026-10-11T04-24-25-783Z" `
  -TokoBackup  "$env:USERPROFILE\Documents\FF14RP-backups\tokowakatei-receipt\2026-10-11T04-24-25-783Z" `
  -DinerUrl "https://<ダイナーのHostingドメイン>" -DinerSrc "<保存版ダイナーソースのフォルダ>" `
  -TokoUrl  "https://<常若亭のHostingドメイン>"  -TokoSrc  "<保存版常若亭ソースのフォルダ>"
```
結果は `out\gate-report.json` と標準出力(件数・ID・判定のみ。氏名/備考/DMは出ません)。

## 判定条件
| ステップ | PASSの条件 |
|---|---|
| `backup:diner` | SHA256全一致 / 重複パス0 / 821文書・3コレクション / 全文書のID・パス・値・型が復元後に一致 / 元ファイル不変 |
| `backup:toko` | 同上で 162文書・10コレクション |
| `ver-baseline:diner` | `verCounted=true` が186、非対象で理由ありが449、`verCountOverride=counted` が6、VER以外でcounted=0 |
| `hosting-diff:*` | 全ファイル `SAME`(`DIFFERENT`/`*_MISSING`があれば保存版は現行と異なる) |
- 全て合格→ `ALL_PASS`。未指定のステップがあれば `INCOMPLETE`。1つでも不合格なら `FAIL`(終了コード 0/3/1)。
- 形式が想定と違う場合は終了時に「形式を解釈できません」と出る。`.\tools\verify-backup.ps1 -BackupDir <dir> -Project demo-restore-x -ProbeOnly` の出力(値は出ない)を依頼者へ返す。

## 報告に含めるもの
`out\gate-report.json` の全文(個人情報を含まない)。FAIL時は該当ステップの `detail`。**バックアップ本体・顧客データ・DM URLは添付しない。**

## Ver186の前後比較(移行・切替の前後)
1. 切替前: `node tools/ver-compare.mjs snapshot --backup-dir <バックアップ> --out before.json`
2. 切替後(店舗側の来店をJSONエクスポートした `visits.json`、またはエミュレータ検証後の同形式): `node tools/ver-compare.mjs snapshot --json visits.json --out after.json`
3. `node tools/ver-compare.mjs compare --before before.json --after after.json --expect-counted 186` → 来店ID単位で `verCounted`/対象外理由/手動上書きが完全一致なら `PASS`。差異は来店IDだけを表示。

## 隔離E2E(連携版アプリ)を実保存版ソースで再実行
```powershell
$env:FF14RP_DINER_SRC="<ダイナー保存版>"; $env:FF14RP_TOKO_SRC="<常若亭保存版>"; npm run test:isolated
```
(架空データ・エミュレータ・外部通信遮断。現行Hostingの実ソースがこの保存版と異なる場合は、まず現行ソースで再確認すること。)
