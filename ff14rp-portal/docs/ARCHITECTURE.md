# 設計

## 境界(コードで強制)
| 区分 | コレクション | 扱い |
|---|---|---|
| 共通マスター(書込可) | `rpPersons` `rpCharacters` `rpSourceLinks` `rpIdentityChanges` `rpEventMasters` `rpEventOccurrences` `rpCeremonyRecords` `rpCeremonyDraws` `rpCeremonyTemplates` `rpMigrationBatches` | `core/collections.js` の許可リスト外は `MemoryStore`/`FirestoreStore` が例外 |
| 店舗原記録(読取のみ) | DINER `pixiesCustomers/pixiesVisits/pixiesMenu`、常若亭 `customerProfiles/customerVisits/customers/items/logs` | `ReadOnlyShopSource` は `list` だけ(書込メソッドなし)。許可リストにも無いため書込経路が存在しない |

## データモデル
- **Person**: 不変ID。`customerNote`(共通備考1欄)・`xDmUrl`(DM1件)の唯一の正本。`revision`で楽観ロック。統合された人物は削除せず `mergedInto`。
- **Character**: `currentName`・`previousNames`(改名と確認できたものだけ)・`legacyNameCandidates`(ダイナー`previousNames`は改名か別キャラか不明なのでここに保持し、人が分類)。
- **SourceLink**: `sourceSystem+sourceType+sourceId`で一意(文書ID=`system__type__id`)。`characterId`はnull可。`linkStatus`: `confirmed`/`candidate`/`unresolved`。候補は `candidatePersonIds` を持つ。
- **IdentityChange**: 全人物操作の前後差分(`diffs`)。`undoChange`は対象文書が変更後から動いていれば競合として拒否。
- ID: ダイナー由来は `person-diner-<元顧客ID>`(元IDそのまま)。名前から新規にハッシュを作らない。操作で作るIDは乱数。

## 移行(`core/identity-plan.js`, `tools/migrate-lib.js`)
plan → dry-run(不変条件検査) → diff → bounded apply(100件/バッチ、既存文書は上書きせず差異を報告) → postcheck → rollback(当該バッチ作成かつ未編集のみ削除)。
- ダイナー顧客1件=Person1+Character1+SourceLink1(confirmed)。備考・DMは共通Personへ。
- 常若亭プロフィール: ダイナーの現在名/旧名(ワールド名除去後)と一致すれば**候補のみ**(自動統合なし)。複数一致は「曖昧」。一致なしは常若亭のみのPerson。**常若亭の旧備考は取り込まない**。
- 店舗来店データは計画に渡すが凍結(deepFreeze)して実行。計画がVer関連を変更しようとすれば例外。

## 集計(`core/aggregate.js`)
来店 / Verスタンプ / 注文 / セレモニー到達は別フィールド。
- ダイナー来店=確定リンクの`pixiesVisits`件数。Verスタンプ=`orderType=VER`かつ保存済み`verCounted===true`(**現在のDMリンクで再判定しない**)。
- 常若亭来店=`sourceSessionId`(営業回ID)がある来店は(人物,営業回)で1回。無いものは集約せず個別計上し「確認要」と注記。
- 同日複数キャラはダイナーでは自動で1回にせず注記(営業回IDが無いため)。
- 店舗読込失敗時、総合は`null`(不明)。候補リンクは集計に含めない。

## セレモニー(`core/ceremony.js`)
- 到達=Verスタンプ÷7(単位は`STAMP_UNIT`、運用者確認事項)。状態は実施記録から導出: 到達済み未実施 / 持越 / 実施済み。マクロのレンダー・コピーは記録を作らない。
- 営業回(店舗+日付)ごとにダーツ結果は最初の1件だけ確定(`rpCeremonyDraws`)。後続は既決演目に従う。
- 実施記録は(人物,到達値)で一意。二重記録は拒否。
- 演目の完成状態: GGコール=完成(**本文は未取得**)、ダーツ/魔物ショー=進行案段階。未取得の本文は創作せず、運用者が貼り付けて登録する。

## イベント(`core/events.js`)
マスター→開催回は**ディープコピーのスナップショット**。状態 draft/scheduled/postponed/cancelled/held は明示操作のみ(日付経過で変えない)。held後の編集は編集前内容を履歴へ。複製は新しい下書き(日付なし)。

## 同時編集
全更新は`revision`一致を要求するトランザクション(Firestore `runTransaction`)。不一致は`conflict`で拒否し、画面は最新を読み込み直して再保存を促す。

## 認証・ルール
変更しません。ポータルは既存と同じ匿名ログインで接続し、既存`firestore.rules`(認証済みなら全読書)の下で動きます。**このルールは「URLを知る人」以外を防ぐ認可ではない**ため、ポータルのURLと店舗URLを共有する範囲が実質のアクセス範囲です(利用者決定済み・リスク受容)。
