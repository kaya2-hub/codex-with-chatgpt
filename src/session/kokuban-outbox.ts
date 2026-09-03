import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { ensureDir, getStateDir, readJsonIfExists } from "../config/paths.js";

/**
 * Write-ahead durability for Kokuban Activity Events (connector reliability
 * hardening, Kokuban ITERATION 1). Independent review (2026-09-03, two
 * rounds) found real event-loss paths in an earlier version of this file:
 *
 * 1. A single JSON per event, destructively overwritten in place to flip
 *    "prepared" -> "committed", has a crash window of its own: a process
 *    dying mid-write can truncate/corrupt the ONLY copy of an event whose
 *    corresponding C2C state transition has ALREADY committed. Fixed here
 *    by never rewriting the payload: `<key>.json` is written EXACTLY ONCE
 *    (exclusive create) and is immutable from then on; "committed" is a
 *    SEPARATE, exclusively-created marker file (`<key>.committed`) whose
 *    mere EXISTENCE is the signal -- a partially-written marker still
 *    "exists" for `fs.existsSync`'s purposes, so there is no content to
 *    corrupt into a false negative.
 * 2. Reconciling a leftover "prepared" entry against the CURRENT saved
 *    session is only valid if no OTHER process can be concurrently
 *    mutating that session while the owning process is still between its
 *    own prepare() and commit() calls. A real cross-process race exists
 *    without serialization. Fixed with acquireKokubanLock/releaseKokubanLock
 *    below -- bounded, best-effort mutual exclusion (stale-lock breaking via
 *    a dead-pid check, and a short fail-OPEN timeout so lock contention
 *    itself can never block C2C's own work, only degrade Kokuban's
 *    durability guarantee for that one call).
 * 3. Disk content must never be trusted to redirect a filesystem operation
 *    to a workspace other than the one the caller explicitly asked about --
 *    every read validates the payload's own claimed workspaceId/
 *    idempotencyKey against what it was looked up by.
 *
 * Independent review, FOURTH round, found three further issues, all fixed
 * in this revision:
 * 4. Both the lock file and the outbox payload were created via a plain
 *    exclusive-create write (open + write + close as separate syscalls) --
 *    a process dying between the open and the write leaves an empty/
 *    truncated file behind that can never be told apart from "in progress"
 *    and, for the lock specifically, could never be recognized as stale
 *    (no readable pid to check liveness against). Fixed via
 *    atomicExclusiveCreate() below: content is written IN FULL to a private
 *    temp file first, then published under its real name with a hard link
 *    (fails EEXIST if the name is already taken, exactly like the direct
 *    exclusive-create it replaces) -- the real filename is therefore never
 *    observable in a partial state: it either doesn't exist yet, or exists
 *    complete.
 * 5. A same-key retry whose existing payload turned out to be unreadable
 *    used to throw unconditionally, permanently blocking that transition
 *    from ever being retried again. Fixed by distinguishing the two cases
 *    that can now produce an unreadable existing payload (both external
 *    corruption/tampering only -- atomicExclusiveCreate() means OUR OWN
 *    writes can no longer produce this): no commit marker present (never
 *    confirmed committed -- safe to quarantine the corrupt orphan and
 *    retry once) vs. a commit marker present (already durably committed --
 *    the original event can't be recovered, so this still throws, but with
 *    a message that says so plainly instead of looking identical to any
 *    other local write-ahead failure).
 * 6. listOutboxEntries() had no defined order (raw filesystem readdir
 *    order, unrelated to transition order since filenames are hashes), and
 *    every caller kept attempting later events after an earlier one's
 *    delivery failed -- both together could let a newer event reach
 *    Kokuban before an older one whose delivery was still unconfirmed,
 *    inverting event order at the remote log. Fixed with a durable
 *    per-workspace sequence counter (assigned at prepare() time, persisted
 *    alongside the event, always incremented while the caller holds this
 *    workspace's Kokuban lock -- see nextOutboxSequence()) that
 *    listOutboxEntries() now sorts by, plus sendKokubanEventsInOrder() (see
 *    kokuban.ts) which delivers strictly in that order and stops at the
 *    first unconfirmed/failed send rather than skipping ahead to newer
 *    events.
 *
 * Independent review, FIFTH round: the post-send discard (on confirmed
 * delivery) used to run with no lock held at all -- same as the network
 * call it follows, which is correct for the network call itself, but the
 * discard is a LOCAL filesystem mutation touching the exact same entry a
 * concurrent process's own reconciliation pass might be reading inside
 * ITS lock right now. Fixed in sendAndDiscardKokubanEvent() (kokuban.ts):
 * the network send itself is still made with no lock held, but a
 * confirmed-successful send now briefly RE-acquires this workspace's lock
 * for the discard alone (re-verified against the same `sequence` first),
 * and leaves the entry in place for a later, duplicate-safe retry if that
 * re-acquire fails -- Kokuban's own idempotency (`duplicate: true`) makes
 * a stray extra retry harmless, which is the safe default over an
 * unprotected discard racing a concurrent reconciliation.
 *
 * Lifecycle of one event:
 *   prepare()  -- `<key>.json` written ONCE, before the caller's
 *                 writeSession() call. A second prepare() for the SAME key
 *                 (the same logical transition retried) is a no-op --
 *                 whichever payload was written first wins; it is NEVER
 *                 overwritten with fresher-but-different content.
 *   commit()   -- `<key>.committed` marker created AFTER writeSession()
 *                 returns successfully. From this point the event is
 *                 known-good regardless of what session state looks like
 *                 later.
 *   discard()  -- deletes both files. Used both for "confirmed sent" and
 *                 for "reconciliation proved this prepared event's
 *                 transition never actually committed".
 */

export type KokubanOutboxStatus = "prepared" | "committed";

export interface KokubanCanonicalEvent {
  idempotencyKey: string;
  workspaceId: string;
  projectKey: string;
  /** Normalized (uppercased, trimmed) C2C wire state -- INIT/PLAN/EXECUTED/BLOCKED/DONE. */
  state: string;
  taskId: string;
  iteration: number;
  actor: string;
  apiBaseUrl: string;
  tokenEnvVar: string;
  /** Fixed once at prepare() time and never regenerated. */
  occurredAt: string;
  message: string;
  holderAfter?: string;
  stopReason?: string;
  summary?: string;
  /**
   * The EXACT JSON string that gets POSTed as the request body, computed
   * once at prepare() time and reused byte-for-byte on every send attempt
   * -- including retries long after session state has moved on to later
   * transitions. Never reconstructed from the fields above at send time
   * (independent review found that reconstructing risked drifting from
   * "byte-identical" into merely "semantically equal").
   */
  requestBody: string;
  preparedAt: string;
  /** Durable per-workspace monotonic counter, assigned once at prepare()
   *  time (see nextOutboxSequence()) -- the ONLY thing listOutboxEntries()
   *  orders by. Filenames (hashed idempotency keys) carry no ordering
   *  information themselves. */
  sequence: number;
}

export interface KokubanOutboxEntry {
  status: KokubanOutboxStatus;
  event: KokubanCanonicalEvent;
}

function outboxDir(workspaceId: string): string {
  return ensureDir(path.join(getStateDir(), "kokuban-outbox", workspaceId));
}

function payloadFile(workspaceId: string, idempotencyKey: string): string {
  return path.join(outboxDir(workspaceId), `${idempotencyKey}.json`);
}

function markerFile(workspaceId: string, idempotencyKey: string): string {
  return path.join(outboxDir(workspaceId), `${idempotencyKey}.committed`);
}

/**
 * Publishes `content` under `finalPath` such that `finalPath` is NEVER
 * observable in a partial/truncated state -- it either doesn't exist yet,
 * or exists complete (independent review, fourth round). Writes the full
 * content to a private temp file in the SAME directory first (so the
 * publish step below is on the same filesystem/volume), then publishes it
 * with `fs.linkSync` -- a hard link, not a rename: unlike rename (which
 * silently overwrites cross-platform), link fails with EEXIST if
 * `finalPath` already exists, preserving the same exclusive-create
 * semantics this replaces. Returns true if this call created `finalPath`,
 * false if it already existed (EEXIST); other errors propagate. The temp
 * file is always removed afterward, best-effort -- an orphaned temp file
 * left behind by a crash between the two writes is harmless (ignored by
 * every directory listing in this module, all of which filter by their
 * own specific suffix) and never observable under `finalPath` itself.
 */
function atomicExclusiveCreate(finalPath: string, content: string, mode: number): boolean {
  const dir = path.dirname(finalPath);
  ensureDir(dir);
  const tmpPath = path.join(dir, `.tmp-${path.basename(finalPath)}-${process.pid}-${randomBytes(6).toString("hex")}`);
  fs.writeFileSync(tmpPath, content, { mode, flag: "wx" });
  try {
    fs.linkSync(tmpPath, finalPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Best effort -- see doc comment above.
    }
  }
}

function sequenceFile(workspaceId: string): string {
  return path.join(outboxDir(workspaceId), ".seq");
}

/**
 * Assigns and durably persists this workspace's next outbox sequence
 * number, returning the number assigned to THIS call. The read-modify-write
 * here is not itself atomic -- it relies entirely on the caller holding
 * this workspace's Kokuban lock for mutual exclusion (see
 * runUnderKokubanLock), exactly like the rest of the prepare step it's
 * called from. The counter FILE's own update is still crash-safe (write a
 * temp file, then atomically rename it over the real one -- rename's
 * overwrite semantics are fine here since this is a genuine update, not an
 * exclusive-create), so a crash can never leave a torn/partial `.seq` file,
 * only -- in the rarest case -- a slightly stale one, which just costs a
 * duplicate or skipped sequence number rather than any corruption or event
 * loss.
 */
function nextOutboxSequence(workspaceId: string): number {
  const file = sequenceFile(workspaceId);
  const dir = path.dirname(file);
  ensureDir(dir);
  const assigned = readJsonIfExists<{ next: number }>(file)?.next ?? 0;
  const tmp = path.join(dir, `.seq-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ next: assigned + 1 }), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return assigned;
}

/** Deterministic from the identifying fields only (never occurredAt/summary/
 *  etc.) -- the SAME logical transition always maps to the SAME file. */
export function computeIdempotencyKey(projectKey: string, taskId: string, iteration: number, state: string): string {
  return createHash("sha256").update(`${projectKey}|${taskId}|${iteration}|${state}`).digest("hex").slice(0, 32);
}

const IDEMPOTENCY_KEY_RE = /^[0-9a-f]{32}$/;

/**
 * Step 1-2 of the write-ahead sequence: durably persist the canonical event
 * as "prepared", exactly once, BEFORE the caller commits the corresponding
 * C2C session state. Exclusive-create (`wx`): a SECOND call for the same
 * idempotency key (the same logical transition retried) is a deliberate
 * no-op, never an overwrite -- the first-ever payload for a given key is
 * canonical for its lifetime. Returns the CANONICAL event for this key --
 * on a fresh write that is `event` itself; on same-key reuse it is
 * whatever was actually persisted the first time (re-read from disk),
 * which may differ from `event` (e.g. a different occurredAt).
 *
 * Deliberately NOT fail-soft: a genuine local write failure (disk full,
 * permissions, ENOTDIR on the state directory) is re-thrown. The whole
 * point of this file is a durability guarantee for the local write; a
 * caller that silently proceeded to writeSession() on a failed prepare
 * would be committing C2C state with NO local record of the corresponding
 * Kokuban event at all -- worse than not having this feature. Callers
 * should treat a throw here as "stop before writeSession()", not as
 * something to swallow. (Kokuban's own REMOTE/network failures remain
 * fully fail-soft -- see reportKokubanTransition/sendKokubanEvent in
 * kokuban.ts -- this exception applies only to the LOCAL write-ahead write
 * itself, which is a different failure class.)
 *
 * Independent review (2026-09-03, third round) found that the previous
 * version fell back to the freshly-built in-memory `event` whenever EEXIST
 * fired but the existing on-disk entry could not be read back (corrupt or
 * failed the workspace/key confinement check) -- silently proceeding as if
 * a valid durable record existed when it did not. Fixed: that case now
 * throws instead of fabricating one -- except (fourth round) when the
 * unreadable entry was never confirmed committed, in which case it's safe
 * to quarantine and retry once; see the doc comment on the "throw" branch
 * below for the full distinction.
 *
 * Also assigns and persists this call's durable outbox sequence number
 * (fourth round) as part of the same atomic write -- see
 * nextOutboxSequence() -- so `event`'s caller-supplied fields never need to
 * know about ordering at all.
 */
export function prepareOutboxEvent(event: Omit<KokubanCanonicalEvent, "sequence">): KokubanCanonicalEvent {
  const file = payloadFile(event.workspaceId, event.idempotencyKey);
  const withSequence = (): KokubanCanonicalEvent => ({ ...event, sequence: nextOutboxSequence(event.workspaceId) });

  const attempt = (): KokubanCanonicalEvent | null => {
    const full = withSequence();
    if (atomicExclusiveCreate(file, JSON.stringify(full, null, 2), 0o600)) return full;
    return null; // EEXIST -- same-key reuse, handled by the caller below
  };

  const fresh = attempt();
  if (fresh) return fresh;

  // Same-key reuse: a payload already exists. It -- not this call's
  // freshly-built object -- is canonical.
  const existing = readOutboxEvent(event.workspaceId, event.idempotencyKey);
  if (existing) return existing.event;

  // The existing entry can't be read back as valid (corrupt content, or
  // fails the workspace/key confinement check in readOutboxEvent). Since
  // atomicExclusiveCreate() means OUR OWN writes can no longer produce a
  // partial file, this is external corruption/tampering only -- but it can
  // still be one of two genuinely different situations:
  const committed = fs.existsSync(markerFile(event.workspaceId, event.idempotencyKey));
  if (committed) {
    // This transition was already confirmed durable/committed by a
    // previous run; only its payload has since become unreadable. The C2C
    // state transition itself is not at risk -- it already committed --
    // but the original event body can't be recovered, so this Kokuban
    // Activity Event is unrecoverably lost. Fail closed rather than
    // silently losing it without a trace (and never touch the marker: a
    // human/operator inspecting this workspace's outbox should still be
    // able to tell "this transition committed" from the marker alone).
    throw new Error(
      `kokuban outbox: entry for idempotency key ${event.idempotencyKey} is marked committed but its payload is unreadable/corrupt -- the original event cannot be recovered`
    );
  }
  // Never confirmed committed -- nothing durable is lost by discarding it.
  // Quarantine the corrupt orphan and retry once, restoring the ability to
  // prepare this transition instead of blocking it forever.
  discardOutboxEvent(event.workspaceId, event.idempotencyKey);
  const retried = attempt();
  if (!retried) {
    throw new Error(
      `kokuban outbox: could not prepare event for idempotency key ${event.idempotencyKey} even after clearing a corrupt, never-committed orphan entry`
    );
  }
  return retried;
}

/**
 * Step 3 happens in the caller (writeSession()) between prepare and this
 * call. Step 4: durably mark the SAME event "committed" via an exclusive
 * marker file -- never rewrites `<key>.json` itself. Returns false when
 * there is no valid stored payload for this key to attach a marker to
 * (independent review, third round: a marker must never be fabricated for
 * an entry that doesn't durably exist -- that would create a "committed"
 * status with nothing underneath it to actually send), or when the marker
 * write itself failed for a reason other than "already committed" --
 * callers should warn, not block: by this point writeSession() has ALREADY
 * succeeded, so there is nothing left to roll back, only a (still-intact,
 * immutable) payload to warn about. A `false` return here is always safe
 * to retry: the next reconciliation pass (see reconcileKokubanOutboxLocally)
 * will find the still-"prepared" entry, confirm it against session state,
 * and promote it then.
 */
export function commitOutboxEvent(workspaceId: string, idempotencyKey: string): boolean {
  if (!readOutboxEvent(workspaceId, idempotencyKey)) return false;
  const file = markerFile(workspaceId, idempotencyKey);
  try {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, "", { mode: 0o600, flag: "wx" });
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EEXIST";
  }
}

/** Used both for "confirmed sent" and for "reconciliation proved this
 *  prepared transition never committed". Fail-soft. */
export function discardOutboxEvent(workspaceId: string, idempotencyKey: string): void {
  try {
    fs.rmSync(payloadFile(workspaceId, idempotencyKey), { force: true });
  } catch {
    // Fail-soft.
  }
  try {
    fs.rmSync(markerFile(workspaceId, idempotencyKey), { force: true });
  } catch {
    // Fail-soft.
  }
}

/**
 * Workspace confinement: the on-disk payload's OWN claimed workspaceId and
 * idempotencyKey must match what it was looked up by, or it is treated as
 * invalid and ignored -- disk content is never trusted to redirect a
 * filesystem operation to a different workspace or a different entry than
 * the caller explicitly asked about.
 */
export function readOutboxEvent(workspaceId: string, idempotencyKey: string): KokubanOutboxEntry | null {
  const event = readJsonIfExists<KokubanCanonicalEvent>(payloadFile(workspaceId, idempotencyKey));
  if (!event) return null;
  if (event.workspaceId !== workspaceId || event.idempotencyKey !== idempotencyKey) return null;
  const committed = fs.existsSync(markerFile(workspaceId, idempotencyKey));
  return { status: committed ? "committed" : "prepared", event };
}

/** Read-only listing of this workspace's own outbox only -- never another
 *  workspace's directory (only ever reads inside outboxDir(workspaceId)).
 *  Filenames that don't look like a well-formed idempotency key, and
 *  entries whose own content fails the confinement check above, are
 *  skipped rather than acted on. Sorted ascending by each event's own
 *  durable `sequence` number (independent review, fourth round) --
 *  filesystem readdir order carries no transition-order information at
 *  all, since filenames are hashed idempotency keys. Callers that deliver
 *  these over the network MUST preserve this order and stop at the first
 *  unconfirmed/failed send (see sendKokubanEventsInOrder() in kokuban.ts)
 *  -- this function only establishes the order, it doesn't enforce it. */
export function listOutboxEntries(workspaceId: string): KokubanOutboxEntry[] {
  let dir: string;
  let files: string[];
  try {
    dir = outboxDir(workspaceId);
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const entries: KokubanOutboxEntry[] = [];
  for (const file of files) {
    const key = file.slice(0, -".json".length);
    if (!IDEMPOTENCY_KEY_RE.test(key)) continue;
    const entry = readOutboxEvent(workspaceId, key);
    if (entry) entries.push(entry);
  }
  entries.sort((a, b) => a.event.sequence - b.event.sequence);
  return entries;
}

// ---------------------------------------------------------------------
// Cross-process mutual exclusion (BLOCKER 3, independent review).
// ---------------------------------------------------------------------

export interface KokubanLockHandle {
  held: boolean;
}

const LOCK_ACQUIRE_TIMEOUT_MS = 3_000;
const LOCK_RETRY_DELAY_MS = 50;

function lockFile(workspaceId: string): string {
  return path.join(outboxDir(workspaceId), ".lock");
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Same fail-closed convention as bridge/runtime.ts's observePid: only a
    // confirmed ESRCH means "definitely gone"; anything else (e.g. EPERM)
    // is treated as "can't rule out alive", so the lock is NOT broken.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Bounded cross-process lock for one workspace's Kokuban outbox + the
 * session-mutation boundary that must stay consistent with it. NEVER blocks
 * indefinitely: on contention it waits up to LOCK_ACQUIRE_TIMEOUT_MS,
 * breaking a stale lock (confirmed-dead pid) immediately when found, then
 * gives up and returns `{held:false}`.
 *
 * Policy on `{held:false}` (revised, independent review, third round):
 * contention here means another LOCAL process is concurrently mutating
 * THIS SAME workspace's session/outbox right now -- not a Kokuban/network
 * problem. The distinction already established for the write-ahead write
 * itself (local durability failure blocks; remote delivery failure stays
 * fail-soft) applies here too: prefer runUnderKokubanLock() below, which
 * treats `{held:false}` as fail-CLOSED for the whole local mutation
 * (nothing about this is a "Kokuban is down" condition; it is a same-
 * workspace local serialization conflict, expected to be rare and brief).
 * Only the low-level primitive itself still just reports `{held:false}` --
 * lower-level, direct callers remain free to degrade differently if they
 * have a reason to, but no current caller does. Release the lock as soon as
 * the LOCAL write-ahead work is done -- never hold it across a network
 * call.
 */
export async function acquireKokubanLock(workspaceId: string): Promise<KokubanLockHandle> {
  const file = lockFile(workspaceId);
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
  for (;;) {
    try {
      // atomicExclusiveCreate() (independent review, fourth round): the
      // lock file is never observable half-written -- a crash between
      // "created" and "pid written" used to leave an empty file that the
      // pid-liveness check below couldn't read an owner from, so it could
      // never be recognized as stale, wedging this workspace's lock
      // forever. With the full content written to a temp file BEFORE the
      // real name is published, that window no longer exists.
      if (atomicExclusiveCreate(file, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }), 0o600)) {
        return { held: true };
      }
    } catch {
      return { held: false }; // unexpected fs error -- fail open
    }
    const info = readJsonIfExists<{ pid: number }>(file);
    if (info && !isPidAlive(info.pid)) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // best effort
      }
      continue; // stale lock cleared -- retry immediately
    }
    if (Date.now() > deadline) return { held: false }; // fail open -- never block C2C
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_DELAY_MS));
  }
}

export function releaseKokubanLock(workspaceId: string, handle: KokubanLockHandle): void {
  if (!handle.held) return;
  try {
    fs.rmSync(lockFile(workspaceId), { force: true });
  } catch {
    // Fail-soft -- a leftover lock file will self-heal via the stale-pid
    // check the next time anyone tries to acquire it.
  }
}

/** Thrown by runUnderKokubanLock() when the lock could not be acquired
 *  within the bounded timeout -- always safe to retry the whole command. */
export class KokubanLockUnavailableError extends Error {
  constructor(workspaceId: string) {
    super(
      `Kokuban outbox lock for this workspace could not be acquired within ${LOCK_ACQUIRE_TIMEOUT_MS}ms -- another process appears to be updating this workspace's session/Kokuban outbox right now (workspaceId: ${workspaceId}). Try again.`
    );
    this.name = "KokubanLockUnavailableError";
  }
}

/**
 * The single required critical-section boundary for a Kokuban-enabled
 * workspace's session mutation (independent review, third round): acquires
 * the lock, runs `fn` (which MUST do -- in order, and MUST NOT perform any
 * network call -- local reconciliation of leftover outbox entries, read the
 * current session, prepare/commit the new transition if any, and call
 * writeSession()), then releases the lock in a `finally` regardless of how
 * `fn` exits. `fn`'s own local write-ahead failures (see prepareOutboxEvent)
 * propagate through unchanged.
 *
 * Fails CLOSED on lock contention: throws KokubanLockUnavailableError rather
 * than letting `fn` run unlocked. Earlier revisions instead ran the local
 * reconciliation/mutation sequence split across two separate lock
 * acquisitions (draining, then later re-locking to mutate), which left a gap
 * between them for another process to interleave -- and treated
 * `{held:false}` as "proceed anyway", which defeated the guarantee under
 * genuine contention. Both are fixed by making this the ONLY entry point
 * production code uses for a Kokuban-enabled session mutation.
 */
export async function runUnderKokubanLock<T>(workspaceId: string, fn: () => T | Promise<T>): Promise<T> {
  const lock = await acquireKokubanLock(workspaceId);
  if (!lock.held) throw new KokubanLockUnavailableError(workspaceId);
  try {
    return await fn();
  } finally {
    releaseKokubanLock(workspaceId, lock);
  }
}
