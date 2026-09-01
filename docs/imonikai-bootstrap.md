# 芋煮会 (imonikai) — zero-touch bootstrap

Shared by both agent adapters. Neither Skill re-implements this decision
tree in prose — both call `c2c imonikai status` / `c2c imonikai init` and
follow the JSON. This is the single entry point for "「芋煮会で○○して」
should just work, on a workspace that has never been touched before."

It is a thin orchestration layer over the same tunnel primitives every
other command uses (`c2c tunnel status` / `c2c tunnel choose`,
`src/tunnel/state.ts`, `src/tunnel/named-provision.ts`). There is only ever
one on-disk record of a workspace's Cloudflare tunnel — `imonikai init`
does not maintain a second, parallel one.

## What "芋煮会" means

It is the user's standing codename for: use C2C to have ChatGPT design,
consult, and review, while the coding agent (Codex or Claude Code)
implements, runs commands, and tests. See `docs/chatgpt-interaction-policy.md`
(ChatGPT stays on normal Chat) and `docs/ai-context.md` (how ChatGPT gets
oriented) for the two policies this workflow leans on.

A message containing "芋煮会" is standing intent to route the task through
this workflow — from the very first message of a session, not just when
the phrase repeats.

## The standard flow

```
"芋煮会で○○して"
  ↓
c2c imonikai status -w <workspace> --json
  ↓
needsInit?
  ├─ true  → c2c imonikai init -w <workspace> --agent <a> [--hostname ... --zone ...] --json
  │           (one-time tunnel choice if not made yet, bridge + tunnel,
  │            AI_CONTEXT.md check, connector name, pairing code — see below)
  └─ false → tunnel.permanentUrlConfigured?
              ├─ true  → reuse everything as-is, skip straight to Project Bootstrap
              └─ false → still call `imonikai init` (safe/idempotent — see
                          "Re-running" below). If the resulting mcpUrl
                          differs from what ChatGPT currently has, `c2c
                          doctor --json` reports `chatgptRepair.needed:
                          true` — follow **Workflow: reconnect after
                          address reclaim** (Delete + recreate the
                          connector; ChatGPT has no Server-URL-edit
                          control) instead of creating a second connector.
  ↓
Skill drives the ChatGPT browser: create/reuse connector, authorize with the
pairing code (this step cannot move into the CLI — the Bridge never touches
a browser, by design; see docs/security.md)
  ↓
Project Bootstrap: ChatGPT reads workspace_info -> AI_CONTEXT.md -> current
authoritative docs (docs/ai-context.md's reading order)
  ↓
PLAN -> implement -> test -> EXECUTED -> ChatGPT review -> DONE/PLAN/BLOCKED
  ↓
Update AI_CONTEXT.md if the session's outcome actually changed the
project's current state (docs/ai-context.md § Updating it)
```

## `c2c imonikai status` — is this workspace ready?

Read-oriented; starts nothing, creates nothing. One JSON blob decides
everything a Skill needs:

```json
{
  "ok": true,
  "workspaceId": "...", "workspaceName": "...",
  "isNewWorkspace": true,
  "bridge": { "running": true, "port": 12345 },
  "tunnel": { "mode": "named", "url": "https://c2c-imonikai.c2c.example.com", "permanentUrlConfigured": true, "hostname": "c2c-imonikai.c2c.example.com" },
  "connector": { "name": "Codex with ChatGPT · Imonikai", "mcpUrl": "...", "authorized": false },
  "aiContext": { "exists": false, "path": "AI_CONTEXT.md" },
  "chatgptPolicy": { "chatgptSurface": "chat", "rejectWorkSuggestion": true },
  "needsInit": true
}
```

`needsInit` means "ChatGPT has never successfully authorized against this
workspace" (`connector.authorized` is false, i.e. no live token) — the
signal for "this needs first-time setup." It says nothing about the
tunnel: a workspace can be fully authorized (`needsInit: false`) while
still running on an ephemeral Quick Tunnel
(`tunnel.permanentUrlConfigured: false`), e.g. because it was set up
before a `--zone` was known. Treating `needsInit: false` alone as "nothing
left to do" is wrong and leaves such a workspace stuck on Quick Tunnel
forever — always check `tunnel.permanentUrlConfigured` too (see "The
standard flow" above).

## `c2c imonikai init` — make it ready, without asking anything guessable

```
c2c imonikai init -w <workspace> --agent codex|claude-code \
  [--hostname <full-hostname>] \
  [--zone <domain>] [--set-default-zone]
```

1. Codex-only sandbox allowlist (no-op for Claude Code — see `src/config/sandbox-allow.ts`).
2. **Only if this workspace has never made the one-time tunnel choice yet**
   (`needsTunnelChoice()` — see `src/tunnel/state.ts`), decides it silently
   instead of asking (this is the difference from `c2c tunnel choose`, which
   is interactive):
   - Zone comes from (in order): `--zone`, the remembered default zone
     (`--set-default-zone` from an earlier call), or — if only `--hostname`
     was given — the zone implied by stripping its leftmost label.
   - If a zone is available: `provisionNamedTunnel()` (shared with `c2c
     tunnel choose --mode named`) creates the tunnel, routes DNS, and
     persists the choice. It never throws — a Cloudflare-side failure
     (not logged in, network issue, etc.) is recorded as a normal "quick"
     choice with a reason, exactly like a user who chose Quick themselves.
   - If no zone is available anywhere: records the choice as "quick"
     explicitly (never leaves the workspace stuck in "needs a choice"
     limbo). No domain is ever guessed.
3. Starts (or reuses) the bridge and its tunnel — Named if the choice above
   resolved to Named, Quick otherwise. Reuses the existing connector name
   for this workspace if one is already on record.
4. Generates a pairing code.
5. Returns the same shape as `imonikai status` plus `connectorName`,
   `mcpUrl`, `permanentUrlConfigured`, `pairingCode`, `pairingExpiresAt`,
   `repairs` (human-readable notes, e.g. "created a named hostname" or
   "named tunnel not ready yet, still on Quick Tunnel").

### Hostnames for non-ASCII workspace names

The shared `hostnameSlug()` (`src/tunnel/hostname.ts`) is a mechanical
ASCII-only fallback — ASCII names get a `c2c-<slug>` label, non-ASCII names
fall back to `c2c-ws-<id-prefix>`, which is not a meaningful label. **The
calling agent is an LLM and should propose a sensible `--hostname` itself**
whenever the workspace name isn't ASCII-friendly — e.g. "芋煮会商事" ->
`--hostname imonikai.c2c.example.com`. Pass `--zone` alongside it when
known; if omitted, `imonikai init` derives the zone from the hostname you
gave (stripping its leftmost label) rather than guessing a domain from
nothing.

## What stays in each Skill (cannot move into the common layer)

The C2C Bridge is loopback-only and never touches a browser, by design
(`docs/security.md`) — so anything requiring a browser stays Skill-side,
using whatever browser-automation capability that agent has:

- Creating/editing the ChatGPT connector with the `mcpUrl` from `imonikai init`.
  ChatGPT has no "edit Server URL" control on an existing connector — when
  the address changed, Delete it and create it again under the same name
  (see `docs/troubleshooting.md`).
- Entering the pairing code and completing OAuth authorization. Inside a
  ChatGPT Project (Custom GPT), attach the connector by typing `@` + its
  name in the composer — the "+" menu does not offer a connector picker
  there the way a plain chat does.
- Sending the boot prompt and `[C2C]` control messages (`docs/protocol.md`).
- Detecting/dismissing ChatGPT's "Work" surface suggestions
  (`docs/chatgpt-interaction-policy.md`).
- The one-time `cloudflared tunnel login` browser step, if Cloudflare isn't
  already authorized on this machine — `imonikai init` prints the prompt
  and waits, but the user completes it in their own browser (rule 5).

Everything else — diagnosis, tunnel provisioning, connector naming, pairing
codes, AI_CONTEXT.md existence checks — is common layer, called identically
by both Skills.

## User interruptions (rule 5)

Only these ever require the user, and each is exactly one action:

- `cloudflared tunnel login` (once per machine, only if never done before)
- ChatGPT login
- OAuth authorization click
- CAPTCHA / 2FA

Nothing else — not `c2c setup`, not `c2c tunnel choose`, not creating
`AI_CONTEXT.md`, not creating the ChatGPT connector — should ever be
something the user is asked to run themselves.

## Re-running 芋煮会 on an already-bootstrapped workspace

`c2c imonikai status` reports `needsInit: false` as soon as a live OAuth
token exists. If `tunnel.permanentUrlConfigured` is also `true`, the Skill
skips straight to Project Bootstrap — it does not call `imonikai init`
again and does not create a second ChatGPT connector; the tunnel choice for
a workspace is made exactly once (`needsTunnelChoice()` returns false after
that), so a second `imonikai init` call is a no-op on the tunnel side too.

If `permanentUrlConfigured` is `false` on an already-authorized workspace,
that is *not* "nothing to do" — `imonikai init` is still called to attempt
the choice/upgrade. It is safe to call repeatedly (idempotent — the
underlying `provisionNamedTunnel`/`createTunnel` reuse an existing
Cloudflare-side tunnel by name instead of erroring on "already exists"),
never recreates the existing connector by itself, and only a follow-up
`c2c doctor` (if the mcpUrl actually changed) touches ChatGPT's connector
settings — exactly once, via Delete + recreate, never by creating a new one.
