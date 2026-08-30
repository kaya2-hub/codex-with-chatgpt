# ChatGPT interaction policy (shared: Codex + Claude Code)

This document is the single source of truth for how any coding-agent Skill
(Codex, Claude Code, or a future adapter) must drive the ChatGPT web UI. It
exists because the C2C Bridge itself never touches a browser — only the
Skill running inside the coding agent does — so this behavior cannot live in
server code. Instead it lives here, as shared policy text, plus a small
shared config surface (`.c2c.json` → `c2c chatgpt-policy`) that every Skill
reads before acting. Do not duplicate or fork this logic per agent; update
this document and both Skills should follow it identically.

## Config

`.c2c.json` (workspace root):

```json
{
  "chatgptSurface": "chat",
  "rejectWorkSuggestion": true
}
```

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `chatgptSurface` | `"chat"` \| `"work"` | `"chat"` | Which ChatGPT surface the conversation should stay on. |
| `rejectWorkSuggestion` | boolean | `true` | Auto-dismiss ChatGPT's "switch to Work" suggestions instead of surfacing them. |

Read the resolved policy with:

```
c2c chatgpt-policy -w <workspace> --json
→ { "ok": true, "chatgptSurface": "chat", "rejectWorkSuggestion": true }
```

Both defaults match this project's intent — ChatGPT is used as the planning
and review brain over a normal Chat conversation. Setting
`rejectWorkSuggestion: false` in `.c2c.json` fully disables the behavior
below; the feature must stay optional, never hardcoded on.

## When to check

Once per Skill turn that touches the ChatGPT tab: right after opening or
foregrounding it, and again after sending any `[C2C]` control message (a
reply can arrive while Work-suggestion UI is showing). Do not poll
continuously — a cheap DOM/accessibility read is enough.

```
Open / foreground the ChatGPT tab
  ↓
chatgptSurface == "chat"?
  ├─ Already on normal Chat, no suggestion showing → continue
  ├─ Work-suggestion UI showing → see "Detecting a Work suggestion" below
  ├─ Already on the Work surface → see "Already on Work" below
  └─ Cannot tell (UI changed, tool has no visibility here) → continue normally,
     do not block the task on this alone (§ Fail-safe)
```

## Detecting a Work suggestion

Treat something as a "Work suggestion" only when it is UI offering to switch
the ChatGPT *product surface* from Chat to Work — e.g. a button, banner,
dialog, or inline prompt whose action is to open/switch/continue in Work.

**Observed current UI (verified live, 2026-08):** the primary place this
shows up today is a persistent surface switcher at the top of the ChatGPT
page — a button labeled with the current surface name (e.g. "Chat") that
opens a `role="menu"` containing a `group` of `role="menuitemradio"` items,
one per surface ("Chat", "Work"). The currently-active surface is the
checked `menuitemradio`. There is no separate confirmation dialog for this
control — selecting the "Work" `menuitemradio` switches immediately. This
matches the role-based detection priority below well: open the switcher only
if you need to confirm the current surface, read which `menuitemradio` is
checked, and never activate the one labeled "Work". ChatGPT may also show
other, more transient suggestions (banners, inline prompts) offering to
continue a task in Work — apply the same detection/priority rules to those
using their own `role`/`aria-label`/text, since their exact shape will drift
independently of the switcher described here.
Examples of the intent (exact copy will drift over time, do not string-match
only this list): "Use Work", "Continue in Work", "Try Work", "Open in Work",
"Switch to Work", "Work で続ける", "Work に切り替える".

**Do not** react to the plain word "work" appearing in conversation text —
"work on this project", "this should work", "workflow" are not suggestions
and must never trigger a dismissal or a click. The target is UI chrome
offering a surface switch, not prose.

To stay resilient to ChatGPT's frequent UI changes, identify candidates using
this priority order, not raw CSS selectors:

1. ARIA `role` (`dialog`, `alertdialog`, `menuitem`, `button` inside a modal)
2. `aria-label`
3. Visible button/link text (semantic match against the intent above)
4. Semantic DOM structure (a modal/dialog/banner container with an action)
5. Stable `data-*` attributes, if present
6. CSS selector — last resort only, and do not build large selector lists
   just to chase this feature. If none of 1–5 identify it confidently, treat
   it as "cannot tell" (see Fail-safe), not as a green light to guess.

## Resolving it (priority order)

```
Work suggestion detected
  ↓
1. A close / "×" / cancel control exists → use it
2. A "Not now" / "今はしない" / equivalent decline exists → select it
3. A "Continue in Chat" / stay-on-chat option exists → select it
4. Esc (or platform-equivalent) safely dismisses it → use it
5. None of the above can be resolved with confidence → fall back to the user (§ below)
```

### Never do this

Never click, select, or otherwise activate the affirmative action — "Use
Work", "Switch to Work", "Start Work", "Try Work", "Continue in Work", or
any equivalent — regardless of confidence level. If it is unclear whether a
control is the affirmative or the negative action, do not click either;
treat it as unresolved and fall back per priority step 5.

## Already on the Work surface

If it can be confidently determined that the current ChatGPT surface is
Work (not merely suggested — actually already switched), and
`chatgptSurface` is `"chat"`, attempt to return to normal Chat through
whatever safe, unambiguous UI path exists (e.g. a visible "Chat" tab/link).
If that cannot be done safely or confidently, do not force it — continue
per the fail-safe rules below rather than guessing at navigation.

## Fail-safe

Failing to auto-dismiss a Work suggestion is never itself a reason to fail
the C2C connection, the Codex/Claude Code session, or the task:

```
Auto-dismiss failed
  ↓
Normal chat flow still usable → continue the task
Forced onto the Work surface, task cannot proceed there → try to return to Chat
Cannot return, and cannot proceed → ask the user (one action, see below)
```

Never crash, retry-loop, or block indefinitely on this. It is a UX nicety on
top of the C2C protocol, not a precondition for it.

## User fallback

Ask the user to act, one action at a time, only when:

- The UI has changed enough that automatic dismissal cannot be determined
  safely (no confident match from the priority list above).
- The dialog/control is not reachable by the agent's browser-automation tool
  at all.
- CAPTCHA, login, or two-factor authentication is showing.
- The action would require a decision only the user can make (explicit
  consent/permission screens).
- A click cannot be classified as clearly affirmative or clearly negative.

When asking, describe exactly what is on screen and exactly one action, e.g.
"ChatGPT 中央に「Work で続ける」というダイアログが出ている。左下の「今はしない」を押して。"
Never ask for more than one action per turn.

## Logging

When a Skill processes a Work suggestion, it should log enough to debug the
behavior later, e.g.:

```
[c2c] ChatGPT Work suggestion detected
[c2c] Work suggestion dismissed
[c2c] ChatGPT Work surface detected
[c2c] Switched back to Chat surface
```

Never log any of: ChatGPT conversation content, personal data, credentials,
cookies, OAuth tokens, session identifiers, or other secrets. This mirrors
the existing logger redaction policy in `src/logger/index.ts` — treat
anything captured while inspecting the ChatGPT page as untrusted and do not
persist it beyond a short structured event name.

## Security notes

- This entire policy operates purely within the agent's own browser
  automation of the ChatGPT web UI. It grants no new capability to ChatGPT,
  the C2C Bridge, or the workspace — it only decides which button a
  human-equivalent UI action does or does not press.
- The Bridge's read-only MCP surface, OAuth/pairing flow, and workspace
  containment (see `docs/security.md`) are unaffected by and independent of
  this feature; disabling `rejectWorkSuggestion` changes ChatGPT UI
  navigation only, never workspace access or write capability.
