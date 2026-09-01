---
name: codex-with-chatgpt
description: >
  Use ChatGPT (web) as the planning and review brain for Claude Code coding
  sessions, while Claude Code keeps full execution ownership. Use when the
  user says "使用 Codex with ChatGPT 完成配置" / "Connect ChatGPT to Claude
  Code" / "用 ChatGPT 规划这个任务" / "Set up Codex with ChatGPT for Claude
  Code", when they ask to connect ChatGPT to the current workspace,
  disconnect it, or run a task through the ChatGPT planning loop from
  Claude Code. The user's personal codename for this whole workflow is
  "芋煮会" (imonikai) — ANY message containing "芋煮会" (e.g. "芋煮会で",
  "芋煮会で進めてください", "芋煮会で検討して") means: use this skill now
  (or continue the already-open C2C conversation for this workspace) for
  planning/review/debugging, exactly as if they had asked to use Codex with
  ChatGPT. This applies from the very first message of a session onward —
  do not wait for the phrase to repeat before treating it as standing intent
  to route the task through ChatGPT via C2C.
---

# Codex with ChatGPT — Claude Code adapter

ChatGPT thinks. Claude Code works.

You (Claude Code) own execution: editing, shell, git, tests, recovery.
ChatGPT owns high-level reasoning: understanding, planning, review, debug
strategy. The C2C Bridge gives ChatGPT read-only MCP access to the current
workspace, so control messages between you and ChatGPT stay tiny (< 1 KB) —
ChatGPT pulls whatever data it needs by itself.

This is the Claude Code adapter for the same `codex-with-chatgpt` project
that also ships a Codex adapter (`skill/SKILL.md`). The C2C Bridge, its
OAuth/pairing, workspace read-only access and MCP tools are 100% shared —
only how a browser is driven and how the local sandbox/permission model
works differ, and those differences are called out explicitly below. See
`docs/architecture.md` and `docs/security.md` for the parts that never
change regardless of which coding agent is driving.

**Golden rules**

1. NEVER paste file contents, diffs, or logs into ChatGPT. ChatGPT reads them through MCP.
2. NEVER show the user technical internals (MCP, OAuth, PKCE, tunnel, ports, localhost).
   Speak in terms of "连接 ChatGPT / 安全连接 / 配对" (the CLI's own output already
   does this — relay it, don't re-explain it).
3. The pairing code is the ONLY credential you may ever type into a browser.
   Never touch OAuth tokens, cookies, or session storage.
4. If something fails, run `c2c doctor --agent claude-code` and repair silently.
   Only involve the user for logins, CAPTCHA, 2FA, or explicit consent
   screens — and then give them ONE action.
5. **Browser tool.** Claude Code has no single built-in "computer use" API for
   ChatGPT the way Codex does. Instead:
   - At the start of the session, check which browser-automation MCP tools are
     actually available to you (e.g. `mcp__Claude_Browser__*` — an isolated,
     sandboxed browser pane — or `mcp__claude-in-chrome__*` — automation of the
     user's real Chrome with their existing logins — or any other
     browser-automation MCP server the user has configured). Do not hardcode
     a tool name into how you think about this workflow; use whichever is
     present, consistently, for every ChatGPT step below.
   - Prefer an isolated/sandboxed browser surface (e.g. the Claude Browser
     pane) over repeatedly automating the user's personal daily-driver
     browser, for the same reason Codex's own Skill avoids it: this workflow
     opens, foregrounds, and types into the ChatGPT tab often, and that is
     disruptive in a browser the user is actively using for other things.
     If the only browser-automation tool available is one that controls the
     user's real browser (e.g. Claude in Chrome), that is fine to use — just
     tell the user once that ChatGPT setup will use their browser tab.
   - If NO browser-automation tool is available at all, say so once, suggest
     the user enable one (Claude Browser / "Claude in Chrome" extension /
     equivalent), and wait — do not attempt to guide the user through manual
     clicking as a substitute for a first-time setup you cannot verify.
   - The ONLY exception to using your own browser tool: the user explicitly
     says a Cloudflare login step must happen in their own separately-opened
     browser session — that single step may go through their own browser;
     everything else stays in the browser-automation tool you are using for
     this workflow.
6. Reuse ONE ChatGPT conversation per workspace (see Conversation management).
   Never silently start a new chat. Each workspace also has exactly ONE
   ChatGPT connector, shared with Codex if this workspace is ever also used
   from Codex (see § Shared workspace, shared connector). Do not create a
   second connector for the same workspace. Other workspaces may have their
   own connectors — never edit those.
7. **No sandbox allowlist step.** Codex's adapter runs `c2c sandbox-allow`
   because Codex has its own filesystem sandbox that must be told where C2C's
   state directory lives. Claude Code has no equivalent sandbox — it uses its
   own permission-prompt model for shell/file access. Never run
   `c2c sandbox-allow` from this adapter, and always call `c2c setup` /
   `c2c doctor` with `--agent claude-code` so the Bridge does not try to
   write a Codex config file on this machine on your behalf. The first time
   you run any `c2c` command via your shell tool, Claude Code's normal
   permission prompt is expected — that is sufficient, nothing extra to set up.
8. ChatGPT pages: only the URLs in **ChatGPT browser workflow** below. Never
   start from chatgpt.com and click through menus.
9. **Doctor gate.** After `c2c doctor -w <workspace> --agent claude-code --json`,
   do not open ChatGPT and do not send `[C2C]` until local is green — except
   the reconnect settings pages when `chatgptRepair.needed` is true. Not green:
   - `report.bridge.ok` is not true
   - `report.mcp.ok` is not true (unauthenticated local `/mcp` must be 401)
   - this workspace used to have a public URL and the tunnel is down
   - `chatgptRepair.needed` is true (fix the connector first, then doctor again)
   (`report.sandbox` will read "不适用（Claude Code 使用自身权限模型）" — that is
   expected and does not block the gate.)
   A ChatGPT-side 401 after a sent message is different: repair then, do not
   treat it as permission to skip this gate next time.
10. **Stay on normal Chat; auto-dismiss Work suggestions.** Keep every
    ChatGPT interaction on the normal Chat surface. If ChatGPT offers to
    switch to Work, dismiss it yourself without asking the user, and never
    select the affirmative ("Use Work" / "Switch to Work" / ...) option. Full
    detection/dismissal policy, config (`chatgptSurface` /
    `rejectWorkSuggestion` in `.c2c.json`, read via
    `c2c chatgpt-policy -w <workspace> --json`), and user-fallback conditions
    live in `docs/chatgpt-interaction-policy.md` — this is shared verbatim
    with the Codex adapter so behavior is identical either way. Apply it
    every time the ChatGPT tab is opened or foregrounded, and after every
    `[C2C]` message is sent. Failing to dismiss a suggestion never fails the
    C2C connection itself (see that doc's Fail-safe section). Verify the
    dialog actually closed by re-reading the page — do not trust a click
    tool call's success/timeout status alone, since browser-automation
    input delivery can fail silently (observed live; see that doc's "Known
    limitation" section). Cap retries at ~2 verified attempts, then fall
    back to the user with the two-step manual sequence in that section
    instead of retrying indefinitely; report such a run honestly as manual,
    not automated, dismissal.
11. **Project bootstrap via `AI_CONTEXT.md`.** At the start of every coding-task
    session (see workflow below), check whether `AI_CONTEXT.md` exists at the
    workspace root; if not, create an initial version yourself before opening
    the ChatGPT conversation, grounded only in things you can verify (README,
    docs, git state, the user's instructions, anything just confirmed with
    ChatGPT) — never guess. ChatGPT never writes this file (it has no write
    tool); only you do, informed by what ChatGPT confirms. Full spec, template,
    and update rules: `docs/ai-context.md` — shared with the Codex adapter.

## ChatGPT browser workflow

Using whichever browser-automation MCP tool you identified under golden
rule 5:

1. **One tab.** Open the ChatGPT tab once and reuse it for the whole session
   — do not open a second ChatGPT tab, and do not navigate away and back
   unnecessarily. If a tab already shows chatgpt.com, reuse it.
2. **Foreground it** for first-time setup and while chatting, so the user can
   watch and step in for logins/CAPTCHA/2FA if needed.
3. **URLs only** (same tab — never hunt through menus):
   - Developer mode: `https://chatgpt.com/#settings/Security`
   - Connectors hub: `https://chatgpt.com/plugins`
   - Add connector: `https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins`
   - New conversation (only if no saved session): `https://chatgpt.com/`
   - Saved C2C chat: the URL from `c2c session`
4. **Do not wait for 8 tools** on the settings page. "Connected" / authorize
   success / pairing accepted is enough. Confirm tools by calling
   `workspace_info` from inside the conversation instead.
5. **Apply golden rule 10** (Work-suggestion check) right after foregrounding
   the tab and right after sending any `[C2C]` message.
6. **Wait for a ChatGPT reply without blocking.** After sending INIT,
   EXECUTED, the boot prompt, or the `workspace_info` check: keep the tab
   foregrounded and do a cheap read of the page every 20–30 seconds rather
   than one long blocking wait. Still generating → wait again (do not type,
   do not resend). A visible reply with `STATE: ...` → read it and continue
   the protocol. A visible error → repair, do not start a new chat. A tool
   timeout by itself is not failure — re-check the same tab.
7. **One conversation.** The first ChatGPT chat you open for a workspace is
   the C2C conversation. Send the boot prompt and the `workspace_info` check
   there, then save that URL (see Conversation management). Do not open a
   throwaway verification chat and a separate "real" chat later.

## Locations

- The codex-with-chatgpt checkout lives at: `<CHECKOUT_PATH>`
  (installer/update MUST replace this line in the installed Skill with the
  user's actual checkout path — see the update workflow below for how it
  stays correct. Never leave the literal placeholder text in an installed
  copy: a second unresolved `<CHECKOUT_PATH>` elsewhere in this file is
  interpreted per the next bullet, not as something to fill in separately.)
- CLI: let `<checkout>` mean the path on the previous line; run
  `node "<checkout>/bin/c2c.js" <command>` (or `c2c <command>` if
  globally linked). All commands support `--json` for parsing, and every
  `setup`/`doctor` call from this adapter must include `--agent claude-code`.
- If the checkout has no `node_modules` or no `dist/`, first run
  `corepack pnpm install && corepack pnpm build` inside it (or `npm install`
  if `pnpm`/`corepack` are unavailable — the build output is the same).
- Always pass `-w <workspace root>` (the project the user is working on, NOT
  the c2c repo itself).

## Daily update check

At the START of every workflow below (before anything else), run:

1. `c2c update-check --json`
2. (No `sandbox-allow` step here — see golden rule 7.)

- `{ "updateAvailable": false }` → continue silently. Never mention the check.
- `{ "updateAvailable": true }` → tell the user one line:
  "检测到 Codex with ChatGPT 有新版本，我先更新一下（约 1 分钟），随后继续你的任务。"
  Then run the update workflow below, and CONTINUE the original task afterwards.

## Workflow: update（"更新 Codex with ChatGPT"，or triggered by the daily check）

Inside the checkout directory (see Locations):

1. `git pull --ff-only` (if it fails due to local edits: `git stash && git pull --ff-only`).
2. `corepack pnpm install && corepack pnpm build` (or `npm install && npm run build`).
3. Re-install this adapter's Skill: copy `skill-claude-code/SKILL.md` to
   `~/.claude/skills/codex-with-chatgpt/SKILL.md` (personal, cross-project —
   see `%USERPROFILE%\.claude\skills\` on Windows), then fix the "checkout
   lives at:" line in the copy to the actual checkout path.
4. `c2c restart -w <workspace>` so the bridge runs the new code, then
   `c2c update-check --force --json` to refresh the cache (should now report up to date).
5. Tell the user "✓ 已更新到最新版本" — then resume whatever task triggered this.
   (The updated SKILL.md takes effect from the next Claude Code session; that's expected.)

## Workflow: 芋煮会（zero-touch, works on a brand-new workspace too）

This is the primary entry point once "芋煮会" appears anywhere in the
user's message — it supersedes needing a separate "首次配置" request first.
Full shared spec: `docs/imonikai-bootstrap.md` — identical to the Codex
adapter's version of this workflow, only the browser-driving mechanics
differ (§ ChatGPT browser workflow above). Never ask the user to run
`c2c setup`, `c2c tunnel choose`, or create the ChatGPT connector
themselves — this workflow does all of that.

1. `c2c imonikai status -w <workspace> --agent claude-code --json`.
2. If `needsInit` is `false` and `tunnel.permanentUrlConfigured` is `true`:
   skip straight to step 5 below (Project Bootstrap) — everything is already
   set up, reuse it as-is. Do not call `imonikai init` again, do not touch
   the tunnel or connector.
2b. If `needsInit` is `false` but `tunnel.permanentUrlConfigured` is
   `false`: this workspace already has a working connection, just not a
   fixed hostname yet (e.g. it was set up before a `--zone` was known).
   `needsInit` alone does NOT mean "nothing to do" — it only reflects OAuth
   authorization, not the tunnel. Run step 3 below anyway: `imonikai init`
   is safe to call on an already-initialized workspace; it only attempts
   the named-tunnel upgrade and never recreates the existing connector or
   forces reauthorization by itself. After it returns, run
   `c2c doctor -w <workspace> --agent claude-code --json`: if the tunnel
   URL actually changed (`chatgptRepair.needed` is `true`), follow
   **Workflow: reconnect after address reclaim** to Delete + recreate the
   *existing* connector — never a second one for this workspace. If
   `chatgptRepair.needed` is `false` (the upgrade fell back to Quick Tunnel
   again, or nothing changed), continue straight to step 5 with the
   existing connection as-is.
3. If `needsInit` is `true`: run
   `c2c imonikai init -w <workspace> --agent claude-code --zone <domain> --json`
   (omit `--zone` if you don't have one yet; `--hostname <full-hostname>`
   instead if the workspace name isn't ASCII-friendly — propose a sensible
   one yourself, e.g. "芋煮会商事" -> `--hostname imonikai.c2c.<domain>` —
   see `docs/imonikai-bootstrap.md` § Hostnames for non-ASCII workspace names).
   - If it asks for a Cloudflare login (first time only, this machine),
     follow it — one browser action, on the user's own machine (this uses
     the OS default browser via `cloudflared`, not your browser-automation
     tool).
   - It always succeeds with at least a Quick Tunnel — check
     `permanentUrlConfigured`; if a named-tunnel attempt fell back this run,
     the response's `repairs` explains why. This never blocks the task.
4. Using the `mcpUrl` / `connectorName` / `pairingCode` from step 3 (or from
   `status` if you skipped init): follow **Workflow: first-time setup**
   steps 4–5 below to create/edit the ChatGPT connector, authorize it, send
   the boot prompt, and save the session — this part still needs your own
   browser control; the Bridge itself never touches a browser.
5. **AI_CONTEXT.md check** (see golden rule 11 / `docs/ai-context.md`): if
   `status.aiContext.exists` was `false`, create an initial version now,
   grounded only in what you can verify — never guess.
6. Continue directly into **Workflow: coding task**, starting at step 3
   (send INIT) — step 2 (open conversation / boot prompt) is already done
   by step 4 above.
7. On DONE: update `AI_CONTEXT.md` per **Workflow: coding task** step 10,
   same as any other task.

## Workflow: first-time setup（"使用 Codex with ChatGPT 完成首次配置" / "Connect ChatGPT to Claude Code"）

1. Detect prerequisites yourself: `node --version` (>= 20), and check for
   `cloudflared`. If missing, install it yourself and tell the user only if
   it requires elevated permissions you don't have (macOS: `brew install
   cloudflared`; Windows: `winget install Cloudflare.cloudflared`).
2. If the c2c repo has no `node_modules`, run
   `corepack pnpm install && corepack pnpm build` in it (or the npm
   equivalent).
3. Run: `c2c setup -w <workspace> --agent claude-code --json`.
   → returns `{ mcpUrl, pairingCode, workspaceName, connectorName, ... }`.
   `connectorName` is this workspace's plugin title — it is the SAME
   connector Codex would use for this workspace (see § Shared workspace,
   shared connector below); legacy installs stay `Codex with ChatGPT`,
   additional workspaces get `Codex with ChatGPT · <name>`.
   Pairing codes expire in ~5 minutes: run `c2c pair --json` for a fresh one
   if you're slow.
4. Open ChatGPT using the **ChatGPT browser workflow** above. Foreground the
   tab. Same tab, navigate only to the listed URLs:
   - Developer mode: enable "Developer mode" if it is off.
   - Already has this `connectorName`: go to the connectors hub and **Delete**
     it (never Reconnect, never edit-in-place — the old Server URL may be
     stale). Then go to "Add connector" and create it again.
   - Does not exist yet / just deleted: open "Add connector", and operate
     ONLY on `connectorName` from step 3:
     - Never rename, delete, or edit a connector that belongs to another workspace.
     - Description: `Securely connect ChatGPT to the current Codex/Claude Code workspace for planning and review.`
     - Server URL: the `mcpUrl` from step 3
     - Authentication: OAuth
   Then Connect / Authorize and type the pairing code. As soon as it shows
   Connected / authorized / pairing accepted, continue — do NOT wait for 8
   tools on this page.
5. Same tab: go to `https://chatgpt.com/` (this IS the C2C conversation, not
   a throwaway). Send the boot prompt from `docs/protocol.md` § Boot Prompt,
   then (same chat) send:
   `Use the "<connectorName>" connector: call workspace_info and read a hello-style top-level file. Reply with the workspace name.`
   Confirm the reply matches `workspaceName`. Save the chat URL with
   `c2c session set` (see Conversation management).
6. Report to the user exactly in this shape (no internals):

```
Codex with ChatGPT (Claude Code)

✓ 当前项目已识别
✓ Workspace Bridge 已启动
✓ 安全连接已建立
✓ ChatGPT 已连接
✓ 文件读取测试通过

Ready.
```

If a login wall appears (ChatGPT, Cloudflare): stop, tell the user the ONE
thing to do ("请登录 ChatGPT，完成后告诉我'好了'"), then continue.

## Shared workspace, shared connector

Codex and Claude Code are both first-class coding-agent adapters for the
same C2C Bridge. The Bridge, its OAuth tokens, its ChatGPT connector, and
its saved conversation are all per-*workspace*, not per-agent — they were
never agent-specific to begin with (the Bridge doesn't know or care which
process called its MCP endpoint). Practically:

- Do not create a second connector, a second pairing flow, or a duplicated
  `.c2c.json` just because Claude Code (rather than Codex) is driving this
  workspace. If `c2c doctor`/`c2c setup` reports an existing connector or
  saved session for this workspace, reuse it exactly like Codex would.
- The project intentionally does not support Codex and Claude Code writing
  to the same workspace *concurrently* in this version. Whichever agent the
  user is actively using for a task is the one that executes it; do not
  attempt to coordinate simultaneous edits with a Codex session running
  elsewhere.
- If the saved C2C conversation was built up by Codex (or vice versa), that
  is fine — it's the same protocol (`docs/protocol.md`), and ChatGPT does
  not need to know which agent is currently on the other end.

## Conversation management (one chat per workspace)

The workspace has ONE long-lived C2C conversation in ChatGPT. Do not open a
new chat per task or per Claude Code session.

- **Find it**: `c2c session -w <ws> --json` → `{ session: { url, taskId, ... } }`.
  If a session exists, open that URL in the same tab (foreground it) and
  continue there.
- **Save it**: right after creating a new C2C chat (boot prompt sent), read
  the conversation URL from the browser's address bar (visible UI state
  only) and run `c2c session set -w <ws> --url <url> --title "C2C <workspace name>"`.
- **Update it**: after each EXECUTED/DONE, run
  `c2c session set -w <ws> --task <id> --iteration <n> --state <STATE>`.
- **Switch it** ONLY when (a) the user explicitly asks for a new chat, or
  (b) the current chat has become so long it visibly lags. When switching:
  1. Same tab: go to `https://chatgpt.com/`, send the boot prompt.
  2. Immediately send a HANDOFF message (template in `docs/protocol.md`) —
     a short brief of: original goal, iterations so far, what is already
     DONE, current state, known issues, and the next expected step. The new
     chat must be able to continue the task without re-asking anything; it
     re-reads code via MCP, so never paste files into the handoff.
  3. `c2c session set` with the new URL (this overwrites the old one).
- If the saved chat 404s or was deleted, treat it as a switch: new chat +
  boot prompt + HANDOFF reconstructed from `c2c session get` and recent
  `execution_summary` records.

## Workflow: coding task（"使用 Codex with ChatGPT 完成 XXX" via Claude Code）

Protocol states: INIT → PLAN → EXECUTING → EXECUTED → REVIEW → (PLAN | DONE | BLOCKED).
All control messages start with `[C2C]`. Keep Claude Code→ChatGPT messages
under 1 KB. ChatGPT's replies are expected to be substantive (see step 4).
Docs: `docs/protocol.md`.

0. `c2c doctor -w <workspace> --agent claude-code --json` (auto-repairs).
   **Doctor gate:** if local is not green, do not open ChatGPT and do not
   send INIT. If `chatgptRepair.needed` is true, tell the user
   `chatgptRepair.userMessage` (one paragraph, no internals), run
   **Workflow: reconnect after address reclaim**, then doctor again and only
   continue when the gate is green. Generate task id: `c2c_` + 4 random hex
   chars.
1. **AI_CONTEXT.md check.** If `<workspace>/AI_CONTEXT.md` does not exist,
   create an initial version now (see `docs/ai-context.md` — template,
   grounding rules). If it exists, no local action needed; the boot prompt
   already tells ChatGPT to read it via MCP before planning.
2. Open the saved C2C conversation (`c2c session --json`); only navigate to
   `https://chatgpt.com/` if none is saved. Foreground the tab. On a NEW
   conversation first send the boot prompt from `docs/protocol.md` § Boot
   Prompt, then save the session URL. Do not use the browser to re-read code
   MCP already provides. After sending a control message, wait per
   **ChatGPT browser workflow** § 6.
3. Send INIT with the user's goal:

```
[C2C]
STATE: INIT
TASK_ID: c2c_f81a
ITERATION: 0

GOAL:
<user's goal, one paragraph>

INSTRUCTION:
Inspect the connected workspace through the Codex with ChatGPT MCP connector.
Produce a C2C PLAN message.
```

4. Wait for ChatGPT's `STATE: PLAN` reply (**ChatGPT browser workflow** § 6 —
   short checks, same tab; a browser-tool timeout is not failure). Read
   GOAL/ACTIONS/TESTS/SUCCESS_CRITERIA. A good PLAN also carries RATIONALE
   and concrete natural-language edit suggestions (which file, what to
   change, why). If the reply is a bare one-liner with no rationale or
   file-level guidance, ask once: "Please expand the plan with rationale and
   concrete per-file suggestions."
5. Execute the plan yourself with your own tools (Read/Edit/Write/Bash/git;
   your own judgment). ChatGPT does not micro-manage tool calls.
6. Record the execution so ChatGPT can read it via MCP:
   `c2c record -w <ws> --task c2c_f81a --iteration 1 --changed-files "src/a.ts,src/b.ts" --tests "27 passed" --exit-status ok`
7. Send EXECUTED (no diffs, no logs):

```
[C2C]
STATE: EXECUTED
TASK_ID: c2c_f81a
ITERATION: 1

RESULT:
Execution finished.

CHANGED_FILES:
4

TESTS:
27 passed

Please independently inspect the workspace and current git diff through MCP.
```

8. ChatGPT reviews via MCP (git_diff, read_file, test_status) and replies
   DONE / PLAN (next iteration) / BLOCKED.
9. Loop. Respect maxIterations (`.c2c.json`, default 12). At the limit, pause
   and ask the user: "已完成 12 轮协作，仍有未解决问题，是否继续？"
10. On DONE: summarize the result to the user in plain language. Then update
    `AI_CONTEXT.md` if this task actually changed the project's current
    state (phase, confirmed decisions, newly obsolete items) — grounded in
    the real diff, test results, and what was just confirmed with ChatGPT,
    never in the mere fact that a task finished. See `docs/ai-context.md`
    § Updating it. If nothing about the project's current state changed,
    leave the file alone.
11. On BLOCKED: read ChatGPT's reason, fix what you can, or surface the
    single decision the user must make.

## Workflow: disconnect（"断开 ChatGPT"）

1. `c2c unpair -w <workspace>` (revokes all tokens immediately).
2. Optionally remove the connector on the connectors hub page. Only touch
   this workspace's `connectorName`.
3. Tell the user: "已断开 ChatGPT 对该项目的访问。"

## Workflow: reconnect after address reclaim（全关掉以后地址失效）

This is the normal case when the user quit Claude Code / the terminal / the
machine: the previous public address is gone. Doctor already started a new one.
`connectorAction: "update"` means Delete + create again — not Reconnect.

`c2c doctor --agent claude-code --json` will look like:
`{ "chatgptRepair": { "needed": true, "connectorAction": "update", "connectorName": "...", "userMessage": "...", "mcpUrl": "...", "pairingCode": "...", "pages": { ... } } }`

1. Tell the user exactly `chatgptRepair.userMessage`. Then you repair. Do not
   ask them to click around ChatGPT unless a login wall appears. Do not open
   the C2C chat and do not send `[C2C]` until this repair finishes and a
   follow-up doctor is green. Never "try a message first to see if it works".
2. Same tab as setup. Settings URLs only until Connected — never hunt menus:
   - Developer mode: `https://chatgpt.com/#settings/Security`
   - Connectors hub (only used to Delete): `https://chatgpt.com/plugins`
   - Add connector (always required after Delete): `https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins`
3. Operate ONLY on `chatgptRepair.connectorName`. Never touch another
   workspace's connector.
   - If that exact name exists on the connectors hub: **Delete** it. Confirm
     the delete if ChatGPT asks. **Never click Reconnect, Refresh, Connect,
     or Edit** on the old card — the old Server URL is dead and the page will
     hang on "This site cannot be reached".
   - Then go to the Add connector URL and create that **same**
     `connectorName` (do not invent a second name):
     - Description: `Securely connect ChatGPT to the current Codex/Claude Code workspace for planning and review.`
     - Server URL: `chatgptRepair.mcpUrl`
     - Authentication: OAuth
     Then Connect / Authorize and type `chatgptRepair.pairingCode` (or
     `c2c pair --json` if it expired). Continue as soon as it is Connected —
     do not wait for 8 tools on the settings page.
   - If the name is already gone, skip Delete and only create.
4. `c2c doctor --agent claude-code --json` again. Same tab: go to the saved
   conversation (`c2c session`) only after the Doctor gate is green. Do not
   start a new audit/task chat just because the address changed.
5. If the ChatGPT conversation was lost, follow Conversation management →
   Switch: new chat, boot prompt, HANDOFF. No file re-uploading (the
   workspace lives in MCP).

## Workflow: repair（anything looks broken）

1. `c2c doctor -w <workspace> --agent claude-code --json`. Doctor gate: do
   not open ChatGPT / send `[C2C]` until local is green, except reconnect
   settings pages.
2. If `chatgptRepair.needed`, follow **reconnect after address reclaim**,
   then doctor again.
3. Otherwise apply the recovery map. Only involve the user for login / 2FA /
   CAPTCHA — one action.

## Recovery map

| Symptom | Action |
| --- | --- |
| Bridge not running | `c2c start` (doctor does this automatically) |
| Tunnel dead / URL unreachable / 全关掉后连接失效 | `c2c doctor --agent claude-code` → if `chatgptRepair.needed`, tell the user the message, then update THIS workspace's connector only (`connectorName`). |
| ChatGPT says tool call failed / 401 | token expired or revoked → re-pair (new pairing code + authorize) |
| Pairing code rejected/expired | `c2c pair --json` for a fresh code |
| Port conflict | handled automatically; never surface to the user |
| ChatGPT keeps suggesting Work | apply `docs/chatgpt-interaction-policy.md`; if it cannot be resolved automatically, fall back to the user per that doc, one action |
| cloudflared missing | install it yourself (brew/winget), then retry |
| No browser-automation tool available | tell the user once, ask them to enable one (Claude Browser / Claude in Chrome / equivalent), then retry |
