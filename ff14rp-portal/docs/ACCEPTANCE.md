# 受入試験表(証拠付き)

実行環境: Node 22 / Firestoreエミュレータ(`demo-ff14rp`, localhost) / Chromium。**すべて架空データ**。
最新実行: `npm test` 39/39(emu専用1件skip)、`npm run test:emu` 40/40(失敗0・skip0)、`npm run test:e2e` 全PASS(11ステップ)。
「実データ」列: 実顧客データでの確認が必要か。クラウドには実データが無いため **×=未検証**。

| ID | 判定 | 証拠(テスト) | 実データ | 備考 |
|---|---|---|---|---|
| DATA-01 元ID保持 | PASS | migration.test「元IDを保持…」 | × | ダイナーIDをそのまま`person-diner-<id>`に使用 |
| DATA-02 名寄せ候補 | PASS | migration「同名は候補のみ」(推測マージ0・曖昧列挙) | × | 16組は実データで要確認 |
| DATA-03 別キャラ | PASS | identity「別キャラ追加…二重加算しない」 | × | |
| DATA-04 改名 | PASS | identity「改名…undo」/ e2e HOME旧名検索 | × | |
| DATA-05 同名別人 | PASS | identity「同名別人はreject…」 | × | |
| DATA-06 characterId:null | PASS | migration「旧名は…characterIdはnull可」 | × | 履歴閲覧は候補確定後に表示 |
| DATA-07 統合訂正 | PASS | identity「統合とundo」「undoは後続更新があれば競合」「splitCharacter」 | × | |
| DATA-08 SourceLink冪等 | PASS | migration「適用は冪等…」(エミュレータでも) | × | |
| DATA-09 競合編集 | PASS | identity「競合編集」(Firestoreトランザクションで確認) | | |
| VER-01 基準186件のフラグ不変 | PARTIAL | 計画は凍結入力で実行、ポータルは店舗に書かない(コード境界テスト) | × | 実データ186件の前後比較は未実施 |
| VER-02 DM変更でVer不変 | PASS | identity「VER-02/03」 | | 店舗データに書かない構造 |
| VER-03 来店とVerを別表示 | PASS | identity「VER-02/03」+e2e | | |
| VER-04 未確認実施の自動推測なし | PASS | ceremony状態は実施記録のみから導出 | | |
| SHOP-01/02 店舗原操作の回帰 | N/A | 店舗アプリは無改変 | × | 店舗画面切替を行う段階で必要 |
| SHOP-03 元履歴の原文保持 | PASS | events-ceremony「横断履歴…原文のまま」 | × | |
| SHOP-04 最後の来店削除 | PASS(ポータル側) | identity「SHOP-04」 | × | 店舗側の削除経路は無改変(R4) |
| SHOP-05 メニュー差異 | PASS | ポータルはメニューに触れない | × | 7件は実データ側 |
| EVT-01 開催状況 | PASS | events「EVT-01〜03」+e2e | | |
| EVT-02 過去スナップショット | PASS | 同上 | | |
| EVT-03 複製 | PASS | 同上+e2e/archive | | |
| EVT-04 3列タイムライン | PASS | events「EVT-04」+e2e | | ルールベース。AI/外部API不使用(費用なし) |
| MAC-01 マクロ原文 | PASS | events「MAC-01」+e2eのクリップボード一致 | | |
| MAC-02 完成状態の区別 | PASS | events「CER 持ち越し…MAC-02」+e2e | | GG本文は未取得(貼り付け登録) |
| CER-01 7スタンプ | PASS | events「CER-01」 | × | 単位7は仮設定 |
| CER-02 同日複数 | PASS | events「CER-02/03」 | | |
| CER-03 実施記録 | PASS | 同上+e2e | | |
| SEC-01 認証/ルール不変 | PASS | リポジトリ差分にrules/auth変更なし。匿名ログイン踏襲 | | ガード: backup.test「SEC-01」 |
| SEC-02 機密非混入 | PASS | 架空データのみ。`AIza`/実DM/備考のgrep 0。ZIP・ソース未コミット | | |
| ROL-01 隔離復元 | **PARTIAL** | 合成バックアップ(全型)で復元→全件一致、改ざん・形式不明・本番ID拒否を検証 | **×** | 実983件は未検証。手順A |
| UI: スマホ | PASS | e2e 390px横スクロール0、`out/mobile-home.png` | | |
| UI: 失敗時入力保持 | PASS | e2e 編集ステップ | | |
