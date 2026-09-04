# Project Context

## プロジェクトの目的

`codex-with-chatgpt`（Codex with ChatGPT / C2C Bridge）本体のソースチェックアウト。
このディレクトリ自身が、Codex/Claude Code から ChatGPT を計画・レビュー役として
使うためのブリッジ実装。README.md 参照。

## 現在地点（2026-09-04時点。必ず `git status`/`git log`/`npx vitest run` で
再確認してから信頼すること — このファイルはスナップショットであり、
自動的には更新されない）

`feature/claude-code-and-chat-fixation` ブランチ。直近のコミットは
`e8adcd0`（Kokuban write tokenのWindows DPAPI永続化）。

**working tree は dirty（OAuth Connector Reliability Hardening、下記参照、
未コミット）**:
- 変更: `src/auth/oauth.ts`, `src/auth/store.ts`, `src/bridge/runtime.ts`,
  `src/bridge/server.ts`, `src/cli/index.ts`, `src/pairing/manager.ts`,
  `src/process/daemon.ts`, `tests/dist-entrypoint.test.ts`
- 新規: `src/auth/oauth-log.ts`, `src/auth/oauth-self-test.ts`,
  `src/bridge/lock.ts`, `tests/oauth-connector-reliability.test.ts`,
  `tests/workspace-lock.test.ts`, `tests/fixtures/`（lock関連の実subprocess
  テスト用fixture一式）, `CONNECTOR_RELIABILITY_HARDENING_EXECUTED_REPORT.md`
  （このハードニング全体の詳細レポート — 経緯・設計判断・test証跡はすべて
  そちらが正本。このファイルは要約のみ）

テストは `npx vitest run` で **414 passed / 1 skipped, 27 files** green、
typecheck (`tsc --noEmit`)・build (`npm run build`) ともclean（上記未
コミット差分込みで確認済み）。

**まだcommitしていない** — 独立ChatGPT監査が継続中のため（下記参照）。

## 現在のフェーズ: OAuth Connector Reliability Hardening（進行中、未コミット）

実際に発生した本番インシデント（client-side health-probeの一時的失敗を
「bridgeが本当に落ちた」と誤判定し、同一workspaceに対して2つ目の生きた
bridgeプロセスを起動してしまい、ChatGPT側のtunnelが到達する側と
pairing/tokenを持つ側が食い違った）を根本修正する取り組み。独立した
ChatGPTチャットによる複数ラウンドの監査（`[C2C]`プロトコル、
`TASK_ID: c2c_oauth_connector_reliability_hardening`）を経て、現在
**round 5まで完了、次の独立監査待ち**。

**修正済みの領域**（詳細は `CONNECTOR_RELIABILITY_HARDENING_EXECUTED_REPORT.md`
の§2/§G/§Hが正本 — 以下は目次代わり）:
- OAuth consume-before-confirm / DCR・client lifecycle / observability /
  doctorの実OAuth自己診断 / `c2c restart`の実際の再起動不良（§2 A-E）。
- **Workspace単一インスタンス所有ロック**（`src/bridge/lock.ts`、これが
  本ハードニングの中核）: `startBridge()`が最初に排他ロックを取得し、
  同一workspaceに対する2つ目の生きたインスタンスを構造的に防ぐ（§F）。
- **Stale-lock reclaimレース**（§G）: 独立監査で4ラウンドにわたり
  BLOCKERが発見・修正された経緯があり、**設計は現在ラウンド4の
  「arbiter chain + release tombstone」方式で安定** — ラウンド5の監査では
  この設計自体への新規correctness BLOCKERは発見されず（test強化と
  report記述の精度修正のみが必要と判定）。詳細な設計の歴史（round 1〜5、
  各ラウンドで何が壊れていて何を直したか）は report の §G を参照——
  ここへ転記しない。
- **Doctorの自己診断が実pairingを破壊しうる問題**（§H）を修正
  (`PairingManager.createIfNoneActive()` + `/admin/pairing/if-idle`)。

**既知の未解決・deferred事項**（このハードニングのスコープ外、report §6
が正本）:
- **Desktop起点のOAuth callback失敗**: `chatgpt.com`のconnector-callback
  エンドポイントが、Web/Chrome起点では`HTTP 200`（動く）、Desktopアプリ
  起点では`HTTP 302`直接リダイレクト（`codex://`へのOS起動が完了せず
  失敗）を返す。C2C側コードは両条件で完全に同一のレスポンスを返すことを
  確認済み — C2C側の問題ではない。**運用上の回避策: このworkspaceへの
  ChatGPT connector Reconnectは常にWeb/Chromeから行うこと（Desktopアプリ
  からは行わない）。**
- **過去のstale OAuth registration / "Unknown client"障害**（本ハードニング
  以前に発生、当時はconnectorの削除・再作成で解消）: 現行コードで
  再現・修正確認は未実施。deferredのまま。
- **Execution-record visibility mismatch**: ローカルの`c2c record`実行
  記録がChatGPT側MCP (`test_status`/`execution_summary`/`execution_output`)
  から見えない/古い問題。本ハードニングとは無関係、未修正・deferred。
  そのため本レポートのtest件数はこのリポジトリへの直接アクセスでのみ
  独立検証可能（connector自身のexecution-record toolsでは検証不可）。
- 実際に発生したCloudflare Error 1033の障害は、検知・復旧（`doctor --fix`）
  は確認済みだが、bridge/cloudflaredプロセスが停止した根本原因そのものは
  未特定・未修正（report §6.2）。

**次にやること**: 新規ChatGPTチャットでlock lifecycleを重点にもう一度
独立監査 → 承認されれば初めてcommit。それまでは上記dirty treeを保持し、
このタスク以外の理由で不要に触らないこと。

## 現在の正本
- README.md（プロジェクト概要）
- docs/architecture.md（アーキテクチャ）
- docs/imonikai-bootstrap.md（芋煮会機能の仕様）
- docs/protocol.md（C2C プロトコル）
- **CONNECTOR_RELIABILITY_HARDENING_EXECUTED_REPORT.md**（現在進行中の
  OAuth Connector Reliability Hardeningの詳細 — 設計の経緯、各監査
  ラウンドで見つかったBLOCKERと修正、test証跡、explicit non-claims。
  このファイルの「現在のフェーズ」節はこのreportの要約に過ぎない）

## 今回通常読む資料
- git log / git status / git diff（未コミット差分の正確な範囲の確認）
- npx vitest run（現在のtest件数の確認 — このファイルの数字を鵜呑みにしない）
- src/bridge/lock.ts（workspace単一インスタンスロックの現行実装、
  round 5時点の設計はこのファイル自身のdocコメントが最も正確）
- tests/workspace-lock.test.ts（lock関連の全regression test）
- src/bridge/server.ts（`startBridge()`がロックを取得する箇所）
- CONNECTOR_RELIABILITY_HARDENING_EXECUTED_REPORT.md

## 重要な確定事項

- **`C:\Users\KAYA\c2c-dev\codex-with-chatgpt` が唯一の正式な作業拠点**
  （`G:\マイドライブ\Claude_Code\codex-with-chatgpt`は旧拠点、Google Drive
  由来の`.git`破損リスクがあるため使わない）。
- upstream (origin/main) と同期済み。独自のClaude Codeアダプタ
  (`skill-claude-code/`) と「芋煮会」機能はupstreamに存在しない、この
  fork独自の追加機能。
- stale bridge state（dead pid + 別workspaceによるport再利用）は自動修復
  可能、ただし別workspaceの生きたbridgeには絶対に触れない（`95518ea`、
  `findBridgeObservation`のhealthy/stopped/stale/unknown 4状態の判定）。
  この判定を緩めたり新しい呼び出し元を追加する際は4状態すべてを網羅する
  こと。
- **Named Tunnelの`--zone`は必ず実際のCloudflare zone apexを渡すこと**
  （`example.com`であって`c2c.example.com`のような1階層深いものではない
  — Universal SSL証明書がapexとその直下ワイルドカードしかカバーしない
  ため、より深いホスト名はTLSハンドシェイクが無言で失敗する）。
- `bin/c2c.js`はこのdev checkoutでは`dist/`が`src/`より古ければ自動的に
  `src/`実行（tsx）にフォールバックする。それでも`dist/`は基本的に作らず
  削除したままにしておくこと — デフォルト運用は「dev checkoutでは常に
  `src/`を直接実行」。

## 却下済み・廃止済み事項

- 独自のNamed Tunnel実装一式（`src/tunnel/fallback.ts`等、未コミットの
  まま破棄）— upstreamが既に同等機能を正式実装・マージ済みだったため。

## 過去フェーズ（完了・コミット済み。通常参照不要）

- Kokuban（黒板）連携: 状態遷移の自動報告フック追加(`3b5bbcd`)、
  holderAfter/stopReason/summary拡張、durable outbox化・default-ON化
  (`6d0d566`)、write tokenのWindows DPAPI永続化(`e8adcd0`)。
- Dead bridge由来のstale runtime state自動修復(`95518ea`)。
- Connector reliability: LOCAL/REMOTE分離・self-test token・fail-closed
  destructive-repair authorization(`8820591`)、duplicate-checkout可視化・
  doctor fault-injection tests(`3e90b50`)。
- 2026-09-02、ChatGPTによる独立MCP監査（`c2c_full_audit_fix`、6ラウンド）
  完了・DONE(`4b13e33`)。
- G:\ 拠点での芋煮会機能の初期実装・E2E検証、upstream未同期に起因する
  不具合の発見と、C:\ 拠点への統合作業。
