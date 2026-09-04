# EXECUTED Report: OAuth Connector Reliability Hardening

**Branch:** `feature/claude-code-and-chat-fixation` (uncommitted)
**Status:** Implementation + full live acceptance complete, including six
BLOCKER-level fixes found across the first four of five independent audit
rounds conducted from fresh ChatGPT chats (2026-09-04, `FINAL_REVIEW_1`
through `FINAL_REVIEW_5`) after the initial live-acceptance pass — see §7
for the full breakdown of which round found what. The fifth round found no
new correctness BLOCKER in the lock design itself (accepted as-is); its
findings were two test-coverage gaps and several report-precision issues,
both addressed in this pass. Awaiting a sixth, final-confirmation-only
review round before commit.

## 1. Original problem

ChatGPT connector OAuth intermittently failed with symptoms including
`400`/`Unknown client`/setup errors, and a specific reproducible pattern:
first Connect attempt showed no visible transition, a second attempt then
showed "This authorization request has expired." Separately, `c2c restart`
was found (during this work) to report success without actually replacing
the running process, and a live incident showed two independent bridge
processes for the same workspace simultaneously routable through different
local ports, with the runtime-state pointer file flipping between them.

## 2. C2C-side root causes identified and fixed (within this hardening scope)

The following are the root causes identified **on the C2C side** and fixed
within this hardening effort. This is not a claim that every possible
cause of connector unreliability is resolved — see §6, "Known remaining /
external failure modes," for causes that were investigated, are tracked,
and remain open or outside C2C's control.

### A. Consume-before-confirm (the original reported symptom)
The pending OAuth authorization request and the pairing session were both
deleted the instant local pairing-code verification succeeded, before the
downstream redirect + ChatGPT's own token exchange was confirmed to have
completed. A restart or transient failure between those two steps produced
the "1st Connect: nothing, 2nd Connect: expired" symptom.

**Fix:** the pending request now transitions `pending -> consumed` instead
of being deleted. A repeat POST against a `consumed` request re-issues a
fresh, single-use authorization code (bounded, `MAX_PENDING_AUTH_RETRIES =
5`) instead of returning an ambiguous "expired" error. Both the pending
request and the pairing session are now durably persisted (hash-only for
any credential-shaped value) so they also survive a bridge restart.
(`src/auth/oauth.ts`, `src/auth/store.ts`, `src/pairing/manager.ts`)

### B. DCR / client lifecycle
Client registration metadata (client_id, redirect_uris, client_name, etc.)
is persisted as-is and reloads correctly across a restart; credential-
shaped material derived from it (access/refresh tokens, authorization
codes) is persisted hash-only, never in plaintext. A
`/admin/oauth-client/unregister` route (loopback + admin-token guarded,
matching the existing admin-route convention) exists solely for the doctor
self-test's own cleanup — never positioned as a real-connector recovery
step. (`src/bridge/server.ts`)

### C. Observability
Every `/oauth/register`, `/oauth/authorize`, `/oauth/token` accept/reject
branch now emits a structured, secret-free log line (route, outcome,
reason category, client_id, request_id, bridge generation, correlation
id) — verified by tests to never contain a pairing code, authorization
code, access token, or refresh token value in any branch.
(`src/auth/oauth-log.ts`, new file)

### D. Doctor: a real OAuth round-trip self-test
`doctor`'s OAuth check now drives the actual public contract end to end —
DCR -> authorize -> pairing -> token exchange -> authenticated MCP call —
against the same routes ChatGPT itself uses, not an internally-minted
token. It skips (never fails) if a real pairing session is active, and is
excluded from ever counting as proof a real external client connected.
(`src/auth/oauth-self-test.ts`, new file)

### E. `c2c restart` didn't actually restart (found during live verification)
`/admin/shutdown` responds before its real shutdown work runs (so the
response itself isn't cut short by the socket closing). `stopBridge()`
used to return success the moment that response arrived, so the very next
`ensureBridge()` call could see the still-alive old process as "healthy"
and simply reuse it — `c2c restart` reported success while reusing the
exact same PID. **Fix:** `stopBridge()` now blocks until the old PID is
confirmed gone before ever returning true. This also let three separate
"sleep-and-hope" workarounds at other call sites (`c2c restart`, the
imonikai tunnel-choice flow, `doctor --fix`'s Named-fallback repair) be
removed in favor of trusting the one honest primitive.
(`src/process/daemon.ts`, `src/cli/index.ts`)

### F. Single-instance ownership (found during live verification)
A live incident showed two fully independent bridge processes running for
the same workspace at once — a transient health-probe failure had caused
`ensureBridge()` to spawn a second instance while the first was still
alive and healthy, and the shared runtime-state pointer file (no locking)
flipped between whichever process last wrote it. A pairing session minted
against one was invisible to the other, which was the one ChatGPT's tunnel
actually reached — permanent `no_active_session` no matter how many fresh
codes were issued.

**Fix:** an exclusive, workspace-scoped lock (`src/bridge/lock.ts`, new
file) is acquired by `startBridge()` as the first thing it does — before
binding any port, before persisting runtime state. A second `startBridge()`
for the same workspace, however triggered (a spawned daemon child or a
direct `c2c serve`), fails immediately and can never become a second live,
routable instance. Stale-lock reclaim only fires when the recorded pid is
*confirmed* dead (never a guess). `doctor` gained a `report.ownership`
check that fails if a live, confirmed-alive lock holder ever disagrees
with the resolved runtime pointer.

### G. Stale-lock reclaim race (BLOCKER, found by independent audit, 2026-09-04)
The first version of §F's fix reclaimed a confirmed-dead stale lock with a
plain `rmSync`. Two callers that both independently observed the SAME dead
holder could interleave as: A removes the stale file and immediately
recreates a fresh, live lock; B's OWN removal (decided from its earlier
read, before A ever acted) then fires and deletes A's brand-new *live*
lock too, letting B go on to acquire right after — two owners for one
workspace, defeating the entire point of §F.

**Fix, round 1 (2026-09-04, first audit):** reclaim via atomic-rename-plus-
content-check — `fs.renameSync` throws `ENOENT` if its source no longer
exists, so at most one caller can rename the same stale file away; content
(pid only) was re-checked after the rename, restoring on mismatch.

**Round 1 was itself found to have a residual ABA (2026-09-04, second
audit):** with a THIRD concurrent caller, the window between "verify
mismatch" and "restore the file" could let that third caller's own
`wx`-create slip into the path's momentary absence — the same class of bug
one level narrower. **Fix, round 2:** the entire "is this stale, and if so
replace it" decision was serialized behind a dedicated, TTL-bounded reclaim
mutex (its own file), with the replace itself a single atomic
rename-*into*-place so the main lock file was never observably absent to a
third party mid-reclaim.

**Round 2's own mutex was found to have two further bugs (2026-09-04, third
audit):** (1) the mutex could be reclaimed from a genuinely still-alive
holder purely because its TTL (5s) had elapsed, with no check at all of
whether the recorded mutex owner was actually still running — a holder that
merely paused (GC, OS scheduler stall) past that window could be stolen
from; (2) the mutex's own *release* had the identical read-check-then-delete
TOCTOU round 1 had for the main lock, just relocated one level out.
Deliberately **not** fixed by adding a second mutex to protect the first
one (that only pushes the identical problem outward again, recursively).

**Fix, round 3 (this one):** the separate reclaim-mutex concept is removed
entirely. Reclaiming one specific dead instance is now arbitrated by a file
whose *path itself* is a deterministic SHA-256 hash of that dead instance's
own immutable identity (`pid:generation:createdAt`), claimed via
`fs.linkSync` (fails `EEXIST` if the target already exists — an OS-level
exclusive primitive, not file content). Because the arbiter path is unique
per exact dead instance, it never needs a staleness/TTL story of its own: a
genuinely different instance (even one that reuses the same pid via OS pid
recycling) hashes to a different path and can never collide with it. This
has two direct consequences that close the two round-3-audit findings by
construction, not by a narrower timing fix: **no TTL or elapsed-time
comparison exists anywhere in this file** (confirmed by inspection — reclaim
is gated purely by a fresh `observePid()` check performed immediately before
every replace, so a live holder can never be stolen from no matter how long
it pauses), and **`releaseWorkspaceLock` matches only on full identity**
(`sameLockInstance`: `pid` + `generation` + `createdAt` together, never
`pid` alone), so a stale, previously-captured identity can never delete a
different, later owner's fresh claim regardless of when it's acted on.
Separately, a real, reliably-reproducing Windows-specific `EPERM`/`EBUSY`
sharing-violation was found and fixed while building round 2 (replacing a
destination another process has briefly open for reading can transiently
fail on Windows, with no POSIX equivalent) — every rename/link in this file
goes through a bounded retry against exactly that, carried forward
unchanged into round 3.

**A test-harness lesson from round 3, worth recording precisely because it
initially looked like a code bug:** the round-2-era 3-process regression
test let its winner exit immediately after winning. Re-running it against
the round-3 code intermittently reported two workers both claiming success.
Debug instrumentation and a captured, inspectable event log (not just a
narrative re-telling) traced the actual sequence: worker C won fairly, then
exited; a delayed retry from worker B (stuck retrying `fs.linkSync` through
this file's own Windows `EPERM`/`EBUSY` backoff) only succeeded *after* C's
process had already exited, at which point `observePid(C's pid)` correctly
reported `missing` and B's subsequent reclaim of the by-then-genuinely-dead
C was correct behavior, not a second simultaneous winner. The lock code was
never in an inconsistent state; the test's shape (letting the winner die
immediately) made "won at some later, separate moment after a legitimate
handoff" indistinguishable from "won the original simultaneous race" by
simply counting how many workers' final result said `ok:true`. The fixed
test keeps the winner genuinely alive (holding the lock, `observePid`
reporting `present` throughout) while every loser keeps retrying against it,
and directly samples the lock file's identity repeatedly during that window
— see §4.

**Round 3 was itself found to have two further BLOCKERs (2026-09-04, fourth
audit):**

**#1 — arbiter-winner-crash deadlock.** If the arbitration winner crashed
between winning the arbiter file and actually replacing the main lock, the
arbiter path was left permanently occupied: `fs.linkSync` only ever
succeeds against an ABSENT target, so nothing could ever supersede a dead
winner's claim, and every future contender for that exact workspace got
`EEXIST` forever — a crash-induced permanent deadlock. **Fix:** arbiter
ownership is now itself recursively reclaimable, the same way the main lock
already is, without a TTL, without deleting/reusing a shared path, and
without a second mutex protecting the first: if the current arbiter
occupant is confirmed dead (a fresh `observePid` on the pid recorded in its
own claim), a contender computes a brand-new path uniquely keyed to
(the arbiter path, that exact dead occupant's identity) and races there
instead, via the identical `linkSync` exclusivity. This chains: each crash
consumes one hop and immediately unblocks the next, no path is ever reused
across two different occupants (always "create a never-before-used path",
never "read an old identity, then delete a shared one"), and a live
occupant is never touched (a hop only ever extends past an occupant
CONFIRMED dead by a fresh liveness check). See `winArbitration` in
`src/bridge/lock.ts`.

**Precise scope of this fix, stated without overreach:** this makes forward
progress under the failure model this codebase actually expects (a bounded
number of successive crashes in the exact same arbitration slot, which in
every test and live run observed so far has been one or two hops) — it is
not an unconditional "can never deadlock under any circumstance" claim.
`winArbitration` has an explicit, fail-closed `maxHops` cap (currently
10,000): if a chain ever somehow grew that long, the function throws rather
than loop forever, which surfaces as a loud failure, not a silent
deadlock — this cap has never been approached in testing or live use. Each
hop's path is a fixed-length SHA-256-derived filename (paths do not grow
longer as a chain gets longer, only their number does), so a long chain is
a bounded number of small files, not an unbounded string. Cleanup of
consumed arbiter/supersession paths (and of a superseded holder's
tombstone, see BLOCKER #2 below) is explicitly best-effort: if a process
crashes before its own cleanup step runs, or two cleanups race, some of
these small files can be left behind permanently. This is disclosed as a
real, accepted residual-resource-accumulation characteristic for a
workspace that crashes very repeatedly over a long lifetime — it is not a
correctness defect (a leftover file from an already-fully-superseded
occupant is never read as meaningful by anything; the fresh liveness/
identity check before every replace is what correctness actually rests
on), just an operational footnote nothing in this hardening pass claims to
have solved.

**#2 — `releaseWorkspaceLock`'s check-then-delete TOCTOU.** Even with full
identity comparison, release still read the main lock, compared identity,
and `rmSync`ed it — a real check-then-act gap on the one shared, reusable
path every caller contends over (the same shape of bug round 1 had, now on
the main lock directly). **Fix:** the release *contract* changed, not just
its implementation — release no longer ever touches the shared main-lock
path. It only creates (once, idempotently) a tombstone file whose path is a
deterministic hash of the releasing identity's OWN full identity
(`pid:generation:createdAt`) — a path unique to that exact identity that no
other identity could ever compute or need, so creating it can never race or
collide with anything else. A holder is now considered reclaimable if
EITHER its pid is confirmed dead (the unchanged crash path) OR its own
tombstone exists (the new graceful-release path). This also correctly
handles a graceful shutdown immediately followed by a restart under the
SAME pid (exercised directly by this test suite, and a real possibility for
any supervisor that reuses pids quickly): a bare pid-liveness check alone
cannot distinguish "the exact old generation is still running" from "this
pid number is currently free or reused", and no longer needs to for that
one case — the tombstone settles it unambiguously. The main lock file's own
content is left untouched by release; it is only ever overwritten later,
lazily, by whichever process next calls `acquireWorkspaceLock`, through the
exact same liveness-gated reclaim path already proven safe for crashes.
Because release never writes to, renames, or deletes the shared path, there
is no shared-path TOCTOU left for it to have — this is a stronger guarantee
than making the old check-then-delete atomic, which turned out to have no
clean, portable, mutex-free implementation using only create/link/rename
primitives (every such attempt still needed one "unconditionally act on
whatever is currently there" step, which is exactly the class of gap being
eliminated). One direct, intentional, and disclosed consequence: a unit
test that previously asserted `readWorkspaceLock()` returns `null`
immediately after a graceful release was updated to assert the old entry
is left in place (exactly like a crashed holder's) and that the *next*
acquirer reclaims it immediately — this is a deliberate contract change,
not a regression.
(`src/bridge/lock.ts`)

### H. Doctor's OAuth self-test could destroy a real, in-progress pairing (BLOCKER, found by independent audit, 2026-09-04)
The self-test checked `/admin/info`'s `pairingActive` once, then made
several more real round trips (DCR, `GET /oauth/authorize`) before finally
calling the (previously unconditional) `/admin/pairing`, which always
clears any existing session. A real `c2c pair` landing in that gap was
silently destroyed by the self-test's own later call — directly
contradicting the documented guarantee that the self-test never disrupts a
real pairing in progress.

**Fix:** `PairingManager` gained `createIfNoneActive()` — a synchronous
check-and-create with no `await` between the check and the mutation, so
nothing else this process handles can land in between. A new route,
`POST /admin/pairing/if-idle`, exposes this atomically; the self-test now
calls it instead of the unconditional `/admin/pairing` (which `c2c pair`
itself continues to use unconditionally, unchanged — a real `c2c pair`
must still be able to invalidate a stale prior session on purpose). If a
real session is already active by the time this call runs, the self-test
skips cleanly instead of proceeding.
(`src/pairing/manager.ts`, `src/bridge/server.ts`, `src/auth/oauth-self-test.ts`)

## 3. Files changed (all uncommitted)

Modified: `src/auth/oauth.ts`, `src/auth/store.ts`, `src/bridge/runtime.ts`,
`src/bridge/server.ts`, `src/cli/index.ts`, `src/pairing/manager.ts`,
`src/process/daemon.ts`, `tests/dist-entrypoint.test.ts`

New (created during this effort; `lock.ts` and `oauth-self-test.ts` also
received the §G/§H fixes above after their initial creation):
`src/auth/oauth-log.ts`, `src/auth/oauth-self-test.ts`, `src/bridge/lock.ts`,
`tests/oauth-connector-reliability.test.ts`, `tests/workspace-lock.test.ts`,
`tests/fixtures/lock-race-worker.ts`, `tests/fixtures/lock-release-hammer.ts`

## 4. Test coverage

**414 passed / 1 skipped, 27 files** (`npx vitest run`), reconfirmed
immediately before this report. This is not one uniform testing style —
broken down accurately by area:

- **OAuth route tests** (`tests/oauth.test.ts`,
  `tests/oauth-connector-reliability.test.ts`): a real HTTP server
  (`startBridge()`) for every test; the durability/idempotency/logging
  tests exercise real requests end to end, while a small number of
  specific failure-injection tests use a `vi.spyOn` on a store method to
  force a deliberately broken state (e.g. simulating DCR having silently
  failed to persist a client) — these are targeted spies on internal
  methods, not mocks of the HTTP layer itself.
- **Daemon/restart/lock tests** (`tests/dist-entrypoint.test.ts`,
  `tests/workspace-lock.test.ts`): real OS subprocesses throughout
  (`ensureBridge()`'s actual detached spawn, `c2c restart` as a real child
  process, the stale-lock race tests spawning independent real worker
  processes) — no mocks. One pure unit test (`sameLockInstance`'s identity
  comparison) is a direct function-level test, not a process test — see
  below for why.
- **Live acceptance** (§5): real ChatGPT, real Cloudflare named tunnel, no
  test harness involved at all.

New regression coverage added in this pass: the exact "1st Connect nothing,
2nd Connect expired" reproduction; bridge restart between every stage of
the OAuth flow; duplicate/double-submit handling; concurrent `startBridge()`
races (exactly one wins); stale-lock reclaim after a real `SIGKILL`; an
alive-but-conflicting owner never stolen from; concurrent pair/status
during a real restart; cross-workspace isolation; doctor detecting a live
ownership conflict; a real, actual-OS-process-crossing restart (not the
in-process `close()+startBridge()` simulation used elsewhere) proving
pending OAuth state survives it; the atomic `/admin/pairing/if-idle` route
never destroying an already-active real session (deterministic, no timing
dependency); and a real timed race between the self-test and a genuine
`c2c pair` call, confirming the real session survives and stays usable
afterward (this and the previous item were each confirmed, by temporarily
reverting their fix, to fail on the old code and pass on the new).

**On the stale-lock reclaim race specifically (§G), eight real-subprocess
tests plus one unit test, and four important corrections made along the
way:**
- A 2-process version (matching round 1's original finding) and a
  3-process version (round 2's finding — the round-1 fix protected the
  2-process case but not this one) each race real, independent OS
  processes against an identical dead stale lock and assert exactly one
  ever wins — **kept alive** (see below) throughout every loser's repeated
  retries, with every loser's every retry attempt recorded and asserted to
  have failed, and the lock file's identity itself sampled repeatedly
  during the hold window and asserted never to disagree with itself.
- **A TTL-survival test** (round-3-audit finding 1): a real worker
  acquires and is deliberately kept alive well past the old (now fully
  removed) 5-second reclaim-mutex TTL; a competing acquisition attempt
  during that window must still fail with `held_by_live_process` against
  the original, unchanged holder.
- **A release-vs-new-owner test** (round-3-audit finding 2): a real
  process acquires, is genuinely `SIGKILL`ed (not a graceful release), a
  second real process legitimately reclaims the now-confirmed-dead slot,
  and only then is `releaseWorkspaceLock` called with the *first*
  process's captured (now stale) identity — asserted to be a complete
  no-op against the second process's fresh claim.
- **A crash-recovery test**: a real, genuinely-alive holder is `SIGKILL`ed,
  then three real contenders race the now-dead slot simultaneously;
  exactly one recovers it.
- **A crash-window regression for round-4 BLOCKER #1**: a real process is
  paused (via a test-only env-var hook, `C2C_LOCK_TEST_ARBITER_PAUSE_FILE`)
  in the EXACT window after it wins arbitration but before it touches the
  main lock, then genuinely `SIGKILL`ed there, orphaning whatever it won.
  A second, completely ordinary real process must then still succeed
  immediately — not eventually, not after a delay — proving the crash does
  not leave the workspace permanently deadlocked.
- **A concurrent-release regression for round-4/5 BLOCKER #2**: a real
  fresh owner (P2) is acquired and held alive FIRST; only then is a real
  release hammer started against a genuinely `SIGKILL`ed P1's stale
  identity, running as fast as it can in a tight loop. Sampling is
  synchronized to the hammer's actual lifetime, not a guessed delay or
  fixed duration: the hammer writes a ready-file the instant it enters its
  release loop (the test waits for that before sampling starts), and
  sampling continues, roughly every 20ms, until the hammer process's own
  `exit` event fires. On EVERY sample taken in that window, the test
  directly asserts — not "collect observations and check the aggregate
  afterward" — that `readWorkspaceLock()` is non-null, that its full
  identity matches P2's exactly, and that `observePid(P2)` is `present`; a
  single `null` read or mismatch at any sample fails the test immediately,
  at that sample. This is what "throughout" means concretely here. The
  hammer's own result file is additionally checked for a clean exit code
  and a `calls` count greater than zero, so the test cannot go green if the
  hammer died before doing any real work, and P2's ownership is checked
  once more immediately after the hammer exits.
- **A max-one-owner regression for round-4 BLOCKER #1, specifically in the
  orphaned-arbiter-claim state**: reproduces the exact crash-window state
  above (a dead main holder, a real winner of arbitration killed before
  replacing the main lock, leaving its claim orphaned), then races TWO
  real contenders to recover it, with the eventual winner kept alive
  throughout so the loser's retries are a real, faithful race. The lock
  file's identity is sampled repeatedly during that window and asserted
  never to disagree with itself, and the loser's every recorded attempt is
  asserted to have failed — pinning "at most one live owner" specifically
  in the one state the earlier crash-window regression didn't itself
  directly re-exercise for that invariant.
- **Correction #1 (round 2 building this):** an earlier attempt at a
  "deterministic" version of the 3-process test used an artificially
  staged "observe the stale lock, pause, then resume and act" sequence.
  Direct experimentation before committing it showed it proved nothing: it
  passed identically on both the round-1 vulnerable code and the round-2
  fix (5/5 each), because `acquireWorkspaceLock()` always re-observes
  everything fresh on every call and has no memory of an earlier
  observation to act on stale-ly. It was replaced with real,
  simultaneously-released concurrent processes, which a direct 30-run
  experiment confirmed reproduces two simultaneous winners on 30/30 runs
  against the round-1 code, and 0/30 against the round-2 fix.
- **Correction #2 (round 3 building this):** that same 2-/3-process design
  let its winner exit immediately after winning, which (as explained in
  §G) let a later, entirely legitimate reclaim of a by-then-genuinely-dead
  winner look identical, from the outside, to a real simultaneous
  double-win. Root-caused with temporary debug instrumentation plus a
  captured, inspectable event-sequence log (not narrative-only) before
  concluding it was a test-harness gap, not a `lock.ts` defect; the fixed
  worker fixture now supports a genuine hold-until-released mode, used by
  both tests, so the winner is verifiably still `present` (via
  `observePid`) for the entire window every loser keeps retrying in.
  Re-run 10 times after the fix (`npx vitest run tests/workspace-lock.test.ts
  -t "stale-lock reclaim"`, full console output saved to local files for
  each run): 10/10 file runs green, 50/50 individual test executions
  passed, zero flakes.
- **Correction #3 (round 4 building this):** the 2-/3-process "kept alive"
  tests used a FIXED 300ms sleep to let the initial race settle before
  starting the momentary-ownership sampling loop. Running the round-4 suite
  repeatedly (per the evidentiary-record requirement below) caught this
  flaking once in 10 runs under system load — not a double-ownership bug,
  but the same settling transition Correction #2 already knew about,
  occasionally taking longer than the guessed 300ms. Fixed by polling for
  the race to actually settle (the placeholder gone, a live winner in
  place) instead of guessing a fixed duration; re-run 20/20 clean
  afterward (see below).
- **Correction #4 (round 5 audit finding, fixed round 5):** the round-4
  version of the concurrent-release regression only checked state AFTER
  both the hammer and the new owner's process had exited. The fifth-round
  audit correctly pointed out this could go green in a degenerate case —
  e.g. the hammer process dying immediately (an import error, a bad argv)
  before ever calling `releaseWorkspaceLock` even once — without proving
  anything actually raced. Fixed as described above: the hammer's fixture
  now writes its own result file with a `calls` count, and the test asserts
  a clean exit code, `calls > 0`, and samples the new owner's identity and
  liveness repeatedly *during* the hammer's run, not just before/after.
- The `pid`+`generation`+`createdAt` identity comparison
  (`sameLockInstance`) is tested directly as a pure unit test rather than
  via a constructed process scenario: forcing a genuine OS-level pid
  number coincidence between two real processes isn't something a test
  can reliably construct on demand, and (per round 3's design) the primary
  safety guarantee comes from the fresh `observePid()` liveness check
  performed immediately before any replace, independent of this
  comparison — see §G and §8 for the precise, non-overstated claim about
  what each piece actually guarantees.
- **Honest limit on this section's own rigor:** unlike Correction #1, the
  three new round-3 tests (TTL-survival, release-vs-new-owner,
  crash-recovery) were **not** separately confirmed to fail against
  round 2's mutex-based code. Round 2's `releaseWorkspaceLock` has a
  different (positional `workspaceId, pid`) signature than round 3's
  (single `WorkspaceLockInfo` object); calling it with round 3's test
  shape doesn't exercise round 2's real behavior, it silently no-ops
  against a nonsense path — so a naive differential run would have
  produced a misleading false "pass" on the old code, not real evidence,
  and is not reported as such. Round 3's actual guarantee is established
  instead by direct inspection of the committed code (no TTL/elapsed-time
  comparison exists anywhere in `lock.ts`; the only release condition is
  `sameLockInstance`'s full-identity match) plus these tests passing
  reliably against the current code — not by a differential result against
  the retired round-2 design. The same limit applies, for the same reason,
  to round 4's two new BLOCKER regressions against round 3's code: round
  3's `releaseWorkspaceLock` and arbiter design differ enough from round 4's
  that a naive differential run would not exercise the old bugs faithfully.
  Round 4's guarantee likewise rests on direct code inspection (arbiter
  ownership is now itself reclaim-gated purely by fresh liveness, never a
  static EEXIST dead-end; release creates only a uniquely-keyed tombstone
  and never touches the shared main-lock path) plus its own regressions
  passing reliably against the current code. The same is true of round 5's
  two strengthened/added regressions relative to round 4's code.
- **Evidentiary record (numbers below are exactly what was run, not
  estimates):**
  - Round 4: `npx vitest run tests/workspace-lock.test.ts` (all tests in
    this file, including both new BLOCKER regressions): 20/20 full-file
    runs green after Correction #3's fix, console output saved to local
    files for each run.
  - Round 5: `npx vitest run tests/workspace-lock.test.ts -t "stale-lock
    reclaim"` (the describe block containing all eight real-subprocess
    tests, including the strengthened concurrent-release regression and
    the new max-one-owner regression): 15/15 full-file runs green, console
    output saved to local files for each run.
  - The full project suite (`npx vitest run`, 27 files) was run once clean
    immediately before this report (§4's top-line 414/1/27 figure);
    typecheck (`tsc --noEmit`) and the production build (`npm run build`)
    both clean, also immediately before this report.

## 5. Live acceptance (today, real ChatGPT, real bridge, real Cloudflare tunnel)

1. Confirmed clean starting state after an actual, unplanned machine
   reboot overnight: stale lock + stale runtime pointer (dead pid) safely
   reclaimed by `doctor --fix`, exactly one canonical bridge resulted.
2. Real ChatGPT OAuth connect: pairing verified, authorization code issued,
   token exchanged, `workspace_info` called successfully from a real
   ChatGPT conversation through `https://c2c-dev.bluecabi.net`.
3. Reconnect (fresh authorization request, fresh pairing code):
   `workspace_info` succeeded again.
4. Real `c2c restart`: PID changed (`4940` -> `23204`), generation changed
   (`VuFXIi2ofm6V` -> `LmkLvcb8oG22`), old process confirmed gone, exactly
   one bridge and one tunnel process remained, doctor fully green
   afterward.
5. Post-restart `workspace_info` succeeded from the **same** ChatGPT
   conversation used before the restart — no reconnect, no re-pairing, no
   plugin recreation.
6. A genuine Cloudflare Tunnel outage occurred mid-session (`Error 1033`).
   Windows `LiveKernelEvent` kernel-fault log entries were observed in the
   same failure window; correlation/causation with the outage remains
   unproven, and the underlying cause of why the bridge and tunnel
   processes stopped was not established. What was verified: `doctor`'s
   detection of this state and its recovery via the existing `doctor --fix`
   path, with no duplicate bridge and no destructive action (see §6.2 for
   the full, precise wording of what this does and does not establish).

Along the way, several connect attempts failed with a *different* symptom
than anything this hardening targeted, and were investigated in full
before concluding they were unrelated to C2C:

- One failure was traced to a `c2c pair` invocation landing on an
  unrelated, wrong-workspace phantom bridge (operator error, not a code
  defect) -- explained by direct evidence, not fixed in code since nothing
  was broken.
- The remaining, reproducible failures were isolated (network capture
  analysis, redacted, no OAuth secret values read) to a specific
  browser/OS-level chain: `chatgpt.com`'s own connector-callback endpoint
  returns a *different* response depending on where the OAuth flow was
  initiated:
  - **ChatGPT Web/Chrome-initiated:** `chatgpt.com/connector/oauth/...`
    responds `HTTP 200` with its full web-app page; the hand-off to the
    `codex://` desktop app happens via that page's own client-side script.
    This path **works**.
  - **ChatGPT Desktop-app-initiated:** the same endpoint instead responds
    with an empty-body `HTTP 302` redirect directly to `codex://...`.
    Chrome's network layer receives this, cancels the underlying request
    (consistent with handing off to the OS's external-protocol handler),
    and — confirmed via Windows AppModel/TWinUI activation logs — no
    downstream OS-level activation of the `codex` app ever completes. This
    path **fails**, reproducibly.

  A controlled, single-variable A/B test (same registered OAuth client,
  same canonical bridge, same machine, only the initiation context
  changed) reproduced this split exactly on the first attempt of each
  condition. **This is not being claimed as proven intentional behavior on
  OpenAI's part** — only that Web-vs-Desktop initiation context correlates
  with two different `chatgpt.com` callback response paths, and that the
  Desktop-initiated path fails in this environment. This is entirely
  outside C2C's own code (C2C's own `/oauth/authorize` response is
  confirmed byte-for-byte identical in both the working and failing case).
  **No C2C code was changed or should be changed to work around or spoof
  this** — it isn't C2C's failure to fix.

  **Operational finding, not a code change:** until/unless this is
  resolved on OpenAI's side, initiate ChatGPT connector Reconnect from
  **Web/Chrome**, not the Desktop app, for this workspace.

## 6. Known remaining / external failure modes

These are tracked explicitly and separately from §2's fixes. None of them
are claimed as resolved by this hardening effort.

### 6.1 Desktop-initiated OAuth callback failure
- Web/Chrome-initiated Reconnect: `chatgpt.com/connector/oauth/...`
  responds `HTTP 200` with its web-app SPA -> hand-off succeeds.
- Desktop-app-initiated Reconnect: the same endpoint instead responds
  `HTTP 302` directly to `codex://...` -> Chrome cancels the request ->
  no OS-level activation ever completes -> failure.
- Reproduced via a controlled, single-variable A/B test (see §5).
- **Not a C2C-side difference** — C2C's own `/oauth/authorize` response is
  confirmed byte-for-byte identical in both the working and failing case.
- Current operational workaround: initiate ChatGPT connector Reconnect
  from **Web/Chrome**, not the Desktop app.
- Not being claimed as OpenAI's intentional designed behavior — only that
  it is observed, reproducible, and outside C2C's control.

### 6.2 Cloudflare Error 1033 (real outage, observed today)
- At the time this occurred, **both** the canonical bridge process and
  `cloudflared` had stopped running (not a tunnel-only blip).
- `doctor --no-fix` correctly reported this as non-green (`bridge.ok:
  false`, `tunnel.ok: false`) — detection confirmed.
- `doctor --fix` recovered a single, correct canonical bridge and
  tunnel — recovery-path confirmed.
- **C2C's detection and recovery behavior is confirmed; the root cause of
  why the bridge and tunnel processes stopped in the first place has NOT
  been fixed or diagnosed as a C2C defect.** Recovering cleanly is not the
  same as having fixed the underlying cause.
- Observed, not established as causal: numerous Windows `LiveKernelEvent`
  kernel-fault log entries occurred in the same time window as the outage.
  This is recorded as a coincident observation, not a confirmed root cause.

### 6.3 Historical stale OAuth registration / "Unknown client" (deferred)
- Occurred in the past, prior to this hardening effort: a plain Reconnect
  did not recover it, and deleting/recreating the ChatGPT connector plugin
  was required to resolve it at the time.
- This specific historical failure mode has **not** been re-provoked and
  confirmed fixed under the current code — it is recorded as a known,
  deferred issue, not as resolved.

### 6.4 Separate deferred issue: execution-record visibility mismatch
- Local `c2c record` execution records exist on disk, while ChatGPT's own
  MCP calls (`test_status` / `execution_summary` / `execution_output`)
  have previously returned no records for them.
- Reconfirmed still unresolved by the 2026-09-04 independent audit: as of
  the check performed during that audit, the latest `test_status` record
  visible to the connector was from an unrelated prior task
  (`c2c_kokuban_reliability_hardening`, iteration 6, 360 passed / 1
  skipped) rather than this OAuth hardening work; `execution_summary` had
  no record of this pass's passing-test counts at that time (a historical
  snapshot only, not re-checked since: it had shown 403, then 406, then 408
  across the successive rounds up to that point); `execution_output` was
  empty. This means the test-suite numbers reported in §4 (currently
  414 passed / 1 skipped, 27 files) cannot currently be independently
  verified via the connector's own execution-record tools — only via
  direct access to this repository (as every round of this review has
  had).
- This is unrelated to the OAuth work in this hardening effort and remains
  unfixed and deferred. Per explicit instruction, this does not block
  acceptance of the OAuth hardening in this report.

## 7. Current state

- Six BLOCKER-level issues found across four 2026-09-04 independent audit
  rounds are fixed: §G stale-lock reclaim race (round 1: rename+content
  check → found to still have a narrower, 3-process-only ABA; round 2: a
  TTL-bounded mutex → found to itself allow reclaiming a live-but-paused
  holder purely by elapsed time, and to have its own release-side TOCTOU;
  round 3: the mutex is removed entirely in favor of a per-dead-instance
  arbitration file keyed by that instance's own immutable identity, with
  no TTL anywhere in the design and full-identity-only release → found to
  still deadlock permanently if the arbitration winner crashed before
  replacing the main lock, and to still have a check-then-delete TOCTOU on
  `releaseWorkspaceLock` itself; round 4: arbiter ownership is now itself
  recursively reclaimable via a chain of uniquely-keyed supersession paths,
  each created fresh and never reused across two different occupants
  [makes forward progress under the tested/expected failure model, up to a
  bounded, fail-closed hop cap — see §G and §8, not an unconditional "never
  deadlocks"], and release no longer touches the shared main-lock path at
  all [structurally removes that specific TOCTOU shape]), and §H doctor
  self-test TOCTOU. §G's round-1→round-2 transition was validated by direct
  experiment (30/30 failing on the round-1 code, 0/30 on round 2) after an
  earlier "deterministic" test design was found to not discriminate at all
  between the two; round 3's and round 4's own regression tests were each
  confirmed to pass reliably against their respective current code (round
  3: 10/10 repeated full runs, 50/50 individual test executions; round 4:
  20/20 repeated full-file runs after one flake in the test harness itself
  was found and fixed — see §4's Correction #3; round 5's two strengthened/
  new regressions: 15/15 repeated runs), with the round-2→round-3
  test-harness bug root-caused via captured debug output rather than
  assumed (see §4 for the precise, non-overstated breakdown of what was and
  wasn't differentially re-verified against each retired design).
- A fifth 2026-09-04 independent audit round found **no new correctness
  BLOCKER** in round 4's lock design itself (the arbiter-chain and
  release-tombstone directions were both accepted as-is) — its findings
  were two test-coverage gaps in the round-4 regressions (neither test
  actually proved the scenario it claimed to prove strongly enough) and
  several report overclaims, both addressed in this round without changing
  `lock.ts`'s design: see the strengthened/new tests in §4 and the
  precision fixes throughout this report (in particular §G's new
  "Precise scope of this fix" paragraph and the artifact-lifecycle
  disclosure).
- Full test suite green, no regressions: 414 passed / 1 skipped, 27 files.
- Live acceptance passed end to end for everything in scope (§2), including
  a real restart cycle.
- A real, unrelated Cloudflare/infrastructure outage was recovered cleanly
  via the existing repair path (see §6.2 for what that does and does not
  establish).
- Nothing committed. Waiting for a further independent review round before
  any commit.

## 8. Explicit non-claims

- Not claiming the Desktop-vs-Web OAuth callback difference is intentional
  OpenAI design -- only that it is observed, reproducible, and outside
  C2C's control.
- Not claiming zero possibility of a residual edge case in single-instance
  ownership beyond what's covered by the lock-specific tests (the real 2-
  and 3-process stale-reclaim race tests, the TTL-survival test, the
  release-vs-new-owner test, the crash-recovery test, round 4's
  arbiter-crash-window regression, and round 5's strengthened
  concurrent-release regression and its new orphaned-arbiter max-one-owner
  regression, all §G) plus live verification (a real reboot, a real
  crash-equivalent kill during testing, and a real concurrent-restart race
  were all exercised, but this is real-world software, not a formal proof).
  Specifically: the
  `pid`+`generation`+`createdAt` identity comparison is tested only at the
  unit level (forcing a genuine OS pid-number coincidence between two real
  processes isn't something a test can reliably construct); the primary
  safety guarantee against ABA is the fresh `observePid()`/tombstone
  liveness re-check immediately before any replace, which the
  process-level tests do exercise for real. Round 4 removed both the
  separate reclaim-mutex concept AND the check-then-delete shape of
  release, replacing them with (a) a chain of never-reused,
  uniquely-keyed-per-occupant arbitration paths and (b) a release that only
  ever creates a tombstone unique to its own identity — by construction,
  neither remaining mechanism has a shared, reusable path that gets read
  and then acted on, which is what removes the round-3-audit findings (the
  arbiter-crash deadlock; the release TOCTOU) as a *class*, not just for
  the specific timing windows a test could reconstruct. What is not
  separately re-verified: a differential test run proving those two
  specific round-3 bugs actually reproduce against the retired round-3 code
  under this exact test harness (round 3's differently-shaped
  `releaseWorkspaceLock`/arbiter internals make a naive differential run
  produce a misleading result rather than real evidence — see §4's
  honest-limits note); the claim rests on direct code inspection of round 4
  (no path in the file is ever read-then-deleted based on a previously
  observed identity; the arbiter chain only ever creates new paths) plus
  round 4's own tests passing reliably (20/20 repeated runs), not on
  watching the old bugs fail first. The arbiter chain's own theoretical
  bound (a `maxHops` safety cap, currently 10,000) has never been
  approached in any test or live run; the longest chain any test in this
  suite produces is two hops (the round-4 crash-window regression, and
  round 5's orphaned-arbiter max-one-owner regression, which additionally
  exercises genuine concurrent contention for that second hop specifically
  — two real processes racing to supersede the same dead first-hop
  occupant at the same time, not just one process walking a chain someone
  else already fully resolved). A three-or-more-hop chain (two or more
  successive crashes in the exact same arbitration slot before anyone
  successfully replaces the main lock) is not exercised by any test here.
- Not claiming zero possibility of a residual edge case in the doctor
  self-test's pairing-safety guarantee (§H) beyond what's covered by the
  deterministic route-level test and the timed real-race test added for it
  — the timed test depends on a real (if generously-sized) timing window,
  not a formal proof.
- Not claiming the Cloudflare Error 1033 outage's root cause (why the
  bridge and cloudflared processes stopped) has been fixed — only that
  C2C's detection and recovery of that state is confirmed correct (§6.2).
- Not claiming the historical "Unknown client" / stale-registration failure
  mode (§6.3) has been re-tested and confirmed fixed under this code — it
  remains a deferred, open item.
- Not claiming the §4 test-suite numbers are independently verifiable via
  the connector's own execution-record tools at this time (§6.4).
