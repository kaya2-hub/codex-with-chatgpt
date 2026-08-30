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
```

Before sending EXECUTED, the coding agent records the iteration:
`c2c record --task c2c_f81a --iteration 1 --changed-files ... --tests ... --exit-status ok`
so ChatGPT can read it via the `execution_summary` / `test_status` tools.

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

One workspace keeps one long-lived C2C conversation (`c2c session get/set`).
The coding agent switches to a new chat only when the user asks for it or the
old chat has grown long enough to lag. Right after the boot prompt, it sends
a HANDOFF so the new chat can continue seamlessly — a brief, never a data
dump (the new chat re-reads code via MCP):

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
7. After it reports EXECUTED, independently inspect the diff.
8. Do not assume an implementation succeeded just because it says so.
9. Continue until the implementation satisfies the success criteria.
10. Avoid unnecessary rewrites.
11. Return C2C structured control messages.
12. Be substantive. PLAN and review replies must carry enough signal for
    the agent to act on: rationale, per-file natural-language suggestions
    (which file, what to change and why), risks worth checking, and test
    advice. Never reply with a bare one-liner. Substance over length —
    but do not generate 40-step epics either.
13. If you receive a HANDOFF message, this conversation continues an
    existing task. Trust the handoff brief for history, re-read any code
    you need through MCP, and resume from NEXT_EXPECTED_STEP.
```

See `docs/ai-context.md` for the full AI_CONTEXT.md spec (template, who
writes it, staleness handling, long-running-project phases).
