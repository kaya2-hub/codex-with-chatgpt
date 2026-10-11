# 受入試験表(証拠付き)

環境: Node 22 / Firestoreエミュレータ(`demo-*`・localhost)/ Chromium。**全て架空データ**。実顧客データ・実バックアップはクラウドから見えないため、「実データ」列が **×** の項目は未検証。
実行コマンド: `npm test`(メモリ+単体)、`npm run test:emu`(エミュレータ。結合・復元CLI・ブリッジ含む)、`npm run test:e2e`(ポータルUI)、`npm run test:isolated`(**保存版の店舗アプリ原本/連携版を実ブラウザで操作**。要 `FF14RP_DINER_SRC` `FF14RP_TOKO_SRC`)、`npm run scan`(機密混入検査)。最新結果は `FINAL_REPORT.md`。

凡例: PASS=自動テストで合格 / PASS* =合格だが実データ確認が別途必要 / PC=PC環境での実行が必要 / USER=利用者判断が必要 / HOLD=本番切替まで保留

## 共通顧客・集計
| ID | 判定 | 証拠 |
|---|---|---|
| DATA-01 元ID保持 | PASS* | migration「元IDを保持」 |
| DATA-02 同名は候補のみ(推測マージ0・曖昧は全候補列挙) | PASS* | migration「同名は候補のみ」、e2e候補画面(判断材料表示) |
| DATA-03 別キャラで二重加算なし | PASS | identity |
| DATA-04 改名・旧名検索 | PASS | identity/e2e |
| DATA-05 同名別人 | PASS | identity(reject)、bridge(名前ガード) |
| DATA-06 characterId:null | PASS | migration |
| DATA-07 統合訂正(undo)・孤児防止 | PASS | identity、audit-fixes |
| DATA-08 SourceLink冪等・rollback参照保護 | PASS | migration、audit-fixes |
| DATA-09 競合編集 | PASS | identity(Firestoreトランザクションでも) |
| VER-01 Ver基準の**来店ID単位**比較 | PASS(ツール)/ PC(実186件) | ver-notion(入替・理由・上書き・欠落を検出)、`ver-compare`、`pc-gate-check`のbaseline(186/449/6) |
| VER-02 DM変更で過去Ver不変 | PASS | identity、**isolated(実アプリ操作)**: master時にDMを空にしても全来店IDのflagsが一致 |
| VER-03 来店とVerは別表示 | PASS | identity、e2e |
| VER-04 実施の自動推測なし | PASS | ceremonyは実施記録のみから導出 |
| 現在のDM有無による過去Ver再判定の停止 | PASS | **isolated**: 原本は14件が一括false化(危険の再現)→連携版master/off復帰後は不変。詳細は `CUTOVER_DESIGN.md` |
| SHOP-03 元履歴の原文 | PASS* | events-ceremony |
| SHOP-04 最後の来店削除で共通情報が残る | PASS | identity(+連携版の警告文) |

## 備考・DMの正本一本化(今回の主要追加)
| ID | 判定 | 証拠 |
|---|---|---|
| SOT-01 フラグoff/無し/読込失敗は従来動作 | PASS | bridge.test、isolated(連携版off=原本と同じ件数が変化) |
| SOT-02 master時の備考/DMは共通Personへ・店舗旧フィールド凍結(削除/上書きなし) | PASS | isolated diner/toko |
| SOT-03 切替前の既存値を失わない(差異検出→取り込み/旧備考は参照専用で併記・明示追記) | PASS | bridge.test(preflight)、ver-notion(adopt/append)、isolated toko(旧備考表示)、e2e(切替) |
| SOT-04 切替前チェック(未連携・孤児・重複・値差・名前差・0件)を満たさないとmaster化不可 | PASS | bridge.test、e2e |
| SOT-05 名前一致だけで統合しない(新規客は独立Person・既存同IDでも名前不一致は拒否・ダイナー内の既存顧客統合はmasterで停止・常若亭候補は未接続のまま) | PASS | bridge.test、isolated diner/toko |
| SOT-06 店舗の注文・記帳機能が動く | PASS(架空データ) | isolated: Ver記帳(1件追加・既存flags不変)、連携失敗時も記帳継続 |
| SOT-07 既存文書を自動削除しない | PASS | rollback/適用は上書きなし、連携版は旧フィールドを書かない |
| SOT-08 本番への実適用 | HOLD | 連携版デプロイ・フラグmaster化は承認後。`CUTOVER_DESIGN.md` 手順 |
| SOT-09 実ブラウザ+実Firebase匿名認証・2プロジェクト接続(常若亭→pixies-diner) | PC/USER | 未検証(shim経由のみ) |

## イベント・セレモニー・マクロ
| ID | 判定 | 証拠 |
|---|---|---|
| EVT-01/02/03/04 | PASS | events、e2e |
| MAC-01 FF14マクロ原文(`/yell` `/s` `/wait` `<t>`・改行・記号)保持 | PASS | events、e2e(クリップボード一致)、notion-paste(本文不変) |
| MAC-02 演目の完成状態の区別(GG=完成だが本文未取得/魔物・ダーツ=進行案) | PASS | events、e2e |
| MAC-03 原文の登録・編集(GGテンプレ登録/差替、Notion貼り付け取り込み) | PASS | e2e、notion-paste。**Notion自動取り込みは未実装**(制約: `RISKS` R9) |
| CER-01 7スタンプ(**確定仕様**)・到達と実施は別 | PASS | events、ceremony導出 |
| CER-02 同営業回の抽選・CER-03 実施記録の一意/コピーで完了しない | PASS | events、audit-fixes、e2e |

## 安全・運用
| ID | 判定 | 証拠 |
|---|---|---|
| SEC-01 認証/ルール不変・本番書込み経路なし | PASS | 差分にrules/auth変更なし。ツールはdemo-/localhost限定、isolatedは外部通信遮断(遮断0件) |
| SEC-02 機密・顧客データ・バックアップがリポジトリに無い | PASS | `npm run scan`(作業ツリー+未追跡+履歴。検出力テスト付き)。**公開範囲は未確認**(GitHub検索0件=非公開または未索引) |
| ROL-01 バックアップ983件の隔離復元 | PC | ツール・合成バックアップでの全型一致は検証済。実データは `pc-gate-check` で判定 |
| Gate1 現行Hosting差分 | PC | `hosting-diff`(GETのみ・通信失敗は不合格)。このクラウドは外部通信403 |
| 16組の本人確認 | USER | 画面を完成(判断材料: 来店数/最終来店/旧名/備考DMの有無)。確定は利用者のみ |
| PowerShell 5.1 互換 | PASS(静的)/ PC(実行) | BOM+CRLF・5.1非互換構文なし・`npx.cmd`。Windowsでの実行は未検証 |
| Windows引数引用 | PASS(単体) | shellArgs。Windows実行は未検証 |

## ChatGPT連携・イベント/セレモニー改修(第3回)
| ID | 判定 | 証拠 |
|---|---|---|
| GPT-01 イベント用の仕様書をコピーできる | PASS | exchange.test(必須内容を含む)、e2e(クリップボードに`ff14rp.event`・「これでOK」・22:55頃の実例) |
| GPT-02 セレモニー用の仕様書をコピーできる | PASS | exchange.test、e2e(`ff14rp.ceremony`・実施済みの注意) |
| GPT-03 各仕様書のJSONを正常に取り込める | PASS | exchange.test(サンプル検証・往復)、e2e(貼り付け/ファイルアップロード) |
| GPT-04 不足・形式不正・不明バージョンを保存せず拒否(場所を表示) | PASS | exchange.test(スキーマ違反10種・壊れた`_base`・実在しない日付・steps省略)、e2e |
| GPT-05 イベント全体を一括新規登録(下書き) | PASS | exchange.test、e2e |
| GPT-06 既存イベントのJSON差分更新(選択適用) | PASS | exchange.test、e2e(チェックを外した変更は反映されない) |
| GPT-07 アプリで一箇所編集しても他は変わらない | PASS | exchange.test(項目単位)、e2e(他ステップのDOM完全一致)、savefieldsは「画面に出した値から変えた項目だけ」 |
| GPT-08 再エクスポート→再取り込みで差分なし | PASS | exchange.test |
| GPT-09 別々の利用者の編集の競合検知 | PASS | exchange.test(`_base`3者比較・ID衝突・他者追加の保持・他者編集項目の削除=競合・プレビュー後の更新拒否)、手動編集はbaseHash |
| GPT-10 複雑な会話劇・時刻・キャラチェンジを保持 | PASS | exchange.test(22:55頃/23時になったら・複数行動・change種別)、e2e |
| GPT-11 マクロ原文・改行・コマンド完全一致 | PASS | exchange.test、e2e(コピーが`/yell <t>…\n\n/wait`と完全一致、15行超は警告のみ) |
| GPT-12 かや/トーシンの表示名 | PASS | roles(表記ゆれ)、e2e(画面にKaya/Toushinが出ない) |
| GPT-13 担当者別マクロを折り畳める(グループ・個別) | PASS | e2e |
| GPT-14 顧客一覧の来店回数・DM・Verスタンプ | PASS | e2e(`17回`・`14(0/7・到達2回分)`・DMを開く/DMなし・候補は合算しない・`?fail=diner`で読込失敗表示) |
| GPT-15 セレモニー原稿を作っても実施済み/完成にならない | PASS | exchange.test、e2e(取り込み後も`7:到達済み未実施`) |
| GPT-16 Ver判定・過去の実施記録が変わらない | PASS | exchange.test(取り込み前後で実施記録・Personが同一)、isolated(店舗アプリ回帰) |
| GPT-17 既存のイベント/マクロ/タイムラインに欠落なし | PASS | exchange.test(旧3列/未分類/IDなしマクロ/memo→新形式・`timelineLegacy`退避)、複製の全項目コピー、開催済み編集の前内容履歴 |
| GPT-18 本番接続なしのデモで一連の操作 | PASS | `npm run serve`(デモ)・e2e |
| 旧機能の撤去 | PASS | Notion貼り付けUI・ルールベース3列分類UIを撤去。旧データは変換して閲覧/編集可 |
| 「仮設定」表記の修正 | PASS | セレモニー画面は「7スタンプごと(確定仕様)」 |
| 取り込み先の取り違え防止 | PASS | exchange.test(別イベントのJSON・新規画面へのupdate・別原稿) |
| エミュレータ統合テストの正常終了 | PASS(Linux)/ PC(Windows) | テストが接続を閉じるため、`test:emu` が約25秒で終了コード0。Windowsでの確認は未実施 |
