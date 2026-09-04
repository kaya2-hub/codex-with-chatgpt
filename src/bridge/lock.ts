import fs from "node:fs";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { ensureDir, getStateDir, readJsonIfExists } from "../config/paths.js";
import { observePid } from "./runtime.js";

/**
 * Workspace-level single-instance ownership (connector reliability
 * hardening, independent review 2026-09-03). Root cause this closes: a
 * transient health-probe failure against an already-alive, already-healthy
 * bridge (see runtime.ts's `findBridgeObservation`) is a CLIENT-side
 * observation, not proof the bridge is actually gone -- a caller that
 * spawns a second `serve` process on that assumption creates two live,
 * mutually invisible bridges for the same workspace, each with its own
 * in-memory AuthStore/PairingManager, sharing only the on-disk runtime
 * pointer file that whichever one persists to LAST wins (observed live:
 * `c2c pair`/`c2c status` resolved a stale duplicate on a different port
 * than the one ChatGPT's tunnel actually reached, so a freshly-minted
 * pairing session was invisible to the bridge that mattered).
 *
 * This lock is the actual enforcement point: a bridge acquires it as the
 * FIRST thing `startBridge()` does (before binding a port, before
 * persisting runtime state), and holds it for its entire process lifetime,
 * releasing it only on a graceful shutdown. A second `startBridge()` call
 * for the same workspace -- however it was triggered, spawned by
 * `ensureBridge()` or invoked directly via `c2c serve` -- fails fast here,
 * BEFORE it can ever become a second live, routable instance.
 *
 * Reclaim design history (this is the fourth iteration, independent review
 * 2026-09-04):
 *
 * Round 1: plain `rmSync` of a confirmed-dead stale lock, then recreate --
 * an ABA (two callers could both delete/recreate, one clobbering the
 * other's brand-new live lock).
 *
 * Round 2: rename-away + pid-only content check, serialized behind a
 * SEPARATE TTL-bounded "reclaim mutex" file -- the mutex itself could be
 * stolen from a genuinely-alive holder purely by elapsed time, and its own
 * release had the identical TOCTOU round 1 had, just relocated.
 *
 * Round 3: no separate mutex. Reclaiming one specific dead instance is
 * arbitrated by a file whose PATH is a deterministic hash of that dead
 * instance's own immutable identity, won via `fs.linkSync` (EEXIST if
 * already claimed) -- true single-winner exclusivity, no TTL anywhere.
 * Found (independent review, 2026-09-04, fourth audit) to have two further
 * gaps, both fixed in THIS round:
 *
 * BLOCKER (round 3 -> round 4, #1): if the arbitration winner crashed
 * between winning the arbiter file and actually replacing the main lock,
 * the arbiter path was permanently occupied by a claim nobody could ever
 * supersede (linkSync only succeeds against an ABSENT target, so a dead
 * winner's claim blocked every future contender forever -- a crash-induced
 * permanent deadlock for that workspace). Fixed by making arbiter
 * ownership itself recursively reclaimable, the SAME way the main lock
 * already is: if the current arbiter occupant is confirmed dead (via a
 * fresh `observePid` on the pid recorded IN the arbiter claim -- the
 * candidate file's own content, since `linkSync` makes the arbiter path and
 * the candidate the same inode), a contender does not delete or reuse that
 * arbiter path -- it computes a NEW, uniquely-keyed "supersession" path
 * (hashed from the arbiter path plus the dead occupant's own identity) and
 * races there instead, via the identical `linkSync` exclusivity. This
 * chains: each crash consumes one hop and immediately unblocks the next:
 * no path is ever reused across two different occupants, so this is never
 * a "read an old identity, then delete a shared path" operation (the class
 * of bug this whole feature exists to eliminate) -- it is always "create a
 * brand new, never-before-used path." A live occupant is never touched
 * (the chain only ever extends past a occupant CONFIRMED dead by a fresh
 * liveness check). See `winArbitration`.
 *
 * BLOCKER (round 3 -> round 4, #2): `releaseWorkspaceLock` still read the
 * main lock, compared identity, and `rmSync`ed it -- a real check-then-act
 * gap on the one shared, reusable path every caller contends over (the
 * exact same TOCTOU shape round 1 had, just on the main lock directly this
 * time). Fixed by changing what "release" means at the file-system level:
 * releasing NEVER touches the shared main-lock path at all anymore. It
 * only creates (once, idempotently) a small tombstone file whose path is a
 * deterministic hash of the RELEASING identity's own full identity
 * (`pid:generation:createdAt`) -- a path that is unique to that exact
 * identity and that no other identity could ever compute or need, so
 * creating it can never race or collide with anything. A holder is then
 * considered reclaimable if EITHER its pid is confirmed dead (the existing,
 * unchanged crash path) OR its own tombstone exists (the new, explicit
 * graceful-release path) -- see `isHolderStale`. This is also what lets a
 * process that gracefully shuts down and immediately restarts under the
 * SAME pid (a real scenario in this test suite, and a real one for any
 * supervisor that reuses pids quickly) be correctly treated as a fresh
 * identity rather than "still alive" purely because the OS pid number
 * happens to still resolve to something -- a bare pid check alone cannot
 * distinguish "the exact old generation is still running" from "a pid
 * number that used to mean something is currently unoccupied or reused",
 * and no longer needs to, since the tombstone settles it unambiguously for
 * the one case a pid check can't: a graceful release under an unchanged
 * pid. The main lock file's own content is left untouched by release and
 * only ever gets overwritten later, lazily, by whichever process next
 * calls `acquireWorkspaceLock` and goes through the exact same
 * liveness-gated reclaim path already proven safe for crashes -- release
 * never writes to, renames, or deletes the shared path, so there is no
 * shared-path TOCTOU left for it to have.
 *
 * A real, reliably-reproducing Windows-specific `EPERM`/`EBUSY`
 * sharing-violation was found and fixed while building round 2 (replacing
 * a destination another process has briefly open for reading can
 * transiently fail on Windows, with no POSIX equivalent) -- every
 * rename/link in this file goes through a bounded retry against exactly
 * that, unchanged since.
 */
export interface WorkspaceLockInfo {
  workspaceId: string;
  pid: number;
  generation: string;
  createdAt: string;
}

export type LockAcquireResult =
  | { ok: true }
  | { ok: false; reason: "held_by_live_process"; holder: WorkspaceLockInfo | null }
  | { ok: false; reason: "held_by_unconfirmed_process"; holder: WorkspaceLockInfo | null };

export function workspaceLockFile(workspaceId: string): string {
  return path.join(ensureDir(path.join(getStateDir(), "runtime")), `${workspaceId}.lock.json`);
}

/** Reads the current lock holder, if any, without acquiring or modifying
 *  anything. Used for diagnostics (doctor) and by tests. Never throws on a
 *  missing/corrupt file -- callers treat `null` as "no confirmed holder".
 *  NOTE: this can return an identity that has already gracefully released
 *  (its tombstone exists) but hasn't yet been reclaimed by a new acquirer --
 *  callers that need to know "is this identity still active" must check
 *  liveness (see `isHolderStale`/`acquireWorkspaceLock`), not just whether
 *  this returns non-null; this mirrors the pre-existing crash case exactly
 *  (a crashed holder's entry also lingers here until reclaimed). */
export function readWorkspaceLock(workspaceId: string): WorkspaceLockInfo | null {
  return readJsonIfExists<WorkspaceLockInfo>(workspaceLockFile(workspaceId));
}

/** True only if EVERY identity field matches -- the whole point of
 *  carrying `generation` and `createdAt` alongside `pid`: a lock that
 *  happens to reuse the exact same pid number as an old, already-confirmed-
 *  dead lock (a real possibility on any OS that recycles pids) must never
 *  be mistaken for that same old stale instance just because the pid
 *  column matches. Exported for direct unit testing -- see
 *  tests/workspace-lock.test.ts's identity-comparison test, which is the
 *  most faithful way to pin this specific guarantee: forcing a genuine OS
 *  pid-number coincidence between two real processes isn't something a
 *  test can reliably construct, but the comparison this function makes is
 *  exactly what would decide such a case, so it's tested directly. */
export function sameLockInstance(a: WorkspaceLockInfo, b: WorkspaceLockInfo): boolean {
  return a.pid === b.pid && a.generation === b.generation && a.createdAt === b.createdAt;
}

function identityHash(info: WorkspaceLockInfo): string {
  return createHash("sha256").update(`${info.pid}:${info.generation}:${info.createdAt}`).digest("hex").slice(0, 24);
}

function writeLockFile(file: string, info: WorkspaceLockInfo): void {
  const fd = fs.openSync(file, "w", 0o600);
  try {
    fs.writeSync(fd, Buffer.from(JSON.stringify(info)));
  } finally {
    fs.closeSync(fd);
  }
}

function sleepSyncMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * A bounded retry against Windows' `EPERM`/`EBUSY` sharing-violation
 * quirk: replacing/creating a path another process has open for even a
 * brief synchronous read can transiently fail there (no analogous failure
 * mode on POSIX). Observed live, reliably, under a real concurrent
 * reclaim race (independent review, 2026-09-04, round 2) -- not a logic
 * error, a real OS-level timing window that closes again within
 * microseconds once the other process's handle closes.
 */
function withEpermRetry<T>(fn: () => T, attempts = 40, delayMs = 5): T {
  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code === "EPERM" || code === "EBUSY") && attempt < attempts - 1) {
        sleepSyncMs(delayMs);
        continue;
      }
      throw error;
    }
  }
}

/**
 * Tombstone path for a graceful release of this EXACT identity
 * (independent review, 2026-09-04, round 4, BLOCKER #2). Unique per full
 * identity, so creating it can never collide with, race, or need to
 * consider any other identity's tombstone -- there is nothing to check
 * beforehand, which is what makes `releaseWorkspaceLock` safe to call from
 * a caller holding a stale reference: it only ever creates a path that
 * belongs to it and nobody else, never touches the shared main-lock path.
 */
function tombstonePathFor(file: string, info: WorkspaceLockInfo): string {
  return `${file}.released-${identityHash(info)}`;
}

/**
 * A holder is stale (safe to reclaim from) if EITHER its pid is confirmed
 * dead (the crash path, unchanged since round 3) OR it explicitly released
 * itself (its own tombstone exists -- the new graceful-release path, round
 * 4). Never guesses: an unreadable/non-integer holder, or a pid whose
 * liveness can't be confirmed either way, is never treated as stale.
 */
function isHolderStale(file: string, holder: WorkspaceLockInfo): boolean {
  if (fs.existsSync(tombstonePathFor(file, holder))) return true;
  return observePid(holder.pid) === "missing";
}

/**
 * Win the exclusive right to replace `file`'s CURRENT content (`deadHolder`,
 * already confirmed stale by the caller) with our own claim. Returns the
 * full chain of paths won (for cleanup) on success, or `null` if contended
 * (someone else currently holds the live end of the chain, or the target of
 * a hop couldn't be read -- caller should re-observe from scratch, never
 * assume anything).
 *
 * This is a chain, not a single file, specifically so a crashed winner can
 * never cause a permanent deadlock (independent review, 2026-09-04, round
 * 4, BLOCKER #1): `fs.linkSync` gives true single-winner exclusivity for a
 * given path (fails EEXIST if already claimed), but a path that's ALREADY
 * claimed forever remains EEXIST to everyone -- including a caller who
 * knows the claimant is now dead -- UNLESS there's a way to safely move
 * past a dead claimant. The move-past step here is: read the dead
 * claimant's own identity (its candidate file's content, since `linkSync`
 * makes the arbiter path and the candidate file the same inode), confirm
 * via a FRESH `observePid` that it is actually dead, and if so race for a
 * BRAND NEW path uniquely keyed to (this arbiter path, that exact dead
 * claimant's identity) -- never the same path, never a shared path decided
 * from someone else's earlier read. Any number of contenders that
 * independently discover the same dead claimant compute the IDENTICAL next
 * path and race there with the same `linkSync` exclusivity, so this never
 * loses the "at most one winner" property; it just relocates it one hop at
 * a time, exactly as many hops as there have been actual crashes in this
 * exact slot -- which is a small, finite, self-terminating number (each
 * hop consumes one crash and immediately produces a fresh, uncontended
 * slot), never a place where a stale artifact can jam things up forever.
 */
function winArbitration(rootPath: string, myClaimFile: string): { wonPaths: string[] } | null {
  let target = rootPath;
  const wonPaths: string[] = [];
  const maxHops = 10_000; // defensive cap only -- real chains are a handful of hops at most
  for (let hop = 0; hop < maxHops; hop++) {
    try {
      withEpermRetry(() => fs.linkSync(myClaimFile, target));
      wonPaths.push(target);
      return { wonPaths };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const occupant = readJsonIfExists<WorkspaceLockInfo>(target);
    if (!occupant || !Number.isInteger(occupant.pid)) return null; // unreadable/raced away -- re-observe from scratch, never guess
    if (observePid(occupant.pid) !== "missing") return null; // confirmed alive (or unconfirmed) -- never steal from it

    const key = `${target}::${occupant.pid}:${occupant.generation}:${occupant.createdAt}`;
    target = `${rootPath}.next-${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
  }
  throw new Error(`workspace lock arbitration exceeded ${maxHops} hops -- refusing to loop further`);
}

/** Test-only hook (independent review, 2026-09-04, round 4, BLOCKER #1
 *  regression): when `C2C_LOCK_TEST_ARBITER_PAUSE_FILE` is set, pause right
 *  after winning arbitration and before touching the main lock, so a test
 *  can deterministically kill this process in exactly that window and
 *  verify a later caller isn't permanently blocked by the orphaned claim.
 *  A production process never sets this env var, so this is a no-op
 *  outside tests. */
function testArbiterWinPauseHook(): void {
  const barrier = process.env.C2C_LOCK_TEST_ARBITER_PAUSE_FILE;
  if (!barrier) return;
  fs.writeFileSync(`${barrier}.reached`, "1");
  const deadline = Date.now() + 30_000;
  while (!fs.existsSync(`${barrier}.go`) && Date.now() < deadline) {
    // Busy-wait: this is a synchronous, single-threaded test hook: the test
    // that sets this env var always kills this process while it's parked
    // here (that's the whole point), so the 30s bound is only a safety net
    // against an accidentally-left-set env var, never expected to elapse.
  }
}

/**
 * Attempts a single atomic, exclusive claim of the lock file. Returns
 * "acquired" on success, "contended" whenever this call didn't win
 * (someone else holds the live end of the arbitration chain for the
 * current dead instance, the instance changed underneath it, or it's
 * alive/unconfirmed) -- the caller should re-observe from scratch, never
 * assume anything. Never reclaims a lock whose holder's liveness can't be
 * confirmed one way or the other (`observePid` -> "unknown", and no
 * tombstone) -- guessing wrong there would recreate the exact bug this
 * exists to prevent. Reclaim is gated purely by a FRESH liveness/tombstone
 * check, never by elapsed time.
 */
function tryAcquireOnce(file: string, info: WorkspaceLockInfo): "acquired" | "held_live" | "held_unconfirmed" | "contended" {
  try {
    const fd = fs.openSync(file, "wx", 0o600);
    try {
      fs.writeSync(fd, Buffer.from(JSON.stringify(info)));
    } finally {
      fs.closeSync(fd);
    }
    return "acquired";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  const holder = readJsonIfExists<WorkspaceLockInfo>(file);
  if (!holder || !Number.isInteger(holder.pid)) {
    // Corrupt/unreadable lock: never guess this is safe to steal from a
    // process we can't identify. Report it as unconfirmed, not stale.
    return "held_unconfirmed";
  }
  if (!isHolderStale(file, holder)) {
    // Confirmed alive (or unconfirmed liveness with no tombstone either) --
    // never steal from it. `held_unconfirmed` vs `held_live` is decided the
    // same way as before: an actually-alive pid is `held_live`; anything
    // else not provably stale is `held_unconfirmed`.
    return observePid(holder.pid) === "present" ? "held_live" : "held_unconfirmed";
  }

  // Confirmed stale (dead pid or explicit tombstone): race for the
  // exclusive right to reclaim THIS EXACT dead instance.
  const rootArbiterPath = `${file}.arbiter-${identityHash(holder)}`;
  const myClaim = `${file}.candidate-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeLockFile(myClaim, info);
  const won = winArbitration(rootArbiterPath, myClaim);
  if (!won) {
    try {
      fs.rmSync(myClaim, { force: true });
    } catch {
      // best-effort
    }
    return "contended";
  }

  testArbiterWinPauseHook();

  try {
    // Won the arbitration for this exact dead instance -- but re-verify
    // fresh immediately before acting anyway (cheap, and the safety net
    // that makes the arbiter chain's own best-effort post-success cleanup
    // below safe even against a late-arriving contender racing a stale
    // path that was already cleaned up).
    const current = readJsonIfExists<WorkspaceLockInfo>(file);
    if (!current || !sameLockInstance(current, holder) || !isHolderStale(file, current)) {
      return "contended";
    }
    withEpermRetry(() => fs.renameSync(myClaim, file));
    // Best-effort: the old holder's tombstone (if it released gracefully)
    // is now fully consumed -- nobody will ever again need to check that
    // exact identity's staleness, since `file` no longer reflects it.
    try {
      fs.rmSync(tombstonePathFor(file, holder), { force: true });
    } catch {
      // best-effort
    }
    return "acquired";
  } finally {
    // Best-effort: once we've either replaced `file` or given up, our
    // candidate file has either been consumed by the rename or is no
    // longer needed.
    try {
      fs.rmSync(myClaim, { force: true });
    } catch {
      // no-op if already renamed away
    }
    // Best-effort cleanup of every arbitration-chain path we won. Never
    // required for correctness (see the fresh re-check above and this
    // function's own doc comment) -- purely to avoid unbounded
    // accumulation of tiny files for a workspace that crashes repeatedly.
    for (const p of won.wonPaths) {
      try {
        fs.rmSync(p, { force: true });
      } catch {
        // best-effort
      }
    }
  }
}

/**
 * Acquire exclusive ownership of `info.workspaceId` for `info.pid`. Bounded
 * retry only to converge transient contention (another caller currently
 * winning/losing the arbitration for a dead instance) -- never retries
 * past a CONFIRMED-live or unconfirmed holder (those are immediate,
 * deterministic refusals).
 */
export function acquireWorkspaceLock(info: WorkspaceLockInfo, maxAttempts = 5): LockAcquireResult {
  const file = workspaceLockFile(info.workspaceId);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result = tryAcquireOnce(file, info);
    if (result === "acquired") return { ok: true };
    if (result === "contended") continue;
    const holder = readJsonIfExists<WorkspaceLockInfo>(file);
    return { ok: false, reason: result === "held_live" ? "held_by_live_process" : "held_by_unconfirmed_process", holder };
  }
  const holder = readJsonIfExists<WorkspaceLockInfo>(file);
  return { ok: false, reason: "held_by_unconfirmed_process", holder };
}

/**
 * Release the lock. Independent review, 2026-09-04, round 4 (BLOCKER #2):
 * this NEVER touches the shared main-lock file at all anymore -- it only
 * creates (idempotently -- a second call for the same identity is a
 * harmless no-op) a tombstone file whose path is unique to `info`'s own
 * full identity (pid + generation + createdAt). Because that path can
 * never be computed by, collide with, or matter to any other identity,
 * creating it is unconditionally safe: there is no shared state to check
 * first, so there is no check-then-act gap for a differently-timed caller
 * to land in. A stale/superseded caller invoking this with an old identity
 * therefore can never affect a different, later owner's fresh claim --
 * not because the old caller's judgment is re-verified fast enough, but
 * because it no longer makes a judgment about shared state at all. The
 * main lock's own content is left exactly as it was; the next
 * `acquireWorkspaceLock` call for this workspace discovers the tombstone
 * (see `isHolderStale`) and safely reclaims it through the same
 * liveness-gated path already used for crashes.
 */
export function releaseWorkspaceLock(info: WorkspaceLockInfo): void {
  const file = workspaceLockFile(info.workspaceId);
  try {
    const fd = fs.openSync(tombstonePathFor(file, info), "wx", 0o600);
    fs.closeSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // Already released -- idempotent no-op.
  }
}

export class WorkspaceLockConflictError extends Error {
  constructor(
    public readonly workspaceId: string,
    public readonly holder: WorkspaceLockInfo | null
  ) {
    super(
      holder
        ? `Another bridge already owns workspace ${workspaceId} (pid ${holder.pid}, generation ${holder.generation}). Refusing to start a second instance.`
        : `Workspace ${workspaceId} is locked by a process whose identity could not be confirmed. Refusing to start a second instance.`
    );
    this.name = "WorkspaceLockConflictError";
  }
}
