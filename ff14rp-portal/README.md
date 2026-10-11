# FF14 RP 店舗総合DBポータル

Pixies' DINER と 妖精食堂 -常若亭- の共通顧客台帳(Person/Character/SourceLink)・イベント・セレモニー・マクロ・3列タイムライン・アーカイブを扱う運用ポータル。
**店舗の原記録(来店・注文・メニュー)は読み取り専用**で、共通マスター(`rp*`コレクション)だけを書き込みます。

> 状態: 実装・ローカル検証は完了。**本番への移行・公開・店舗画面の切替は未実施**(安全条件・利用者承認待ち)。詳細は `docs/FINAL_REPORT.md`。

## すぐ試す(架空データのデモ)
```
cd ff14rp-portal
npm install
npm run serve        # http://127.0.0.1:5173/web/ を開く(demoモード: 架空データ・保存されない)
```

## テスト
| コマンド | 内容 |
|---|---|
| `npm test` | 単体/結合テスト(メモリストア) |
| `npm run test:emu` | 同じテストをFirestoreエミュレータ(`demo-ff14rp`)で実行。要Java。復元検証CLIの結合テストを含む |
| `npm run test:e2e` | ブラウザ(Chromium)E2E。デモモード |
| `npm run test:isolated` | 保存版の店舗アプリを実ブラウザで操作する隔離E2E(要 `FF14RP_DINER_SRC` `FF14RP_TOKO_SRC`) |
| `npm run migrate:demo` | 架空データで移行ドライラン(件数レポートのみ) |

## ChatGPT連携(イベント・セレモニー)
企画の相談はChatGPTで、保存・閲覧・編集は総合DBで。仕様書をコピー→ChatGPTで作成→JSONを取り込み(差分確認つき)。細かな修正はアプリ上で直接編集。詳細: `docs/CHATGPT_EXCHANGE.md`。

## 構成
- `core/` 純ロジック(ブラウザ/Node共用): 移行計画、人物操作+変更履歴/undo、集計、セレモニー、マクロ、タイムライン、イベント、ドリフト検出
- `store/` MasterStore(メモリ/Firestore)と店舗読み取り専用アダプター
- `web/` 画面(HOME/顧客/照合候補/イベント/セレモニー/アーカイブ)
- `tools/` 移行(`migrate`)、バックアップ隔離復元検証(`backup-verify`, `verify-backup.ps1`)、現行Hosting差分(`hosting-diff`)、ビルド
- `fixtures/` 完全に架空のデータ
- `docs/` 設計・手順・受入表・最終報告

## 本番接続(Firestoreモード)
`web/portal-config.example.js` を `web/portal-config.js` にコピーして設定(Git管理外)。`allowProductionMaster:false` のままでは本番プロジェクトのマスターに書き込めません。解除の前提は `docs/MIGRATION_RUNBOOK.md` の「本番に進む条件」。

## 機密の扱い
顧客の生データ・DM URL・備考・保存版ソース(初期シード含む)・バックアップはこのリポジトリに入れていません。`.gitignore` で `private/`・`*.jsonl*`・`portal-config.js` を除外しています。
