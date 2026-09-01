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
上に作り直してコミット済み（`b01eebf`）。ビルド・テスト(153件)とも green。

working tree はクリーン（コミット未済みの変更なし）。

## 現在のフェーズ

「芋煮会」機能の実機監査（このタスク自体）。以前、別ディレクトリ
`G:\マイドライブ\Claude_Code\codex-with-chatgpt` を正本として作業していたが、
そちらの git が Google Drive 起因で壊れて upstream から 15 コミット遅れていた
ことが判明し、このディレクトリ（`C:\Users\KAYA\c2c-dev\codex-with-chatgpt`）を
今後の唯一の作業拠点とする方針に切り替えた直後。

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

## 却下済み・廃止済み事項

- 独自の Named Tunnel 実装一式（`src/tunnel/fallback.ts`, `named-config.ts`,
  `named-setup.ts`, `select.ts`, `slug.ts` ※いずれも未コミットのまま破棄）—
  upstream が既に同等機能を正式実装・マージ済みだったため、重複実装を廃棄し
  upstream 版に統合した。

## 過去フェーズ
- 完了済み。通常参照不要
（G:\ 拠点での芋煮会機能の初期実装・E2E検証、upstream 未同期に起因する不具合の
発見と、C:\ 拠点への統合作業）
