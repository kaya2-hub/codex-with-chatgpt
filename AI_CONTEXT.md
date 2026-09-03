# Project Context

## プロジェクトの目的

`codex-with-chatgpt`（Codex with ChatGPT / C2C Bridge）本体のソースチェックアウト。
このディレクトリ自身が、Codex/Claude Code から ChatGPT を計画・レビュー役として
使うためのブリッジ実装。README.md 参照。

## 現在地点

`feature/claude-code-and-chat-fixation` ブランチ。upstream (origin/main, リポジトリ
`XiaoDuoYa/codex-with-chatgpt`) の最新コミットをマージ済み（マージコミット
`d4dbf5f`）。その上に「芋煮会」ゼロタッチブートストラップ機能
(`c2c imonikai status`/`init`) を、upstream 側の Named Tunnel / セッション実装
（`src/tunnel/state.ts`, `named-provision.ts`, `cloudflared-named.ts` など）の
上に作り直してコミット済み（`b01eebf`）。

**working tree は dirty（2026-09-03時点）**: `src/session/state.ts`・
`src/session/kokuban.ts`・`src/cli/index.ts`・`tests/kokuban.test.ts`が
未コミット（Kokuban `holderAfter`/`stopReason`/`summary`拡張、下記参照）。
直近のコミットは新しい順に:
`95518ea`（dead bridge由来のstale runtime state自動修復）→
`3b5bbcd`（Kokuban黒板へのsession-set連携フック追加）→
`4b13e33`（`c2c_full_audit_fix`、独立ChatGPT監査12項目の修正）→
`88092f3`（同監査の先行2件）。
**この行を含め、記載内容は都度の `git status`/`git log` で必ず裏取りしてから
信頼すること — 過去、working tree clean/テスト153件という記述が実態と
2日以上ズレたまま放置されていたことが2026-09-02の監査で判明している。**

テストは `npx vitest run`（デフォルト、外部ネットワーク不要）で230件green
+ 1件skip、typecheck・buildともclean（未コミットのKokuban拡張込み）。
実cloudflared/実ネットワーク依存の1テストは`C2C_TEST_NETWORK=1 npx vitest run`
でのみ動くopt-in smoke testとして分離済み。

**CLIの実エントリポイントは `src/cli/run.ts`（コンパイル後
`dist/cli/run.js`）のみ — `src/cli/index.ts` は `program`/`runCli()`を
定義するだけで自身は実行しない。** これを参照する箇所は3つ:
`bin/c2c.js`・`src/process/daemon.ts`の`cliEntry()`・`package.json`の
`dev` script。**この3箇所は必ずセットで確認・変更すること**
（意図的に共通化していない — `bin/c2c.js`はビルド前でも動く必要がある
プレーンJSである一方、`daemon.ts`はTypeScriptとしてコンパイルされる、
という前提の違いのため）。`tests/dist-entrypoint.test.ts`がビルド済み
`dist/`を使ってこの一致を回帰テストしている。

## 現在のフェーズ

2026-09-02、ChatGPTによる独立MCP監査（`c2c_full_audit_fix`、6ラウンド）が
**完了・DONE**。当初の監査で見つかった12項目（Named Tunnelの自動upgrade・
endpoint確認状態の分離・Tunnel削除の所有権検証・DNS競合検出・OAuth
scope制御・hostname/zone設計・Named失敗時のfallback・configured/reachable
分離・token有効性判定・stale dist対策など）に加え、再レビューの過程で
CLIエントリポイント分離に伴う取り残し（`daemon.ts`・`package.json`の
参照漏れ）や、テストの過剰実装（実ネットワーク依存テストの混入）も
含めて解消済み。加えて`docs/protocol.md`のレビュー規約に、
「過剰実装チェック」と「共通前提変更時の波及先チェック」の2項目を
今回の教訓として追加した（Rules 10-11）。

この監査分はコミット済み（`4b13e33`）。ChatGPT側connectorの再作成・
c2c-dev自身のBridge再起動も、この監査完了時点で既に実施済み。

**Kokuban（黒板）連携フック（2026-09-02、コミット `3b5bbcd`）**: bluecabi-personal-core
に実装したKokuban v0（Activity Event Log + API）へ、既存C2Cの状態確定地点
（このrepoの`c2c session set`コマンド）から自動的に状態遷移を報告する
opt-inフックを追加。`.c2c.json`に`kokuban`ブロックがあるworkspaceだけ動作し、
それ以外のworkspaceは完全に無変更（空workspaceで実地確認済み）。bearer tokenは
env var名（既定`KOKUBAN_WRITE_TOKEN`）でのみ参照し、値はログ・出力に一切含めない。
Kokuban側でのC2C独立レビュー（`c2c_kbp1`、bluecabi-personal-core側）で
DONE承認済み。詳細: `src/session/kokuban.ts`。

**Kokuban holderAfter/stopReason/summary拡張（2026-09-03、C2C `c2c_rev01`、
未コミット）**: 上記フックが従来送っていなかった`holderAfter`/`stopReason`/
`summary`をKokubanへ配線。`src/session/state.ts`の`WaitingFor`に`CONDITION`/
`EXTERNAL`を追加（BLOCKED時に「内部条件待ち」か「外部待ち」かを明示できる
既存パターンの拡張）。新設`deriveKokubanExtras()`（`src/session/kokuban.ts`）が
`waitingFor→holderAfter`を固定table（`USER→human`,
`GPT_PLAN`/`GPT_REVIEW→chatgpt`, `CONDITION→condition`,
`EXTERNAL→external`）でのみマップし、`knownIssues→stopReason`は直代入、
`summary`は`completedSubtasks`+`nextExpectedStep`+`knownIssues`を
（blank除外の上）機械的に連結するだけ — 自然言語推論は一切なし。
`reportKokubanTransition()`側で`holderAfter`/`stopReason`はBLOCKED以外に
絶対漏れないよう二重にguard。C2C独立レビュー2 iterationでDONE承認
（1回目でwhitespace-only blank filtering不備を指摘・修正）。

**Dead bridge由来のstale runtime state自動修復（2026-09-03、コミット `95518ea`）**:
実際に発生した接続障害（workspace Aのbridgeが異常終了→OSがAの旧portを
別workspace Bの新しいbridgeへ再割当→Aの古いstate fileが依然その port を
指したまま→health probeはBの健全な応答を返すため誤ったworkspaceIdとして
検知され、安全側で自動修復を拒否し続けていた）の根本修正。

- `findBridgeObservation`（`src/bridge/runtime.ts`）が新状態`"stale"`を判定:
  「portは別の生きたworkspaceとして応答」かつ「自分のpidは確認済みで死亡」の
  場合のみ。自分のpidがまだ生きている場合は従来通り`"unknown"`のまま拒否
  （PID再利用による誤判定を避けるための安全側判断）。
- `ensureBridge`/`doctor --fix`/`start`は`stale`を`stopped`と同様に自動修復対象
  として扱う。**別workspaceの生きたbridgeには一切触れない**（自分の古い
  pointerファイルを破棄して新規spawnするだけ、port選択は既存のfallback
  ロジックに委ねる）。
- `stopBridge`の既存の危険なバグ（mismatch/probe失敗時に無条件で
  `process.kill(runtime.pid)`していた — PID再利用時に無関係なプロセスを
  誤って殺すリスクがあった）も同時に修正。生存確認済みのPIDにのみsignalを送る。
- `RuntimeState.generation`（起動毎の新規random値、`/health`にも反映）を
  監査用に追加 — ただし安全性そのものを担保するのはPID生存確認であり、
  generationはあくまで「reclaim後は別インスタンスである」ことを証明する
  補助的な観測用フィールド。
- C2C独立レビュー（`c2c_stale1`、c2c-dev自身のworkspaceで実施）2ラウンドで
  DONE承認済み。1ラウンド目でChatGPTが実際の見落とし（`c2c status`コマンドが
  `findBridgeObservation`の別の呼び出し箇所として存在し、staleを未対応の
  まま素通り→stale状態のworkspaceに対して別workspaceへ実際にadmin
  リクエストを送ってしまうバグ）を発見、修正して再レビューでDONE。
- テスト216件green（新規5件、うち2件は実subprocessを使う統合テスト）・
  typecheck green。実際の障害シナリオを実subprocess 2つで再現
  （Aを`SIGKILL`→AのstateをBの生きているportを指すよう改竄→`doctor --fix`）
  し、Aが新portへ安全に再生成されBは終始無傷であることを手動でも確認済み。

以前、別ディレクトリ `G:\マイドライブ\Claude_Code\codex-with-chatgpt` を
正本として作業していたが、そちらの git が Google Drive 起因で壊れて
upstream から 15 コミット遅れていたことが判明し、このディレクトリ
（`C:\Users\KAYA\c2c-dev\codex-with-chatgpt`）を今後の唯一の作業拠点とする
方針に切り替え済み。

## 現在の正本
- README.md（プロジェクト概要）
- docs/architecture.md（アーキテクチャ）
- docs/imonikai-bootstrap.md（芋煮会機能の仕様）
- docs/protocol.md（C2C プロトコル）

## 今回通常読む資料
- git log（直近のコミット履歴、特に `95518ea`/`3b5bbcd`/`4b13e33` の中身）
- git status / git diff（未コミット差分がないか）
- src/bridge/runtime.ts（`findBridgeObservation`、healthy/stopped/stale/unknownの判定）
- src/process/daemon.ts（`ensureBridge`/`stopBridge`）
- src/session/kokuban.ts（Kokuban連携フック）
- src/cli/index.ts の imonikai 関連コード
- skill/SKILL.md, skill-claude-code/SKILL.md

## 重要な確定事項

- **stale bridge state（dead pid + 別workspaceによるport再利用）は自動修復可能、
  ただし別workspaceの生きたbridgeには絶対に触れない**（2026-09-03、`95518ea`）。
  安全性を担保しているのは「自分の記録したpidが確認済みで死亡している」ことのみ
  — pidがまだ生きている場合は`"unknown"`のまま常に拒否する。この判定を緩めたり、
  `findBridgeObservation`の新しい呼び出し元を追加する際は、必ず
  healthy/stopped/stale/unknownの4状態すべてを網羅すること（`c2c status`が
  一度これを見落とし、stale状態のworkspaceに対して別workspaceへ実際にadmin
  requestを送るバグになった実例あり）。

- `C:\Users\KAYA\c2c-dev\codex-with-chatgpt` が唯一の正式な作業拠点。
  `G:\マイドライブ\Claude_Code\codex-with-chatgpt` は旧拠点で、今後の作業には
  使わない（Google Drive による `.git` 破損リスクがあるため）。
- upstream (origin/main) と同期済み、独自の Claude Code アダプタ
  (`skill-claude-code/`) と「芋煮会」機能は upstream に存在しない、この
  fork 独自の追加機能。
- **Named Tunnel の `--zone` は必ず実際の Cloudflare zone apex を渡すこと**
  （`example.com` であって `c2c.example.com` のような1階層深いものではない）。
  Cloudflare の標準 Universal SSL 証明書は apex とその直下ワイルドカードしか
  カバーせず、それより深いホスト名は DNS ルーティング自体は成功するのに
  TLS ハンドシェイクが無言で失敗する（2026-09-02、実環境で確認済み。詳細は
  `docs/troubleshooting.md`）。
- `bin/c2c.js` はこの dev checkout では `dist/` が `src/` より古ければ
  自動的に `src/` 実行（tsx）にフォールバックする（2026-09-02追加）。それでも
  `dist/` は基本的に作らず削除したままにしておくこと — このリポジトリの
  デフォルト運用は「dev checkout では常に `src/` を直接実行」。

## 却下済み・廃止済み事項

- 独自の Named Tunnel 実装一式（`src/tunnel/fallback.ts`, `named-config.ts`,
  `named-setup.ts`, `select.ts`, `slug.ts` ※いずれも未コミットのまま破棄）—
  upstream が既に同等機能を正式実装・マージ済みだったため、重複実装を廃棄し
  upstream 版に統合した。

## 過去フェーズ
- 完了済み。通常参照不要
（G:\ 拠点での芋煮会機能の初期実装・E2E検証、upstream 未同期に起因する不具合の
発見と、C:\ 拠点への統合作業）
