# C2C Agent Protocol

Control plane: Computer Use (tiny structured messages typed into the ChatGPT UI).
Data plane: MCP (ChatGPT pulls files, diffs, search results itself).

Never mix the two: control messages carry state, never content.

## States

```
INIT → PLAN → EXECUTING → EXECUTED → REVIEW → PLAN | DONE | BLOCKED | ERROR
```

| State | Sender | Meaning |
| --- | --- | --- |
| INIT | coding agent | New task; asks ChatGPT to inspect + plan |
| PLAN | ChatGPT | Executable plan for the next iteration |
| EXECUTING | coding agent | (optional) execution in progress |
| EXECUTED | coding agent | Iteration finished; metadata only |
| REVIEW | ChatGPT | (implicit) ChatGPT is inspecting via MCP |
| DONE | ChatGPT | Success criteria met |
| BLOCKED | ChatGPT | Cannot proceed; contains reason |
| ERROR | either | Protocol/infrastructure failure |
| HANDOFF | coding agent | Continuation brief sent to a replacement conversation |

"Coding agent" is Codex or Claude Code — the protocol and every message
shape below are identical either way; only the Skill driving the browser
differs (`skill/SKILL.md` vs `skill-claude-code/SKILL.md`).

There is no `STATE: RESUME`. If Codex restarts mid-task, it reads a **local
checkpoint** on the session file (`protocolState`, `waitingFor`, goal, issues,
next step). Those values are not ChatGPT protocol states. ChatGPT still sees
only the table above. If the original chat is gone, Codex sends HANDOFF
built from the checkpoint (never from logs).

Local checkpoint values (session only):

| Checkpoint | Meaning |
| --- | --- |
| `INIT` | INIT sent; waiting for PLAN |
| `PLAN_RECEIVED` | PLAN in hand; not finished executing |
| `EXECUTING` | Codex is applying the current PLAN |
| `EXECUTED_LOCAL` | Recorded locally; EXECUTED not yet typed |
| `EXECUTED_SENT` | EXECUTED typed; waiting for review |
| `DONE` / `BLOCKED` | Terminal; DONE should `--clear-checkpoint` |

Legacy sessions without a checkpoint keep the old loop. The first normal
iteration after this version writes a checkpoint automatically.

Do not re-pair, recreate the connector, or rewrite Project instructions
just to resume.

## Canonical state emission

`c2c session set -w <ws> --task <id> --iteration <n> --state <STATE>` is the
**single** canonical emitter for all 5 wire states, for both adapters (Codex
and Claude Code) — it is the single source of truth other tooling can read
state transitions from. Skipping this call for a given transition means that
transition is never recorded anywhere, independent of whatever else the
coding agent did locally (an omission that actually happened for PLAN and
BLOCKED before this section existed — see the Skills' own workflow steps,
which are required to call it out explicitly for every one of the 5 states
below, not just the 3 that happen to be easy to remember).

Exactly when each adapter runs it:

| State | Run `session set --state <STATE>`... |
| --- | --- |
| INIT | Immediately after sending the INIT control message |
| PLAN | After receiving PLAN from ChatGPT, before starting execution |
| EXECUTED | After local execution/record (`c2c record`) completes, before sending the EXECUTED control message |
| DONE | When DONE is received from ChatGPT |
| BLOCKED | When BLOCKED is received from ChatGPT |

Session-checkpoint flags (`--protocol-state`, `--waiting-for`, `--goal`,
`--known-issues`, `--next-step`, ...) may be passed on the SAME `session set`
call that carries `--state` — there is no need for a separate call, and
Codex's Skill already does this (see `skill/SKILL.md`).

## Message format

Every control message starts with `[C2C]` and key-value headers, then sections.
Keep messages < 1 KB. No diffs, no logs, no file bodies.

### INIT (coding agent → ChatGPT)

```
[C2C]
STATE: INIT
TASK_ID: c2c_f81a
ITERATION: 0

GOAL:
Implement dark mode.

INSTRUCTION:
Inspect the connected workspace through the Codex with ChatGPT MCP connector.
Create an implementation plan for the coding agent.
```

### PLAN (ChatGPT → coding agent)

```
[C2C]
STATE: PLAN
TASK_ID: c2c_f81a
ITERATION: 1

GOAL:
...

RATIONALE:
...

ACTIONS:
1. ...
2. ...
3. ...

FILES_LIKELY_INVOLVED:
...

TESTS:
...

SUCCESS_CRITERIA:
...
```

Plans must be finite, concrete, executable. Not 40-step epics.

### EXECUTED (coding agent → ChatGPT)

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
If execution_output lists a readable item for this iteration, list then read it.
If status is restricted, ignore it and review from git_diff.
```

Before sending EXECUTED, the coding agent records the iteration:
`c2c record --task c2c_f81a --iteration 1 --changed-files ... --tests ... --exit-status ok`
and, when a test/build/lint/typecheck was run, `--command` plus `--output-file`.
ChatGPT reads metadata via `execution_summary` / `test_status`. Command output
is a separate opt-in: `execution_output` (`list` then `read`). Codex nominates
the log; a **local sanitizer** decides whether ChatGPT may see the body
(tokens/paths redacted; private keys withheld entirely; size/line caps).
Restricted items appear in `list` with no body. Old records without output
stay valid. Never paste logs into the control message.

### DONE / BLOCKED (ChatGPT → coding agent)

```
[C2C]
STATE: DONE
TASK_ID: c2c_f81a
ITERATION: 3

SUMMARY:
...
```

```
[C2C]
STATE: BLOCKED
TASK_ID: c2c_f81a
ITERATION: 3

REASON:
...

NEEDS:
...
```

### HANDOFF (coding agent → new ChatGPT conversation)

`c2c session --json` → `conversation.mode` chooses how chats are grouped.

- **long-chat:** one long-lived C2C conversation per workspace. Codex opens a
  replacement chat only when the user asks, the old chat lags, or the chat was
  lost.
- **project:** one ChatGPT Project (collection) per workspace. A new Codex
  conversation starts a new chat **inside that Project**. The same Codex
  conversation keeps using its saved chat URL.

Right after the boot prompt, Codex sends a HANDOFF so the new chat can
continue — a brief, never a data dump (the new chat re-reads code via MCP).
Project instructions and project-only memory hold durable workspace identity.
HANDOFF still wins for the current task:

Trust order: connector (current code) > HANDOFF (this task) > Project
instructions > Project memory.

```
[C2C]
STATE: HANDOFF
TASK_ID: c2c_f81a
ITERATION: 4

ORIGINAL_GOAL:
Implement dark mode with a persisted user preference.

PROGRESS:
- Iter 1-2: theme context + toggle implemented, reviewed OK.
- Iter 3: persistence added; review found the toggle flashes on load.

CURRENT_STATE:
EXECUTED (iteration 4 fix applied, not yet reviewed).

KNOWN_ISSUES:
Flash-on-load fix needs verification in src/theme/ThemeProvider.tsx.

NEXT_EXPECTED_STEP:
Independently review iteration 4 via git_diff and reply PLAN or DONE.
```

## Loop limits

`maxIterations` (default 12, configurable in `.c2c.json`). When reached, the
coding agent pauses and asks the user whether to continue.

## Boot Prompt

Send once at the start of every new C2C conversation:

```
You are the planning and review layer of a coding session. The executing
agent on the other end may be Codex or Claude Code — the protocol is the
same either way.

The coding agent owns execution.
You own high-level reasoning, planning and review.

You have access to the current local workspace through the
"Codex with ChatGPT" MCP connector.

Rules:

1. Do not ask the coding agent to paste files that are available through MCP.
2. Before producing any PLAN (this one and every later one in this
   conversation): call workspace_info first. If its aiContext.exists is
   true, read AI_CONTEXT.md next via read_file, then only the current
   authoritative docs it points to — this is how you get oriented without
   reading the whole repository. Treat AI_CONTEXT.md as a pointer to verify
   against real code/git state, not as ground truth to trust blindly; if it
   looks stale, say so rather than silently acting on it.
3. Beyond that, inspect only the files actually needed for the task.
4. Use MCP to inspect current code, git status and diff.
5. Produce concise executable plans.
6. The coding agent will execute your plan using its own harness.
7. After it reports EXECUTED, independently inspect the diff. If
   execution_output lists a readable item for this iteration, list then
   read it. If status is restricted, ignore the body and review from git.
8. Do not assume an implementation succeeded just because it says so.
9. Continue until the implementation satisfies the success criteria.
10. Avoid unnecessary rewrites — during PLAN, and during EXECUTED review:
    flag unrequested abstractions, helpers, state, dependencies, test
    infrastructure, refactors, or documentation additions beyond what the
    task needed, even when the implementation is otherwise correct. This
    is not a mandate to minimize code for its own sake — leave working
    code alone when trimming or reorganizing it would itself add risk or
    churn.
11. Before treating a change as DONE, if it touches something multiple
    places depend on (an entry point, a shared state/data schema, a
    common interface or helper, a CLI contract), search for every other
    call site or consumer of that same assumption — a fix applied in one
    place but missed in another is still an open bug.
12. Return C2C structured control messages.
13. Be substantive. PLAN and review replies must carry enough signal for
    the agent to act on: rationale, per-file natural-language suggestions
    (which file, what to change and why), risks worth checking, and test
    advice. Never reply with a bare one-liner. Substance over length —
    but do not generate 40-step epics either.
14. If you receive a HANDOFF message, this conversation continues an
    existing task. Trust the handoff brief for history, re-read any code
    you need through MCP, and resume from NEXT_EXPECTED_STEP.
15. If this chat sits in a ChatGPT Project, use only the connector named
    in that Project's instructions. Do not use another workspace's connector.
```

## Project instructions

New workspaces store durable identity in the ChatGPT Project settings
(指令), not in every boot prompt. The Skill fills this template once.
Never put a public or temporary URL in the instructions — only the
connector **name**.

```
You are the planning and review layer for one local workspace. Codex executes.

This Project is bound only to:
- Workspace name: {{workspace_name}}
- Kind: {{project_type}} ({{languages}} / {{frameworks}})
- Connector (use this one only): {{connector_name}}

When you call tools, use ONLY that connector. Do not use any other
Codex with ChatGPT connector. If workspace_info names a different
workspace, stop. Do not plan. Do not use this Project's memory.

Read code, git, diffs, and any released command output through that
connector. Never ask anyone to paste file bodies, diffs, or logs. After
EXECUTED, call execution_output (list, then read) when a readable item
exists; if status is restricted, review from git instead. Never upload
the repo into this Project's files or sources.

When facts conflict, trust this order:
1. Current code from the connector
2. A HANDOFF in this chat (this task's goal, progress, next step)
3. These instructions
4. This Project's memory (durable architecture only; stale memory loses)

This Project's memory is only for this workspace. On HANDOFF, trust the
brief, re-read code through the connector, and resume at NEXT_EXPECTED_STEP.

Be substantive: why, which file, what to test. No empty one-liners and
no 40-step epics. Use C2C control messages.
```

See `docs/ai-context.md` for the full AI_CONTEXT.md spec (template, who
writes it, staleness handling, long-running-project phases).
