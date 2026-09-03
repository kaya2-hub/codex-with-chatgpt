import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Workspace } from "../src/workspace/manager.js";
import { sanitizeProjectKey, type EffectiveKokubanConfig } from "../src/session/kokuban-config.js";
import { readSession, writeSession } from "../src/session/state.js";
import { runCli } from "../src/cli/index.js";
import {
  drainKokubanOutbox,
  prepareKokubanTransition,
  reconcileKokubanOutboxLocally,
  sendAndDiscardKokubanEvent,
  sendKokubanEventsInOrder,
} from "../src/session/kokuban.js";
import {
  acquireKokubanLock,
  commitOutboxEvent,
  computeIdempotencyKey,
  discardOutboxEvent,
  KokubanLockUnavailableError,
  listOutboxEntries,
  prepareOutboxEvent,
  readOutboxEvent,
  releaseKokubanLock,
  runUnderKokubanLock,
  type KokubanCanonicalEvent,
} from "../src/session/kokuban-outbox.js";
import { getStateDir } from "../src/config/paths.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

const CONFIG: EffectiveKokubanConfig = { projectKey: "bluecabi-personal-core" };
const WS = "ws-outbox-test";

function successResponse(): Response {
  return new Response(JSON.stringify({ duplicate: false }), { status: 201 });
}

function sampleEvent(overrides: Partial<KokubanCanonicalEvent> = {}): KokubanCanonicalEvent {
  const base: KokubanCanonicalEvent = {
    idempotencyKey: computeIdempotencyKey(CONFIG.projectKey, "t1", 0, "PLAN"),
    workspaceId: WS,
    projectKey: CONFIG.projectKey,
    state: "PLAN",
    taskId: "t1",
    iteration: 0,
    actor: "coding_agent",
    apiBaseUrl: "https://core.bluecabi.net",
    tokenEnvVar: "KOKUBAN_WRITE_TOKEN",
    occurredAt: "2026-09-03T00:00:00.000Z",
    message: "[C2C]\nSTATE: PLAN\nTASK_ID: t1\nITERATION: 0",
    requestBody: JSON.stringify({
      projectKey: CONFIG.projectKey,
      actor: "coding_agent",
      occurredAt: "2026-09-03T00:00:00.000Z",
      message: "[C2C]\nSTATE: PLAN\nTASK_ID: t1\nITERATION: 0",
    }),
    preparedAt: "2026-09-03T00:00:00.000Z",
    sequence: 0,
  };
  return { ...base, ...overrides };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete process.env.KOKUBAN_WRITE_TOKEN;
  delete process.env.C2C_STATE_DIR;
});

describe("kokuban-outbox.ts primitives", () => {
  it("computeIdempotencyKey is deterministic and distinguishes different transitions", () => {
    isolateStateDir();
    const a = computeIdempotencyKey("proj", "task1", 0, "PLAN");
    const b = computeIdempotencyKey("proj", "task1", 0, "PLAN");
    const c = computeIdempotencyKey("proj", "task1", 1, "PLAN");
    const d = computeIdempotencyKey("proj", "task1", 0, "EXECUTED");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
  });

  it("prepare -> read (prepared) -> commit -> read (committed) -> discard round trip", () => {
    isolateStateDir();
    const event = sampleEvent();
    expect(prepareOutboxEvent(event)).toEqual(event);
    const prepared = readOutboxEvent(WS, event.idempotencyKey);
    expect(prepared?.status).toBe("prepared");
    expect(prepared?.event).toEqual(event);

    expect(commitOutboxEvent(WS, event.idempotencyKey)).toBe(true);
    const committed = readOutboxEvent(WS, event.idempotencyKey);
    expect(committed?.status).toBe("committed");
    expect(committed?.event).toEqual(event); // payload byte-identical -- commit never rewrites it

    discardOutboxEvent(WS, event.idempotencyKey);
    expect(readOutboxEvent(WS, event.idempotencyKey)).toBeNull();
  });

  // Independent review, third round: a marker must never be fabricated for
  // a key with no valid durable payload underneath it -- that would create
  // a "committed" status with nothing to actually send.
  it("commitOutboxEvent refuses to fabricate a marker for a key with no valid payload; discard on a missing entry is still a safe no-op", () => {
    isolateStateDir();
    expect(commitOutboxEvent(WS, "does-not-exist")).toBe(false);
    const markerPath = path.join(getStateDir(), "kokuban-outbox", WS, "does-not-exist.committed");
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(() => discardOutboxEvent(WS, "does-not-exist")).not.toThrow();
  });

  it("listOutboxEntries returns empty for a workspace with no outbox yet", () => {
    isolateStateDir();
    expect(listOutboxEntries("brand-new-ws")).toEqual([]);
  });

  // BLOCKER 1 (independent review): commit must never rewrite the payload
  // file -- it only creates a separate marker. This is what makes a crash
  // mid-commit safe: the payload's own content can never be corrupted by
  // the commit step, because the commit step never touches it.
  it("BLOCKER 1 -- commit never touches the payload file's bytes on disk", () => {
    isolateStateDir();
    const event = sampleEvent();
    prepareOutboxEvent(event);
    const payloadPath = path.join(getStateDir(), "kokuban-outbox", WS, `${event.idempotencyKey}.json`);
    const beforeBytes = fs.readFileSync(payloadPath);

    commitOutboxEvent(WS, event.idempotencyKey);

    const afterBytes = fs.readFileSync(payloadPath);
    expect(afterBytes.equals(beforeBytes)).toBe(true); // literally byte-for-byte unchanged
    // Status is derived purely from a SEPARATE marker file's existence.
    const markerPath = path.join(getStateDir(), "kokuban-outbox", WS, `${event.idempotencyKey}.committed`);
    expect(fs.existsSync(markerPath)).toBe(true);
  });

  // Payload immutability (independent review): a second prepare() for the
  // SAME idempotency key must never overwrite the first-ever payload, even
  // with different content. prepareOutboxEvent() must return that FIRST
  // payload too, not the freshly-built one.
  it("payload immutability -- re-preparing the same idempotency key does not overwrite the first payload, and returns the original", () => {
    isolateStateDir();
    const first = sampleEvent({ summary: "first attempt" });
    prepareOutboxEvent(first);
    const second = sampleEvent({ summary: "DIFFERENT second attempt", occurredAt: "2099-01-01T00:00:00.000Z" });
    const returned = prepareOutboxEvent(second); // same idempotencyKey -- must be a no-op

    expect(returned.summary).toBe("first attempt");
    const stored = readOutboxEvent(WS, first.idempotencyKey);
    expect(stored?.event.summary).toBe("first attempt");
    expect(stored?.event.occurredAt).toBe("2026-09-03T00:00:00.000Z");
  });

  // BLOCKER 5 (independent review): a corrupt/tampered payload claiming a
  // DIFFERENT workspaceId than the directory it was found in must never be
  // trusted -- filesystem operations always use the caller's own known
  // workspaceId, never content read from disk.
  it("BLOCKER 5 -- workspace confinement: an entry whose own payload claims a different workspaceId is ignored, not acted on", () => {
    isolateStateDir();
    const key = computeIdempotencyKey(CONFIG.projectKey, "t1", 0, "PLAN");
    const tamperedEvent = sampleEvent({ idempotencyKey: key, workspaceId: "SOME_OTHER_WORKSPACE" });
    // Written directly into WS's own directory, but claiming to belong to a
    // different workspace -- simulates a corrupted/tampered payload.
    const dir = path.join(getStateDir(), "kokuban-outbox", WS);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify(tamperedEvent));

    expect(readOutboxEvent(WS, key)).toBeNull(); // confinement check fails -- treated as absent
    expect(listOutboxEntries(WS)).toEqual([]); // never surfaced for draining either
  });

  // BLOCKER 4 (independent review): a genuine local write-ahead failure
  // must propagate, not be swallowed -- see prepareOutboxEvent's doc
  // comment for why (a caller that proceeded to writeSession() anyway would
  // commit state with zero local durability record).
  it("BLOCKER 4 -- prepareOutboxEvent propagates a genuine local write failure instead of swallowing it", () => {
    isolateStateDir();
    const blockerFile = path.join(getStateDir(), "not-a-directory-blocker");
    fs.writeFileSync(blockerFile, "x");
    // Point the whole state dir through a plain file -- every write under
    // it genuinely fails with ENOTDIR, not just a permissions quirk.
    process.env.C2C_STATE_DIR = path.join(blockerFile, "nested");

    expect(() => prepareOutboxEvent(sampleEvent())).toThrow();
  });

  // BLOCKER 4/5 (independent review, THIRD then FOURTH round): a corrupt
  // existing payload for the same idempotency key used to throw
  // unconditionally, permanently blocking that transition from ever being
  // retried again. Fourth round: distinguish "never confirmed committed"
  // (safe to quarantine the corrupt orphan and retry once) from "already
  // committed" (the original event can't be recovered -- still throws).
  it("round 4 -- a corrupt existing payload with NO commit marker is quarantined and the transition is retried successfully", () => {
    isolateStateDir();
    const key = computeIdempotencyKey(CONFIG.projectKey, "t1", 0, "PLAN");
    const dir = path.join(getStateDir(), "kokuban-outbox", WS);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${key}.json`), "{ this is not valid JSON");

    const result = prepareOutboxEvent(sampleEvent({ idempotencyKey: key }));
    expect(result.idempotencyKey).toBe(key);
    const stored = readOutboxEvent(WS, key);
    expect(stored?.status).toBe("prepared");
    expect(stored?.event).toEqual(result);

    // And the same, through the higher-level transition-prepare entry point.
    isolateStateDir();
    const dir2 = path.join(getStateDir(), "kokuban-outbox", WS);
    fs.mkdirSync(dir2, { recursive: true });
    fs.writeFileSync(path.join(dir2, `${key}.json`), "{ this is not valid JSON");
    const event = prepareKokubanTransition({ workspaceId: WS, config: CONFIG, state: "PLAN", taskId: "t1", iteration: 0 });
    expect(event).not.toBeNull();
    expect(readOutboxEvent(WS, key)?.status).toBe("prepared");
  });

  it("round 4 -- a corrupt existing payload WITH a commit marker throws (the original event can no longer be recovered)", () => {
    isolateStateDir();
    const key = computeIdempotencyKey(CONFIG.projectKey, "t1", 0, "PLAN");
    const dir = path.join(getStateDir(), "kokuban-outbox", WS);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${key}.json`), "{ this is not valid JSON");
    fs.writeFileSync(path.join(dir, `${key}.committed`), "");

    expect(() => prepareOutboxEvent(sampleEvent({ idempotencyKey: key }))).toThrow(/committed/);
    // The marker itself must be left alone -- an operator inspecting this
    // workspace's outbox should still be able to tell the transition did
    // commit, even though its Activity Event body is unrecoverably lost.
    expect(fs.existsSync(path.join(dir, `${key}.committed`))).toBe(true);
  });

  // Independent review, fourth round: both the lock file and the outbox
  // payload are now published via write-temp-then-link, so the real
  // filename can never be observed half-written. A crash between the two
  // steps leaves only a harmless orphaned temp file -- simulated here
  // directly, since actually killing this process mid-syscall isn't
  // feasible from a test.
  it("round 4 -- an orphaned temp file left by a simulated crash during atomic payload creation does not block a fresh prepare", () => {
    isolateStateDir();
    const dir = path.join(getStateDir(), "kokuban-outbox", WS);
    fs.mkdirSync(dir, { recursive: true });
    // Simulates dying after the temp file was written but before the
    // publish (link) step -- the real payload filename was never created.
    fs.writeFileSync(path.join(dir, `.tmp-orphan-simulated`), JSON.stringify(sampleEvent()));

    const event = sampleEvent();
    expect(prepareOutboxEvent(event)).toEqual(event);
    expect(readOutboxEvent(WS, event.idempotencyKey)?.status).toBe("prepared");
    // The orphan is ignored by every listing (filtered by suffix), not
    // mistaken for a real entry.
    expect(listOutboxEntries(WS)).toHaveLength(1);
  });

  it("round 4 -- an orphaned temp file left by a simulated crash during atomic lock creation does not block a fresh lock acquire", async () => {
    isolateStateDir();
    const dir = path.join(getStateDir(), "kokuban-outbox", WS);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `.tmp-lock-orphan-simulated`), JSON.stringify({ pid: process.pid }));

    const handle = await acquireKokubanLock(WS);
    expect(handle.held).toBe(true);
    releaseKokubanLock(WS, handle);
  });
});

// Independent review, fourth round: filesystem readdir order carries no
// transition-order information (filenames are hashed idempotency keys), and
// a naive "keep trying newer events after an older one's delivery fails"
// loop could let a newer event reach Kokuban before an older, still-
// unconfirmed one -- inverting event order at the remote log.
describe("round 4 -- durable ordering and in-order delivery", () => {
  it("listOutboxEntries sorts by each event's own sequence number, not filesystem order", () => {
    isolateStateDir();
    const first = prepareKokubanTransition({ workspaceId: WS, config: CONFIG, state: "PLAN", taskId: "t1", iteration: 0 });
    const second = prepareKokubanTransition({ workspaceId: WS, config: CONFIG, state: "EXECUTED", taskId: "t1", iteration: 0 });
    const third = prepareKokubanTransition({ workspaceId: WS, config: CONFIG, state: "DONE", taskId: "t1", iteration: 0 });
    expect(first!.sequence).toBeLessThan(second!.sequence);
    expect(second!.sequence).toBeLessThan(third!.sequence);

    const entries = listOutboxEntries(WS);
    expect(entries.map((e) => e.event.idempotencyKey)).toEqual([
      first!.idempotencyKey,
      second!.idempotencyKey,
      third!.idempotencyKey,
    ]);
  });

  it("sendKokubanEventsInOrder stops at the first failed send and never attempts a later (newer) event ahead of it", async () => {
    isolateStateDir();
    process.env.KOKUBAN_WRITE_TOKEN = "t";
    const older = prepareKokubanTransition({ workspaceId: WS, config: CONFIG, state: "PLAN", taskId: "t1", iteration: 0 });
    const newer = prepareKokubanTransition({ workspaceId: WS, config: CONFIG, state: "EXECUTED", taskId: "t1", iteration: 0 });
    commitOutboxEvent(WS, older!.idempotencyKey);
    commitOutboxEvent(WS, newer!.idempotencyKey);

    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "down" }), { status: 503 }));
    vi.stubGlobal("fetch", fetchSpy);

    const { sentCount } = await sendKokubanEventsInOrder(WS, [older!, newer!]);
    expect(sentCount).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // never attempted the newer event
    expect(readOutboxEvent(WS, older!.idempotencyKey)).not.toBeNull(); // left in place, not skipped past
    expect(readOutboxEvent(WS, newer!.idempotencyKey)).not.toBeNull();
  });

  it("sendKokubanEventsInOrder delivers everything in order when all sends succeed", async () => {
    isolateStateDir();
    process.env.KOKUBAN_WRITE_TOKEN = "t";
    const older = prepareKokubanTransition({ workspaceId: WS, config: CONFIG, state: "PLAN", taskId: "t1", iteration: 0 });
    const newer = prepareKokubanTransition({ workspaceId: WS, config: CONFIG, state: "EXECUTED", taskId: "t1", iteration: 0 });
    commitOutboxEvent(WS, older!.idempotencyKey);
    commitOutboxEvent(WS, newer!.idempotencyKey);

    const bodies: string[] = [];
    const fetchSpy = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      bodies.push(init.body as string);
      return successResponse();
    });
    vi.stubGlobal("fetch", fetchSpy);

    const { sentCount } = await sendKokubanEventsInOrder(WS, [older!, newer!]);
    expect(sentCount).toBe(2);
    expect(bodies).toEqual([older!.requestBody, newer!.requestBody]); // delivered in that exact order
    expect(readOutboxEvent(WS, older!.idempotencyKey)).toBeNull();
    expect(readOutboxEvent(WS, newer!.idempotencyKey)).toBeNull();
  });
});

describe("acquireKokubanLock / releaseKokubanLock / runUnderKokubanLock (BLOCKER 3)", () => {
  it("a second acquire is blocked while the first holder still holds it, and succeeds once released", async () => {
    isolateStateDir();
    const first = await acquireKokubanLock(WS);
    expect(first.held).toBe(true);

    // A concurrent acquire from the "same process" (simulated) must not
    // succeed while the first lock is still held.
    const secondPromise = acquireKokubanLock(WS);
    let secondResolved = false;
    void secondPromise.then(() => (secondResolved = true));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(secondResolved).toBe(false); // still waiting/contested

    releaseKokubanLock(WS, first);
    const second = await secondPromise;
    expect(second.held).toBe(true);
    releaseKokubanLock(WS, second);
  });

  it("breaks a stale lock left by a confirmed-dead pid immediately, without waiting out the full timeout", async () => {
    isolateStateDir();
    const lockPath = path.join(getStateDir(), "kokuban-outbox", WS, ".lock");
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    // A pid that is essentially guaranteed not to exist.
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999_999_999, acquiredAt: new Date().toISOString() }));

    const start = Date.now();
    const handle = await acquireKokubanLock(WS);
    expect(handle.held).toBe(true);
    expect(Date.now() - start).toBeLessThan(1_000); // broke the stale lock quickly, did not wait out the 3s timeout
    releaseKokubanLock(WS, handle);
  });

  it("does NOT break a lock held by a genuinely live process, and the primitive fails open (held:false) after the timeout", async () => {
    isolateStateDir();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
    child.unref();
    try {
      if (!child.pid) throw new Error("failed to spawn helper process");
      const lockPath = path.join(getStateDir(), "kokuban-outbox", WS, ".lock");
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(lockPath, JSON.stringify({ pid: child.pid, acquiredAt: new Date().toISOString() }));

      const start = Date.now();
      const handle = await acquireKokubanLock(WS);
      const elapsed = Date.now() - start;
      expect(handle.held).toBe(false); // the low-level primitive itself still just reports this
      expect(elapsed).toBeGreaterThanOrEqual(2_900); // did wait out roughly the full timeout, not give up instantly
      expect(elapsed).toBeLessThan(6_000); // but bounded, not indefinite
    } finally {
      if (child.pid) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
  }, 10_000);

  // BLOCKER 3 (independent review, THIRD round): unlike the raw primitive,
  // runUnderKokubanLock() -- the entry point production code actually uses
  // -- must be fail-CLOSED: it must never run its callback unlocked.
  it("BLOCKER 3 (round 3) -- runUnderKokubanLock throws KokubanLockUnavailableError instead of running its callback unlocked, and always releases what it did acquire", async () => {
    isolateStateDir();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
    child.unref();
    try {
      if (!child.pid) throw new Error("failed to spawn helper process");
      const lockPath = path.join(getStateDir(), "kokuban-outbox", WS, ".lock");
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(lockPath, JSON.stringify({ pid: child.pid, acquiredAt: new Date().toISOString() }));

      const fn = vi.fn();
      await expect(runUnderKokubanLock(WS, fn)).rejects.toBeInstanceOf(KokubanLockUnavailableError);
      expect(fn).not.toHaveBeenCalled(); // never ran unlocked
    } finally {
      if (child.pid) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
  }, 10_000);

  it("runUnderKokubanLock releases the lock even when its callback throws", async () => {
    isolateStateDir();
    await expect(
      runUnderKokubanLock(WS, () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    // The lock must be free again -- a fresh acquire succeeds immediately.
    const handle = await acquireKokubanLock(WS);
    expect(handle.held).toBe(true);
    releaseKokubanLock(WS, handle);
  });
});

describe("prepareKokubanTransition gating (mirrors reportKokubanTransition's own rules)", () => {
  it("returns null and persists nothing for a state that isn't a C2C wire state", () => {
    isolateStateDir();
    const event = prepareKokubanTransition({
      workspaceId: WS,
      config: CONFIG,
      state: "EXECUTED_SENT",
      taskId: "t1",
      iteration: 0,
    });
    expect(event).toBeNull();
    expect(listOutboxEntries(WS)).toEqual([]);
  });

  it("returns null and persists nothing when taskId/iteration are missing", () => {
    isolateStateDir();
    expect(prepareKokubanTransition({ workspaceId: WS, config: CONFIG, state: "PLAN", taskId: undefined, iteration: 0 })).toBeNull();
    expect(prepareKokubanTransition({ workspaceId: WS, config: CONFIG, state: "PLAN", taskId: "t1", iteration: undefined })).toBeNull();
    expect(listOutboxEntries(WS)).toEqual([]);
  });
});

// The crash scenarios independent review specifically required:
//   1. crash BEFORE writeSession -> event must never be sent.
//   2. crash AFTER writeSession, BEFORE the commit flip -> event IS
//      confirmed via reconciliation and sent on the next drain.
//   3. crash/failure AFTER commit (send itself failed) -> resent later with
//      a TRUE byte-identical raw request body, including occurredAt.
// (Independent review, third round: the grace-period heuristic that used to
// gate "prepared" reconciliation is gone -- runUnderKokubanLock() now makes
// reconcile-then-mutate one genuinely atomic local critical section, so
// there is no longer a window in which a "prepared" entry found during
// reconciliation could belong to a still-in-flight concurrent writer.)
describe("crash-safety: write-ahead + reconciliation", () => {
  it("scenario 1 -- prepared but writeSession never ran: discarded immediately, never sent", async () => {
    isolateStateDir();
    process.env.KOKUBAN_WRITE_TOKEN = "t";
    const fetchSpy = vi.fn().mockResolvedValue(successResponse());
    vi.stubGlobal("fetch", fetchSpy);

    const event = prepareKokubanTransition({ workspaceId: WS, config: CONFIG, state: "PLAN", taskId: "t1", iteration: 0 });
    expect(event).not.toBeNull();
    // Deliberately no writeSession() call -- simulates a crash right here.

    const result = await drainKokubanOutbox(WS);
    expect(result).toEqual({ sent: 0, discarded: 1 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(readOutboxEvent(WS, event!.idempotencyKey)).toBeNull();
  });

  it("scenario 2 -- writeSession committed but the process died before the commit flip: confirmed and sent on a later drain", async () => {
    isolateStateDir();
    process.env.KOKUBAN_WRITE_TOKEN = "t";
    const fetchSpy = vi.fn().mockResolvedValue(successResponse());
    vi.stubGlobal("fetch", fetchSpy);

    const event = prepareKokubanTransition({ workspaceId: WS, config: CONFIG, state: "PLAN", taskId: "t1", iteration: 0 });
    expect(event).not.toBeNull();
    // The transition DID commit -- session state matches the prepared event.
    writeSession(WS, { taskId: "t1", iteration: 0, lastState: "PLAN", savedAt: new Date().toISOString() });
    // No commitOutboxEvent() call -- simulates dying right after
    // writeSession() returned, before the durable commit flip.
    expect(readOutboxEvent(WS, event!.idempotencyKey)?.status).toBe("prepared");

    const result = await drainKokubanOutbox(WS);
    expect(result).toEqual({ sent: 1, discarded: 0 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(readOutboxEvent(WS, event!.idempotencyKey)).toBeNull(); // sent -> discarded
  });

  it("scenario 2b -- session state does NOT match the prepared transition: never committed, discarded, never sent", async () => {
    isolateStateDir();
    process.env.KOKUBAN_WRITE_TOKEN = "t";
    const fetchSpy = vi.fn().mockResolvedValue(successResponse());
    vi.stubGlobal("fetch", fetchSpy);

    const event = prepareKokubanTransition({ workspaceId: WS, config: CONFIG, state: "PLAN", taskId: "t1", iteration: 0 });
    // Session reflects a DIFFERENT (earlier) transition -- writeSession for
    // THIS prepared event never actually ran.
    writeSession(WS, { taskId: "t1", iteration: 0, lastState: "INIT", savedAt: new Date().toISOString() });

    const result = await drainKokubanOutbox(WS);
    expect(result).toEqual({ sent: 0, discarded: 1 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(readOutboxEvent(WS, event!.idempotencyKey)).toBeNull();
  });

  it("scenario 3 -- committed but the send itself failed: retried later with a TRUE byte-identical raw request body (including occurredAt)", async () => {
    isolateStateDir();
    process.env.KOKUBAN_WRITE_TOKEN = "t";

    const failingFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "down" }), { status: 503 }));
    vi.stubGlobal("fetch", failingFetch);

    const event = prepareKokubanTransition({ workspaceId: WS, config: CONFIG, state: "EXECUTED", taskId: "t1", iteration: 2 });
    writeSession(WS, { taskId: "t1", iteration: 2, lastState: "EXECUTED", savedAt: new Date().toISOString() });
    expect(commitOutboxEvent(WS, event!.idempotencyKey)).toBe(true);
    const firstAttempt = await sendAndDiscardKokubanEvent(WS, event!);
    expect(firstAttempt.ok).toBe(false);
    expect(readOutboxEvent(WS, event!.idempotencyKey)?.status).toBe("committed"); // stays committed, not discarded

    const firstRawBody = (failingFetch.mock.calls[0]![1] as RequestInit).body as string;

    // Simulate session state moving on to a LATER transition before the
    // retry -- must NOT affect resending this already-committed event, and
    // must NOT trigger a fresh reconciliation check against it.
    writeSession(WS, { taskId: "t1", iteration: 3, lastState: "DONE", savedAt: new Date().toISOString() });

    vi.unstubAllGlobals();
    const succeedingFetch = vi.fn().mockResolvedValue(successResponse());
    vi.stubGlobal("fetch", succeedingFetch);

    const result = await drainKokubanOutbox(WS);
    expect(result).toEqual({ sent: 1, discarded: 0 });
    expect(readOutboxEvent(WS, event!.idempotencyKey)).toBeNull();

    const retryRawBody = (succeedingFetch.mock.calls[0]![1] as RequestInit).body as string;
    expect(retryRawBody).toBe(firstRawBody); // TRUE raw-string byte equality, not just parsed-object equality
    expect(retryRawBody).toBe(event!.requestBody); // and both equal the one canonical stored body
  });

  it("does not resend or touch a normal committed-and-already-sent event again", async () => {
    isolateStateDir();
    process.env.KOKUBAN_WRITE_TOKEN = "t";
    const fetchSpy = vi.fn().mockResolvedValue(successResponse());
    vi.stubGlobal("fetch", fetchSpy);

    const event = prepareKokubanTransition({ workspaceId: WS, config: CONFIG, state: "DONE", taskId: "t1", iteration: 5 });
    writeSession(WS, { taskId: "t1", iteration: 5, lastState: "DONE", savedAt: new Date().toISOString() });
    commitOutboxEvent(WS, event!.idempotencyKey);
    const result = await sendAndDiscardKokubanEvent(WS, event!);
    expect(result.ok).toBe(true);
    expect(readOutboxEvent(WS, event!.idempotencyKey)).toBeNull();

    const drainResult = await drainKokubanOutbox(WS);
    expect(drainResult).toEqual({ sent: 0, discarded: 0 });
    expect(fetchSpy).toHaveBeenCalledTimes(1); // not called again
  });

  it("drain on an empty outbox is a fast no-op", async () => {
    isolateStateDir();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await drainKokubanOutbox("brand-new-ws");
    expect(result).toEqual({ sent: 0, discarded: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// BLOCKER 3 (independent review): true concurrent processes racing on the
// SAME workspace must never let one discard the other's still-legitimate,
// in-flight or already-committed event.
describe("BLOCKER 3 -- concurrent mutation safety", () => {
  it("Process B's reconciliation cannot discard Process A's own committed-but-unsent event even mid-flight", async () => {
    isolateStateDir();
    process.env.KOKUBAN_WRITE_TOKEN = "t";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "down" }), { status: 503 })));

    // Process A: prepares, commits (writeSession succeeded), but delivery
    // fails -- exactly the normal "committed, awaiting retry" state.
    const eventA = prepareKokubanTransition({ workspaceId: WS, config: CONFIG, state: "PLAN", taskId: "task-a", iteration: 0 });
    writeSession(WS, { taskId: "task-a", iteration: 0, lastState: "PLAN", savedAt: new Date().toISOString() });
    commitOutboxEvent(WS, eventA!.idempotencyKey);
    await sendAndDiscardKokubanEvent(WS, eventA!); // fails, stays committed

    // Process B: a DIFFERENT, unrelated session-set for the same workspace,
    // running its own reconciliation. Session state now reflects B's own
    // transition, nothing to do with A's.
    writeSession(WS, { taskId: "task-b", iteration: 0, lastState: "INIT", savedAt: new Date().toISOString() });
    const lockB = await acquireKokubanLock(WS);
    const { toSend, discarded } = reconcileKokubanOutboxLocally(WS);
    releaseKokubanLock(WS, lockB);

    // A's committed event must be untouched -- still present, still meant
    // to be sent, never discarded just because B's own session state
    // doesn't match it (committed entries skip reconciliation entirely).
    expect(discarded).toBe(0);
    expect(toSend.map((e) => e.idempotencyKey)).toContain(eventA!.idempotencyKey);
    expect(readOutboxEvent(WS, eventA!.idempotencyKey)?.status).toBe("committed");
  });
});

// Real CLI-level regressions (independent review, third round: "structural
// inspection alone did not catch the grace-period loss path -- add the real
// session clear regression before DONE").
describe("real CLI: session set / session clear (third round required regressions)", () => {
  it("BLOCKER 2 -- a prepared-but-uncommitted event survives a real `session clear` invocation and gets promoted+sent", async () => {
    isolateStateDir();
    const root = makeTmpDir("kokuban-clear-crash");
    try {
      write(root, "a.txt", "a");
      write(root, ".c2c.json", JSON.stringify({ kokuban: { projectKey: "proj" } }));
      const workspace = new Workspace(root);

      process.env.KOKUBAN_WRITE_TOKEN = "t";
      const fetchSpy = vi.fn().mockResolvedValue(successResponse());
      vi.stubGlobal("fetch", fetchSpy);

      // Simulate the exact crash point: prepare + writeSession succeeded,
      // but the process died before the commit marker was created.
      const event = prepareKokubanTransition({
        workspaceId: workspace.id,
        config: { projectKey: "proj" },
        state: "PLAN",
        taskId: "t1",
        iteration: 0,
      });
      expect(event).not.toBeNull();
      writeSession(workspace.id, { taskId: "t1", iteration: 0, lastState: "PLAN", savedAt: new Date().toISOString() });
      // Deliberately no commitOutboxEvent() call.
      expect(readOutboxEvent(workspace.id, event!.idempotencyKey)?.status).toBe("prepared");

      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        await runCli(["node", "c2c", "session", "clear", "-w", root]);
      } finally {
        writeSpy.mockRestore();
        process.exitCode = 0;
      }

      // The real `session clear` command must have reconciled the entry
      // (confirmed against the session state it read BEFORE clearing) and
      // sent it -- never silently discarded it just because
      // clearChatPointer() then wiped taskId/iteration/lastState.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(readOutboxEvent(workspace.id, event!.idempotencyKey)).toBeNull();
    } finally {
      cleanup(root);
    }
  });

  it("BLOCKER 3 -- a real `session set` aborts entirely (fail-closed) when another process holds this workspace's lock, touching neither session nor outbox", async () => {
    isolateStateDir();
    const root = makeTmpDir("kokuban-lock-timeout");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
    child.unref();
    try {
      write(root, "a.txt", "a");
      write(root, ".c2c.json", JSON.stringify({ kokuban: { projectKey: "proj" } }));
      const workspace = new Workspace(root);

      writeSession(workspace.id, { taskId: "before", iteration: 0, lastState: "INIT", savedAt: new Date().toISOString() });
      const before = readSession(workspace.id);

      if (!child.pid) throw new Error("failed to spawn helper process");
      const lockPath = path.join(getStateDir(), "kokuban-outbox", workspace.id, ".lock");
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(lockPath, JSON.stringify({ pid: child.pid, acquiredAt: new Date().toISOString() }));

      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        await runCli(["node", "c2c", "session", "set", "-w", root, "--task", "t1", "--iteration", "0", "--state", "PLAN"]);
        expect(process.exitCode).toBe(1); // runCli caught the lock-unavailable error and reported failure
      } finally {
        writeSpy.mockRestore();
        process.exitCode = 0;
      }

      expect(readSession(workspace.id)).toEqual(before); // session state completely untouched
      expect(listOutboxEntries(workspace.id)).toEqual([]); // no new outbox payload written either
    } finally {
      if (child.pid) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      cleanup(root);
    }
  }, 10_000);
});

// Independent review, fifth round: the post-send discard is a LOCAL
// filesystem mutation touching the same entry a concurrent process's own
// reconciliation pass might be reading inside ITS lock -- unlike the
// network send itself (correctly unlocked), the discard must be
// lock-protected too, or one process's discard can race another's
// reconcile/commit over the same entry.
describe("round 5 -- ACK/discard is lock-protected against a concurrent reconciliation pass", () => {
  it("a successful send still discards the entry (normal, uncontended case)", async () => {
    isolateStateDir();
    process.env.KOKUBAN_WRITE_TOKEN = "t";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(successResponse()));

    const event = prepareKokubanTransition({ workspaceId: WS, config: CONFIG, state: "PLAN", taskId: "t1", iteration: 0 });
    commitOutboxEvent(WS, event!.idempotencyKey);

    const result = await sendAndDiscardKokubanEvent(WS, event!);
    expect(result.ok).toBe(true);
    expect(readOutboxEvent(WS, event!.idempotencyKey)).toBeNull();
  });

  it("if the workspace lock can't be re-acquired for the ACK step, the entry is left in place for a duplicate-safe retry rather than discarded unprotected", async () => {
    isolateStateDir();
    process.env.KOKUBAN_WRITE_TOKEN = "t";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(successResponse()));

    const event = prepareKokubanTransition({ workspaceId: WS, config: CONFIG, state: "PLAN", taskId: "t1", iteration: 0 });
    commitOutboxEvent(WS, event!.idempotencyKey);

    // A genuinely live process holds the workspace lock for the entire
    // send -- simulates a concurrent process's own reconciliation pass
    // being in progress right as this send's delivery succeeds.
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
    child.unref();
    try {
      if (!child.pid) throw new Error("failed to spawn helper process");
      const lockPath = path.join(getStateDir(), "kokuban-outbox", WS, ".lock");
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(lockPath, JSON.stringify({ pid: child.pid, acquiredAt: new Date().toISOString() }));

      const result = await sendAndDiscardKokubanEvent(WS, event!);
      expect(result.ok).toBe(true); // the delivery itself still succeeded and is reported as such
      // But the local ACK couldn't be protected -- the entry survives,
      // exactly like a genuinely lost ACK would, so the next drain retries
      // it (Kokuban's own idempotency makes that retry harmless).
      expect(readOutboxEvent(WS, event!.idempotencyKey)).not.toBeNull();
    } finally {
      if (child.pid) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
  }, 10_000);

  it("does not discard a DIFFERENT (newer) entry that came to reuse the same idempotency key after the original was already resolved", async () => {
    isolateStateDir();
    process.env.KOKUBAN_WRITE_TOKEN = "t";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(successResponse()));

    const key = computeIdempotencyKey(CONFIG.projectKey, "t1", 0, "PLAN");
    const staleEvent = prepareOutboxEvent(sampleEvent({ idempotencyKey: key }));
    discardOutboxEvent(WS, key); // fully resolved and removed already

    // A genuinely new entry for the SAME key (e.g. via the corrupt-orphan
    // quarantine-and-retry path) gets a freshly assigned, different
    // sequence number.
    const freshEvent = prepareOutboxEvent(sampleEvent({ idempotencyKey: key, summary: "a completely different retry" }));
    expect(freshEvent.sequence).not.toBe(staleEvent.sequence);
    commitOutboxEvent(WS, key);

    // Calling sendAndDiscardKokubanEvent with the STALE event object (as
    // if a slow/delayed send from an earlier attempt just now completed)
    // must not discard the fresh entry underneath it.
    await sendAndDiscardKokubanEvent(WS, staleEvent);
    expect(readOutboxEvent(WS, key)?.event).toEqual(freshEvent);
  });
});

// Kokuban ITERATION 4 (independent review, 2026-09-03): default-ON
// participation, wired through the real `session set`/`session clear` CLI
// actions, not just the resolver in isolation (see tests/kokuban-config.test.ts
// for the resolver's own unit coverage).
describe("ITERATION 4 -- default-ON participation wired through the real CLI", () => {
  it("a real `session set` with NO kokuban block at all still participates, using the mechanically derived projectKey", async () => {
    isolateStateDir();
    const root = makeTmpDir("kokuban-default-on-cli");
    try {
      write(root, "a.txt", "a");
      // No .c2c.json at all -- derivation comes from the root directory's
      // own basename (a display `name` in .c2c.json would NOT count; see
      // tests/kokuban-config.test.ts's "changing ONLY .c2c.json's name"
      // regression).
      const expectedProjectKey = sanitizeProjectKey(path.basename(new Workspace(root).root));

      process.env.KOKUBAN_WRITE_TOKEN = "t";
      const fetchSpy = vi.fn().mockResolvedValue(successResponse());
      vi.stubGlobal("fetch", fetchSpy);

      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        await runCli(["node", "c2c", "session", "set", "-w", root, "--task", "t1", "--iteration", "0", "--state", "PLAN"]);
      } finally {
        writeSpy.mockRestore();
        process.exitCode = 0;
      }

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
      expect(body.projectKey).toBe(expectedProjectKey);
    } finally {
      cleanup(root);
    }
  });

  it("a real `session set` with kokuban.enabled:false never touches the outbox, the lock, or the network", async () => {
    isolateStateDir();
    const root = makeTmpDir("kokuban-opt-out-cli");
    try {
      write(root, "a.txt", "a");
      write(root, ".c2c.json", JSON.stringify({ kokuban: { enabled: false } }));
      const workspace = new Workspace(root);

      process.env.KOKUBAN_WRITE_TOKEN = "t";
      const fetchSpy = vi.fn().mockResolvedValue(successResponse());
      vi.stubGlobal("fetch", fetchSpy);

      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        await runCli(["node", "c2c", "session", "set", "-w", root, "--task", "t1", "--iteration", "0", "--state", "PLAN"]);
        await runCli(["node", "c2c", "session", "clear", "-w", root]);
      } finally {
        writeSpy.mockRestore();
        process.exitCode = 0;
      }

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(listOutboxEntries(workspace.id)).toEqual([]);
      expect(fs.existsSync(path.join(getStateDir(), "kokuban-outbox", workspace.id, ".lock"))).toBe(false);
    } finally {
      cleanup(root);
    }
  });
});
