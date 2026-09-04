# Project bootstrap (`AI_CONTEXT.md`)

This document is the single source of truth for how any coding-agent Skill
(Codex, Claude Code, or a future adapter) bootstraps ChatGPT into a project
at the start of a "芋煮会" (C2C coding-task) session. Shared exactly like
`docs/chatgpt-interaction-policy.md` — update this file, not per-agent
copies of this behavior.

## Purpose

When a C2C coding-task session starts, ChatGPT should already know where the
project stands — current phase, what's authoritative right now, what's
settled, what's obsolete — without the user re-explaining it and without
ChatGPT reading the entire repository. `AI_CONTEXT.md`, at the workspace
root, is that entry point.

**Its primary reader is ChatGPT.** Making Codex or Claude Code "remember"
the project is not the goal — they already have full filesystem access.
`AI_CONTEXT.md` exists because ChatGPT's only view of the project is through
the read-only MCP tools, one call at a time.

**It is not the spec.** `AI_CONTEXT.md` is a pointer, not a container:

| Location | Role |
| --- | --- |
| `AI_CONTEXT.md` | Where the project is right now, and what to read to find out more |
| `docs/` (or equivalent) | The actual specs and design decisions |
| git / source | The actual current implementation |
| Personal Core, past chats, etc. | Historical rationale, only when actually needed |

Keep it short. If it starts accumulating full specs, decisions, or history,
move that content to `docs/` and leave a pointer instead.

## Who writes it

Consistent with the rest of C2C's read-only design: **ChatGPT never writes
`AI_CONTEXT.md`.** It has no write tool, by construction (see
`docs/security.md`) — this feature does not change that. The coding agent
(Codex or Claude Code) creates and updates the file with its own file tools,
informed by what ChatGPT confirmed during the session. This is not an
extra rule invented for this feature; it falls straight out of the existing
architecture.

## Template

```md
# Project Context

## プロジェクトの目的

## 現在地点

## 現在のフェーズ

## 現在の正本
- docs/...

## 今回通常読む資料
- docs/...

## 重要な確定事項

## 却下済み・廃止済み事項

## 過去フェーズ
- 完了済み。通常参照不要
```

Adapt section names to the project's own language/conventions if a
workspace already has a strong convention — the structure matters more than
the exact headings. Do not let it grow much beyond this shape; if a section
needs paragraphs, that content belongs in `docs/` with a one-line pointer
left here instead.

## At the start of a C2C coding-task session

```
Coding-task session starts
  ↓
Does AI_CONTEXT.md exist at the workspace root?
  ├─ Yes → nothing to do locally; the boot prompt already tells ChatGPT to
  │        read it via MCP before planning.
  └─ No  → create an initial version now, before opening/continuing the
           ChatGPT conversation (see "Creating it" below).
```

Never ask the user to say "read AI_CONTEXT.md" or "read the spec" — this
check runs automatically, every time, as part of the existing doctor-gate /
conversation-open step already in the Skill workflow.

## Creating it

Only when it does not already exist. Base it only on things you can
actually verify:

- README and existing docs
- Workspace structure and `.c2c.json`
- Git log / status
- The spec or instructions the user gave this turn
- Anything just confirmed with ChatGPT in this session

**Do not invent facts.** Leave a section empty or write "不明"/"unknown"
rather than guessing at project purpose, phase, or decisions you cannot
source. A thin, honest `AI_CONTEXT.md` is better than a confident, wrong one.

## Reading order (ChatGPT side)

The Boot Prompt (`docs/protocol.md` § Boot Prompt) instructs ChatGPT to
follow this order every time it is about to produce a PLAN, not just on the
first message of a conversation:

```
1. workspace_info           (cheap; also reports aiContext.exists)
2. AI_CONTEXT.md, if aiContext.exists is true
3. whatever AI_CONTEXT.md's "現在の正本" / "今回通常読む資料" point to
4. anything else specific to this task
5. code, as needed
```

ChatGPT should not read the whole project up front. If `AI_CONTEXT.md`
names old phase files as "完了済み・通常参照不要", ChatGPT should not read
those unless the current task actually needs them.

## If it looks stale

If `AI_CONTEXT.md` contradicts the real code, git state, or current specs,
**do not trust it blindly** — this applies to both ChatGPT (reading it) and
the coding agent (maintaining it). Check the actual source of truth. If the
discrepancy can be resolved with evidence, fix `AI_CONTEXT.md`. If it can't
be resolved confidently, leave it as-is rather than guessing — a stale but
honest file is safer than a confidently rewritten wrong one.

## Updating it at the end of a session

When a C2C task reaches DONE (or the user ends the session), first run a
cheap mechanical check — `git log -1 --oneline` and `git status --short` —
and compare them against whatever commit/dirty-state `AI_CONTEXT.md`'s
"現在地点" section currently claims. This check is not optional and not a
judgment call: if the two disagree, that section is now provably wrong about
the repository's actual state and must be corrected (at minimum the commit
hash / dirty-clean line), even when nothing else in the file needs to
change. This exists because the narrower judgment call below — "did this
task change project state" — has been observed to get silently skipped in
practice, leaving a stale commit/dirty claim behind even when the file's
other sections were still accurate.

Beyond that mechanical check, update the rest of `AI_CONTEXT.md` if the
session actually changed the project's current state — current phase,
newly confirmed decisions, newly obsolete items. Update only what you have
evidence for:

- the actual implementation / diff
- test results
- explicit user decisions
- the current spec
- conclusions actually reached with ChatGPT this session

Never mark something complete because a task merely finished — only when
there is real evidence it's actually done. If nothing about the project's
current state changed, leave the file alone.

## Long-running projects (multiple phases)

Do not delete old specs as a project moves through phases. Keep them (e.g.
`docs/phase-1.md`, `docs/phase-2.md`, `docs/architecture.md`) and use
`AI_CONTEXT.md`'s "現在のフェーズ" / "過去フェーズ" sections to say which
ones matter right now:

```
現在はPhase 3
Phase 1は完了・通常参照不要
Phase 2は完了・必要時のみ参照
```

This is what keeps ChatGPT from re-reading the entire project history on
every session.
