# 旧ソースとの差分一覧

## 変更したもの
**なし。** `diner_2026-08`(v1.15.0)・`tokowakatei_2026-08`(v1.3.0)は本リポジトリに取り込まず、改変もしていません(保存版自体が機密を含み得るため同梱せず)。したがって店舗側の回帰(SHOP-01/02)は本成果物では発生し得ず、「店舗画面の切替」を行う段階で改めて回帰試験が必要です。

## 保存コードから確認した、今後の店舗側改修(未実施)で触る箇所
- ダイナー `index.html`: `customerPayload`/`saveCustomerCloud`/`saveCustomerOnly`(備考・DM保存先)、`applyCustomerNameChange`(統合時に旧顧客削除・履歴の名前/ID書換え)、`deleteVisit`(最後の来店で顧客削除)、`reconcileNoXVerCounts`/`visitVerCounted`(DM有無でVer再判定)、`buildBatchRecords`(名前だけで顧客新規作成)。
- 常若亭 `app.js`: `profileIdForName`(名前由来ID)、`saveProfileNotes`(旧備考)、`seed`/`seedCustomerHistory`/`migrateExistingCustomers`/`openDate`(起動時書込み)。
- 本ポータルは `profileIdForName` と同じ規則(`profile-` + FNV-1a(NFKC・小文字・空白除去・ワールド名除去))を**読み取り照合のみ**に再現(`core/history.js`)。
