# Troubleshooting

First move, always:

```
c2c doctor
```

It checks Node, workspace, bridge, MCP, OAuth and tunnel — and repairs what it
can (restarts the bridge, restarts the tunnel) without asking.

## Common situations

### "Bridge 未运行"
`c2c start` (or let doctor do it). Bridge logs:
`c2c logs`, or verbose: `c2c logs --verbose`.

If doctor says the bridge state is **uncertain** (无法确认), do not start a
second bridge and do not Delete the ChatGPT connector. Wait and run doctor
again. The local process may still be running.

### Everything was quit and ChatGPT can no longer connect
Quitting Codex / the terminal stops the public address. The next `c2c doctor`
starts a new address and sets `chatgptRepair.needed`. The Skill should tell the
user that the old address expired, then **Delete** THIS workspace's
connector (`chatgptRepair.connectorName`) and create it again with the new
address (never click Reconnect — the old URL is dead). Other workspaces keep
their own connectors so two projects can stay connected at once.

Fixed ChatGPT pages for first-time setup and later repair (do not hunt the UI):

- Developer mode: https://chatgpt.com/#settings/Security
- Plugins hub (manage existing connectors): https://chatgpt.com/plugins
- Add a connector:
  https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins

### Tunnel URL unreachable / ChatGPT says the connector is broken
Same as above: `c2c doctor`, then Delete + recreate THIS workspace's
connector if `chatgptRepair.needed`. Fresh pairing code: `c2c pair`.
If this workspace uses a stable hostname, doctor sets `namedRepair` instead —
re-login to Cloudflare (`c2c tunnel login`) and doctor again. Do not Delete
the connector; the address did not change.

### I have a Cloudflare domain and want a stable hostname
During first-time setup (or the next coding session, once), say you have a
Cloudflare account and give the domain. Codex opens a browser for Cloudflare
login, then keeps `c2c-<project>.your-domain.com`. To stay on the temporary
address, say you do not have a domain. Switching later: tell Codex you want
the stable hostname; it runs `c2c tunnel choose --mode named --zone <domain>`.

**`--zone` must be the real Cloudflare zone apex** (e.g. `example.com`), not
a subdomain of it (e.g. `c2c.example.com`). Cloudflare's default Universal
SSL certificate for a zone normally only covers the apex and its immediate
wildcard (`example.com` and `*.example.com`) — a hostname one level deeper
than that (`something.c2c.example.com`, whose "zone" would be the non-apex
`c2c.example.com`) very likely has no matching edge certificate at all.
DNS routing still succeeds (`cloudflared tunnel route dns` creates the
CNAME fine), so this fails silently until something actually tries an
HTTPS request: it comes back as a bare TLS handshake failure (curl: "SSL
routines::ssl/tls alert handshake failure", no certificate ever offered),
not a normal HTTP error — confirmed live against a real Cloudflare zone,
2026-09-02. If `--zone` is omitted, `imonikai init` falls back to deriving
one by stripping `--hostname`'s leftmost label, which only lands on the
true apex when `--hostname` itself has exactly two labels
(`sub.example.com` -> `example.com`); for a deeper `--hostname`, pass
`--zone` explicitly instead of relying on that fallback.

### "配对码无效/过期"
Pairing codes are one-time and expire after ~5 minutes:

```
c2c pair
```

generates a fresh one (older codes become invalid immediately).

### ChatGPT gets 401 on every tool call
The access token expired and refresh failed (e.g. after `c2c unpair` or a
long offline period). Delete THIS workspace's connector if the address also
changed; otherwise run Authorize again in ChatGPT and enter a fresh pairing
code. Never use Reconnect when the public address has been replaced.

### cloudflared is not installed
macOS: `brew install cloudflared`
Windows: `winget install Cloudflare.cloudflared`
Linux: see Cloudflare's package instructions.
The Skill installs this automatically during setup.

### Every new Codex chat “repairs” the connection / cannot write logs
(Codex only — Claude Code has no sandbox step; see below.) The C2C state
directory lives outside the project (macOS:
`~/Library/Application Support/codex-with-chatgpt`; Windows:
`%LOCALAPPDATA%\codex-with-chatgpt`). Codex's default sandbox cannot write
there, so each new chat looks like a health-check failure.

`c2c setup --agent codex`, `c2c doctor --agent codex` and `c2c sandbox-allow`
add that directory to `[sandbox_workspace_write].writable_roots` in
`~/.codex/config.toml` (`%USERPROFILE%\.codex\config.toml` on Windows). After
that, later chats do not need elevation. This step is skipped entirely for
Claude Code (`--agent claude-code`): Claude Code uses its own permission
prompts instead, and never gets a `~/.codex` directory written on its
behalf.

### ChatGPT keeps suggesting "Work" instead of staying in normal Chat
Expected to be auto-dismissed by the Skill — see
[chatgpt-interaction-policy.md](chatgpt-interaction-policy.md). Check
`c2c chatgpt-policy -w <workspace> --json`; if `rejectWorkSuggestion` is
`false`, someone disabled it in `.c2c.json`. If it's `true` and ChatGPT's UI
still isn't being dismissed, the Skill likely could not confidently match
the current UI (ChatGPT changes it often) — that is a documented fail-safe,
not a bug, and the Skill should fall back to asking you for one click.

**Known limitation:** even when the Work-suggestion dialog is correctly
identified, some browser-automation backends can silently fail to deliver
clicks (the pane reports itself as visible/displayed but the underlying page
is not actually OS-focused, so click actions time out or have no effect,
including on the dialog's own close/"×" control). Observed live on
2026-08-31. Not something the Skill can detect or fix from inside the
automation tool — see "Known limitation" in
[chatgpt-interaction-policy.md](chatgpt-interaction-policy.md#known-limitation-observed-2026-08-31)
for the required behavior: verify the dialog actually closed rather than
trusting a successful/timed-out tool call, cap retries at ~2, and fall back
to asking the user to (1) close the dialog, then (2) separately confirm the
surface is back on "Chat" — one step at a time. A run that needed this
fallback is not a successful automated Work-suggestion rejection.

### A ChatGPT Project (Custom GPT) conversation says a connector tool "has been disabled"
Confirmed live (2026-08-31): after a connector fails repeatedly inside one
specific conversation in a ChatGPT Project, ChatGPT can permanently disable
that tool for that exact thread — Delete + recreating the connector (even
under the identical name, per "Delete THIS workspace's connector" above)
does not restore it there, and no setting was found (not in Project
settings, not in the connector's own settings) to re-enable a disabled tool
in an already-affected thread. Two things to know:
- **Project conversations attach a connector differently than plain chats.**
  There is no "+" → plugin picker; instead, type `@` in the message box and
  pick the connector by name from the mention list that appears. This works
  in a *new* conversation in the same Project even when an old thread is stuck.
- If the old thread is unusable, start a new conversation in the same
  Project, attach the connector with `@`, confirm `workspace_info` works,
  then send a `[C2C] STATE: HANDOFF` message (see `protocol.md`) summarizing
  the stuck task(s) so ChatGPT can pick them back up and independently
  re-verify current state via MCP rather than trusting the old thread's
  history.

### Port already in use
Handled automatically: an existing healthy bridge for the same workspace is
reused; anything else makes the bridge pick a free port. Configuration follows
automatically.

### Reading a file returns ACCESS_DENIED_SENSITIVE_FILE
Working as intended: `.env`, keys, credentials and anything matched by
`.c2cignore` are never readable through ChatGPT. `.env.example` is allowed.

### I cannot see Projects in the ChatGPT sidebar
Hover **Chats** /「聊天」, click the … that appears, and choose
**Organize by project** /「按项目整理」. Then create a project named after
this workspace, with **project-only memory**. Tell Codex「好了」when the
collection page is open (`https://chatgpt.com/g/g-p-…/project`).

### This workspace opened the wrong ChatGPT Project
Do not pick another project by name automatically. Open the collection that
matches this workspace and tell Codex「已找到」, or say you want the old
long-chat instead. Each workspace has its own Project and its own connector.

### This c2c checkout is shared with other coding-agent sessions
The `codex-with-chatgpt` checkout a Skill runs `c2c` from is not necessarily
private to one session — a user may point multiple Codex/Claude Code
sessions at the same checkout path (observed live, 2026-08-31: a second
session hit `git status` showing uncommitted work-in-progress and unpushed
local-only commits on `feature/claude-code-and-chat-fixation` from a
different session it had no way to know about). Because of this:
- Never run `git pull`, `git stash`, `git reset`, or switch branches in this
  checkout as part of an *update check* — see the `updateAvailable` guard in
  golden rule area / Workflow: update above. A custom branch or any local
  changes mean another session may be actively using them; leave git state
  alone and keep using the already-installed build.
- If you need to actually update this shared checkout (the user explicitly
  asked, not just a background daily check), say so and confirm before
  touching git state, the same as any other action that could affect
  another party's in-progress work.
- Building (`pnpm install && pnpm build`) is safe to run anytime — it never
  touches git state, only regenerates `dist/`.

### Completely stuck
```
c2c stop
c2c setup
```

re-creates the bridge, tunnel and pairing session from scratch. Existing
authorizations stay valid unless you also ran `c2c unpair`.
