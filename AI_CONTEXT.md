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
上に作り直してコミット済み（`b01eebf`）。直近のコミットは `88092f3`
（独立したChatGPT監査による2件の修正）。

working tree は **dirty**（`c2c_full_audit_fix` の実装が未コミット —
変更対象: `src/auth/oauth.ts`, `src/auth/store.ts`, `src/bridge/server.ts`,
`src/cli/index.ts`, `src/process/daemon.ts`, `src/tunnel/hostname.ts`,
`src/tunnel/named-provision.ts`, `src/tunnel/state.ts`, `package.json`,
`src/config/connectorConfirmation.ts`（新規）, `src/cli/run.ts`（新規、CLIの
実エントリポイント）, `bin/c2c.js`, `docs/protocol.md`,
`docs/imonikai-bootstrap.md`, `docs/troubleshooting.md`, `skill/SKILL.md`,
`skill-claude-code/SKILL.md`, および対応テスト）。
**この行を含め、記載内容は都度の `git status`/`git log` で必ず裏取りしてから
信頼すること — 過去、working tree clean/テスト153件という記述が実態と
2日以上ズレたまま放置されていたことが2026-09-02の監査で判明している。**

テストは `npx vitest run`（デフォルト、外部ネットワーク不要）で200件green
+ 1件skip、typecheck・buildともclean（`tests/`はtsconfigのexclude対象で、
`tests/mcp-integration.test.ts`/`tests/pairing.test.ts`に本件と無関係な
既存の型エラーが残っている — 実行時はgreen）。実cloudflared/実ネットワーク
依存の1テストは`C2C_TEST_NETWORK=1 npx vitest run`でのみ動くopt-in smoke
testとして分離済み。

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

**次のステップ（未実施）**: コミット、ChatGPT側の旧connector整理、
c2c-dev自身のBridge再起動は、この監査完了を受けて別途ユーザーの指示で
行う。

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
- git log（直近のコミット履歴、特に `d4dbf5f` マージコミットの中身）
- git status / git diff（未コミット差分がないか）
- src/cli/index.ts の imonikai 関連コード
- skill/SKILL.md, skill-claude-code/SKILL.md

## 重要な確定事項

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
