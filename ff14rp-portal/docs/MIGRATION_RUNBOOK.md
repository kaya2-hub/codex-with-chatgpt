# 移行・検証・公開手順

## 0. 本番に進む条件(すべて満たすまで本番書込禁止)
1. Gate0: ユーザーPCで実バックアップの隔離復元が**PASS**(下記手順A)。
2. Gate1: 現行Hosting配信と保存版の差分確認(手順B)。差異があれば現行ソースを入手し本書を見直す。
3. 共通マスターの置き場所(第一候補 `pixies-diner`)について、2プロジェクトの匿名Auth/Firestore接続を実機確認。
4. 照合候補(同名16組)の本人確認は画面から**運用者が1件ずつ**行う(自動確定なし)。
5. 利用者の明示承認(本番マスターへの書込み、公開サイトの作成)。

## A. バックアップ隔離復元検証(ユーザーPCで1回)
前提: Node.js 20+、Java 11+。このリポジトリを取得して `ff14rp-portal` で `npm install`。バックアップはクラウドへ送らない。
```powershell
# 1) 形式の構造だけ確認(値は出ません)
.\tools\verify-backup.ps1 -BackupDir "$env:USERPROFILE\Documents\FF14RP-backups\pixies-diner\2026-10-11T04-24-25-783Z" -Project demo-restore-diner -ProbeOnly
# 2) 復元検証(ダイナー821文書/3コレクション、常若亭162文書/10コレクション)
.\tools\verify-backup.ps1 -BackupDir "$env:USERPROFILE\Documents\FF14RP-backups\pixies-diner\2026-10-11T04-24-25-783Z" -Project demo-restore-diner -ExpectDocs 821 -ExpectCollections 3
.\tools\verify-backup.ps1 -BackupDir "$env:USERPROFILE\Documents\FF14RP-backups\tokowakatei-receipt\2026-10-11T04-24-25-783Z" -Project demo-restore-toko -ExpectDocs 162 -ExpectCollections 10
```
- `"verdict": "PASS"` の条件: SHA256一致/重複0/全文書のID・型・値が復元後に一致/元ファイル不変/件数一致。`demo-`プロジェクトとlocalhostにしか接続しません(本番ID・非localhostは起動時に拒否)。
- 形式が想定(1行=`{path|name, fields(Firestore REST型付き値)}`)と違う場合は**推測せず終了コード3**で止まります。`probe`の出力(値なし)を共有してください。
- `verify-backup.ps1` はこの環境(Linux)では実行できず、Windowsでは未検証です。中核の`backup-verify.mjs`は合成データで検証済み。
- 常若亭と店舗間の混在0は、別々のdir/別projectで復元して件数・コレクション名が各manifestと一致することで確認します。

## B. 現行Hosting差分(副作用なし)
```
node tools/hosting-diff.mjs --base https://<店舗サイト>.web.app --local <保存版ソースのフォルダ>
```
GETのみ。ブラウザでアプリを開かない(アプリを開くと`reconcileNoXVerCounts`/`seed`/`migrateExistingCustomers`等が書込む可能性があるため)。このクラウド環境は外部ホストへの通信が遮断されており未実施。

## C. 移行ドライラン(実データ・ローカルのみ)
読み取り専用のエクスポートを `dinerCustomers.json` `dinerVisits.json` `tokoProfiles.json` `tokoVisits.json` として private フォルダへ置き:
```
node tools/migrate.mjs plan --input private --out out/dryrun.json
```
出力は件数のみ(氏名・備考・DMは出ません)。確認する値: 同名候補数(16組想定)、曖昧候補、`verCountedByVisitIdUnchanged: true`、`planInvariantErrors: 0`、`oldNoteMigrated.fromToko: 0`。

## D. 適用(エミュレータで予行 → 承認後のみ本番)
`migrate-lib.js` の `applyPlan`/`postCheck`/`rollbackBatch` を使用(テスト済み)。**本番プロジェクトへ適用するCLIはこの版に含めていません**(誤実行防止。承認後に別コミットで、バックアップPASSの確認ステップ付きで追加する)。
- 再実行安全: 既存文書は上書きせず、差異は報告のみ。
- ロールバック: 当該バッチ作成かつ`revision==1`(未編集)の文書のみ削除。編集済みは残して一覧表示。店舗原記録は一切変更しないので、ロールバックで店舗データが変わることはない。

## E. 店舗画面の切替(未実施・要設計承認)
店舗側の備考/DM編集口を共通Personへ接続する改修は**今回実施していません**(下記リスク)。切替までの間、ポータルは差異を「ダイナー側の備考/DMが共通と異なります」と表示するだけで、自動同期・上書きはしません。

## F. 公開
`npm run build` → `dist/`。新規Hostingサイトの作成は課金・権限判断のため未実施(`firebase.hosting.template.json`)。既存2店舗のhosting/rulesには触れない。公開前に `dist/` 内に `portal-config.js`・顧客データが無いことを確認。

## G. 切り戻し
店舗アプリは無改変のため、ポータルを非公開にすれば元の運用に戻る。マスターは`rp*`コレクションのみで、削除しても店舗原記録に影響しない。変更履歴からundo可能。
