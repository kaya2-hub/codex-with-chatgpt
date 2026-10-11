# 移行・検証・切替・公開手順

## 0. 本番に進む条件(すべて満たすまで本番への書込み・公開は禁止)
1. **Gate0**: 実バックアップの隔離復元が PASS(手順A)。
2. **Gate1**: 現行Hosting配信と保存版の差分確認(手順A)。差異があれば現行ソースを入手し、`store-patches` のアンカー検査と隔離E2Eをやり直す。
3. 共通マスターの置き場所(第一候補 `pixies-diner`)について、2プロジェクトの匿名Auth/Firestore接続を実機確認(常若亭連携版は pixies-diner へ匿名ログインする)。
4. 同名候補(16組想定)は、ポータルの「照合候補」画面で**運用者が1件ずつ**判断(自動確定なし。分からないものは保留のまま可)。
5. 利用者の明示承認: 本番マスターへの書込み、連携版アプリのデプロイ、切替フラグのmaster化、(必要なら)公開サイトの作成。
認証方式・Firestoreルールは変更しない。追加課金・クラウド資源の作成はしない。

## A. PC側Gate確認(1コマンド) → `docs/PC_AGENT_RUNBOOK.md`
`tools/pc-gate-check.ps1` が、バックアップ隔離復元(821/3・162/10)・Ver基準(186/449/6)・現行Hosting差分をまとめて判定し `out/gate-report.json` を出す。個別実行: `tools/verify-backup.ps1`(復元)、`tools/hosting-diff.mjs`(GETのみ)、`tools/ver-compare.mjs`(来店ID単位のVer比較)。

## B. 移行ドライラン(実データ・ローカルのみ)
読み取り専用エクスポートを `private/` に置く(`dinerCustomers.json` `dinerVisits.json` `tokoProfiles.json` `tokoVisits.json`):
```
node tools/migrate.mjs plan --input private --out out/dryrun.json
```
件数のみ出力。確認: 同名候補数(16組想定)、曖昧候補、`verCountedByVisitIdUnchanged: true`、`planInvariantErrors: 0`、`oldNoteMigrated.fromToko: 0`。

## C. 適用(エミュレータで予行 → 承認後のみ本番)
`tools/migrate-lib.js` の `applyPlan`/`postCheck`/`rollbackBatch`(テスト済み)。**本番プロジェクトへ適用するCLIはこの版に含めていません**(誤実行防止。承認後に、Gate0 PASS確認ステップ付きで別コミットで追加)。
- 冪等: 既存文書は上書きせず差異を報告。店舗の新規客はポータル「切替→再スキャン」で追加(同名は候補止まり)。
- ロールバック: 当該バッチ作成かつ未編集で、他から参照されていない文書だけ削除。店舗原記録は一切変更されない。

## D. 備考・DMの正本一本化(段階切替) → `docs/CUTOVER_DESIGN.md`
1. ポータル「切替」で差異を確認し、ダイナー店舗側の値を共通へ取り込む(または共通を維持する側に揃える)。常若亭の旧備考は必要なものだけ明示的に追記(自動取り込みなし)。
2. 切替前チェックが全て合格することを確認。
3. 連携版を生成: `node store-patches/apply.mjs --system diner --src <ダイナー保存版> --out <出力>` / `--system toko ... --master-config <共通マスターのWeb設定JSON>`(元ソースは変更されない。想定外のバージョンはSHA256/アンカー検査で停止)。
4. **隔離E2E** `npm run test:isolated`(環境変数 `FF14RP_DINER_SRC` `FF14RP_TOKO_SRC`)で、原本の危険の再現・連携版off=従来同一・master時の備考/DM/Ver不変を確認。
5. 連携版をデプロイ(別承認・フラグはoffのまま)→店舗の営業に支障がないことを確認 → ポータルでフラグをmasterへ。
6. 戻し: フラグをoffへ(即時)。連携版アプリを旧版へ戻すのは再デプロイ。共通へ入った変更は差異表示で確認。

## E. 公開
ポータルは `npm run build` → `dist/`(`portal-config.js`・顧客データは含めない。公開前に `dist/` を確認)。新規Hostingサイトの作成は課金・権限判断のため未実施(`firebase.hosting.template.json`)。既存2店舗のhosting/rulesは上書きしない。

## F. 切り戻し総括
- 店舗アプリは連携版を配信するまで無改変。連携版もフラグoffで従来動作。
- 共通マスターは `rp*` のみ。削除しても店舗原記録に影響なし。人物操作は変更履歴から取り消し可。
