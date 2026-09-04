import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { ensureBridge, stopBridge } from "../src/process/daemon.js";
import { runCli } from "../src/cli/index.js";
import { Workspace } from "../src/workspace/manager.js";
import { probeBridge, readRuntimeState, observePid, runtimeFile } from "../src/bridge/runtime.js";
import {
  acquireWorkspaceLock,
  releaseWorkspaceLock,
  readWorkspaceLock,
  workspaceLockFile,
  WorkspaceLockConflictError,
  sameLockInstance,
} from "../src/bridge/lock.js";
import { makeTmpDir, cleanup, isolateStateDir } from "./helpers.js";

/**
 * Connector Reliability Hardening -- workspace single-instance ownership
 * (independent review, 2026-09-03). Root cause of a real, live incident:
 * `ensureBridge()` decided (on the CLI side, transiently) that no healthy
 * bridge existed for a workspace that in fact already had one alive and
 * fully healthy, and spawned a second, fully independent `serve` process.
 * Both processes shared the same on-disk runtime-state pointer file with
 * no locking -- whichever last called `persistRuntime()` "won" it -- so
 * `c2c pair`/`c2c status` and the Named Tunnel could each resolve a
 * DIFFERENT live process for what the user believed was one workspace. A
 * pairing session minted on the non-canonical duplicate was invisible to
 * the one ChatGPT's tunnel actually reached: `no_active_session`, forever,
 * no matter how many fresh codes were issued.
 *
 * These tests pin the fix: `startBridge()` now acquires an exclusive,
 * workspace-scoped lock (bridge/lock.ts) as the FIRST thing it does --
 * before binding any port, before persisting any runtime state -- so a
 * second live instance for the same workspace can never fully start,
 * regardless of what triggered the attempt (a spawned daemon child, a
 * direct `c2c serve`, or a race between two callers).
 */

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lockRaceWorker = path.join(projectRoot, "tests", "fixtures", "lock-race-worker.ts");
const lockReleaseHammer = path.join(projectRoot, "tests", "fixtures", "lock-release-hammer.ts");

const tmpDirs: string[] = [];
const bridges: Bridge[] = [];
const bridgeRoots: string[] = [];

afterEach(async () => {
  while (bridges.length) {
    await bridges.pop()!.close().catch(() => undefined);
  }
  while (bridgeRoots.length) {
    const root = bridgeRoots.pop()!;
    await stopBridge(root).catch(() => undefined);
  }
  while (tmpDirs.length) cleanup(tmpDirs.pop()!);
});

function tmp(name: string): string {
  const dir = makeTmpDir(name);
  tmpDirs.push(dir);
  return dir;
}

describe("acquireWorkspaceLock / releaseWorkspaceLock -- the primitive", () => {
  it("acquires freely when nothing holds the lock, and a graceful release lets the next acquirer reclaim it immediately", () => {
    isolateStateDir();
    const workspaceId = "lock-unit-a";
    const info = { workspaceId, pid: process.pid, generation: "g1", createdAt: new Date().toISOString() };
    const result = acquireWorkspaceLock(info);
    expect(result.ok).toBe(true);
    expect(readWorkspaceLock(workspaceId)).toMatchObject({ pid: process.pid, generation: "g1" });
    releaseWorkspaceLock(info);
    // Independent review, round 4 (BLOCKER #2): release no longer deletes
    // the shared main-lock file at all -- it only records a tombstone for
    // this exact identity. The old entry is left in place (exactly like a
    // crashed holder's entry would be) until the next acquirer reclaims it
    // through the normal liveness/tombstone-gated path -- which must
    // succeed immediately, with no contention, since nothing else is
    // racing for this workspace.
    expect(readWorkspaceLock(workspaceId)).toMatchObject({ pid: process.pid, generation: "g1" });
    const next = acquireWorkspaceLock({ workspaceId, pid: process.pid, generation: "g2", createdAt: new Date().toISOString() });
    expect(next.ok).toBe(true);
    expect(readWorkspaceLock(workspaceId)).toMatchObject({ generation: "g2" });
  });

  it("refuses a second acquisition while the recorded pid is confirmed alive (never steals from a live owner)", () => {
    isolateStateDir();
    const workspaceId = "lock-unit-b";
    const first = acquireWorkspaceLock({ workspaceId, pid: process.pid, generation: "g-live", createdAt: new Date().toISOString() });
    expect(first.ok).toBe(true);

    const second = acquireWorkspaceLock({ workspaceId, pid: process.pid, generation: "g-would-be-duplicate", createdAt: new Date().toISOString() });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe("held_by_live_process");
      expect(second.holder?.generation).toBe("g-live");
    }
    // The original holder's record must be completely untouched.
    expect(readWorkspaceLock(workspaceId)?.generation).toBe("g-live");
  });

  it("reclaims a stale lock only once the recorded pid is CONFIRMED dead, never on a guess", () => {
    isolateStateDir();
    const workspaceId = "lock-unit-c";
    // A pid essentially guaranteed not to exist on this machine.
    const deadPid = 999_999;
    expect(observePid(deadPid)).toBe("missing");
    fs.writeFileSync(
      workspaceLockFile(workspaceId),
      JSON.stringify({ workspaceId, pid: deadPid, generation: "g-dead", createdAt: new Date().toISOString() })
    );
    const result = acquireWorkspaceLock({ workspaceId, pid: process.pid, generation: "g-new", createdAt: new Date().toISOString() });
    expect(result.ok).toBe(true);
    expect(readWorkspaceLock(workspaceId)?.generation).toBe("g-new");
  });

  it("release is a no-op (never touches the shared main lock) when the caller is not the current recorded holder", () => {
    isolateStateDir();
    const workspaceId = "lock-unit-d";
    acquireWorkspaceLock({ workspaceId, pid: 424242, generation: "g-other", createdAt: new Date().toISOString() });
    // Someone who never held it (same pid coincidentally, different
    // generation/createdAt -- full identity, not pid alone) tries to
    // release. Independent review, round 4: this is now true unconditionally
    // for ANY caller, matching or not -- release only ever creates a
    // tombstone unique to ITS OWN identity and never reads or writes the
    // shared main-lock path at all, so there is nothing for a mismatched
    // (or even a matching) caller to disturb here.
    releaseWorkspaceLock({ workspaceId, pid: 424242, generation: "g-mine", createdAt: new Date().toISOString() });
    expect(readWorkspaceLock(workspaceId)?.generation).toBe("g-other");
  });
});

describe("startBridge() -- real servers, ownership enforced at the source", () => {
  it("a second startBridge() for the same workspace root is refused while the first is alive, and the first keeps serving unaffected", async () => {
    isolateStateDir();
    const root = tmp("lock-ws-a");
    const first = await startBridge({ workspaceRoot: root, port: 0, persistRuntime: false });
    bridges.push(first);

    await expect(startBridge({ workspaceRoot: root, port: 0, persistRuntime: false })).rejects.toThrow(WorkspaceLockConflictError);

    // The first instance must be completely unaffected by the refused attempt.
    const health = await probeBridge(first.port);
    expect(health?.workspaceId).toBe(new Workspace(root).id);
  });

  it("after a graceful close(), a new startBridge() for the same workspace succeeds (lock released on shutdown)", async () => {
    isolateStateDir();
    const root = tmp("lock-ws-b");
    const first = await startBridge({ workspaceRoot: root, port: 0, persistRuntime: false });
    await first.close();

    const second = await startBridge({ workspaceRoot: root, port: 0, persistRuntime: false });
    bridges.push(second);
    const health = await probeBridge(second.port);
    expect(health?.workspaceId).toBe(new Workspace(root).id);
  });

  it("two startBridge() calls racing for the same workspace root: exactly one wins, the other is refused -- never both alive", async () => {
    isolateStateDir();
    const root = tmp("lock-ws-race");
    const [a, b] = await Promise.allSettled([
      startBridge({ workspaceRoot: root, port: 0, persistRuntime: false }),
      startBridge({ workspaceRoot: root, port: 0, persistRuntime: false }),
    ]);
    const fulfilled = [a, b].filter((r): r is PromiseFulfilledResult<Bridge> => r.status === "fulfilled");
    const rejected = [a, b].filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(rejected[0].reason).toBeInstanceOf(WorkspaceLockConflictError);
    bridges.push(fulfilled[0].value);
  });

  it("never touches a different workspace's lock or bridge", async () => {
    isolateStateDir();
    const rootA = tmp("lock-ws-scope-a");
    const rootB = tmp("lock-ws-scope-b");
    const bridgeA = await startBridge({ workspaceRoot: rootA, port: 0, persistRuntime: false });
    bridges.push(bridgeA);
    // A different workspace must acquire its OWN lock without interference.
    const bridgeB = await startBridge({ workspaceRoot: rootB, port: 0, persistRuntime: false });
    bridges.push(bridgeB);
    expect((await probeBridge(bridgeA.port))?.workspaceId).toBe(new Workspace(rootA).id);
    expect((await probeBridge(bridgeB.port))?.workspaceId).toBe(new Workspace(rootB).id);
  });
});

describe("ensureBridge() -- real subprocess spawns never duplicate a live bridge", () => {
  it("a stale/wrong runtime pointer never causes a duplicate live bridge: ensureBridge() either recovers the real one or fails honestly, but a second process never becomes routable", async () => {
    isolateStateDir();
    const root = tmp("lock-daemon-a");
    const workspace = new Workspace(root);

    const first = await ensureBridge(root);
    bridgeRoots.push(root);
    expect(first.spawned).toBe(true);

    // Simulate the exact live trigger: the client-side pointer used to
    // decide whether a bridge exists is wrong/missing even though the real
    // bridge is fully alive and healthy (a transient health-probe failure
    // has the same practical effect on ensureBridge()'s decision).
    const rtFile = runtimeFile(workspace.id);
    const backup = fs.readFileSync(rtFile, "utf8");
    fs.rmSync(rtFile, { force: true });

    let secondResult: { spawned: boolean; runtime: { pid: number } } | null = null;
    let secondError: unknown = null;
    try {
      secondResult = await ensureBridge(root);
    } catch (error) {
      secondError = error;
    } finally {
      // Restore so any cleanup/inspection below sees the real, live pointer.
      fs.writeFileSync(rtFile, backup);
    }

    if (secondResult) {
      // Recovered gracefully -- must be the SAME process, never a new one.
      expect(secondResult.spawned).toBe(false);
      expect(secondResult.runtime.pid).toBe(first.runtime.pid);
    } else {
      // Failed honestly instead of silently duplicating -- also acceptable,
      // and exactly what the lock guarantees at minimum.
      expect(secondError).toBeTruthy();
    }

    // Decisive, in either case: still exactly one live bridge for this
    // workspace, still the original pid, still on the original port.
    const health = await probeBridge(first.runtime.port);
    expect(health?.workspaceId).toBe(workspace.id);
    const finalRuntime = readRuntimeState(workspace.id);
    expect(finalRuntime?.pid).toBe(first.runtime.pid);
  }, 40_000);

  it("stale ownership left behind by a hard-killed (non-graceful) bridge is safely reclaimed by the next ensureBridge()", async () => {
    isolateStateDir();
    const root = tmp("lock-daemon-crash");
    const workspace = new Workspace(root);

    const first = await ensureBridge(root);
    bridgeRoots.pop(); // will manage cleanup manually below
    expect(first.spawned).toBe(true);
    expect(readWorkspaceLock(workspace.id)?.pid).toBe(first.runtime.pid);

    // Hard-kill: no graceful shutdown, no lock release -- the lock file is
    // left behind pointing at a now-dead pid, exactly like a crash.
    process.kill(first.runtime.pid, "SIGKILL");
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && observePid(first.runtime.pid) !== "missing") {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(observePid(first.runtime.pid)).toBe("missing");

    const second = await ensureBridge(root);
    bridgeRoots.push(root);
    expect(second.spawned).toBe(true);
    expect(second.runtime.pid).not.toBe(first.runtime.pid);
    expect(readWorkspaceLock(workspace.id)?.pid).toBe(second.runtime.pid);
    expect((await probeBridge(second.runtime.port))?.workspaceId).toBe(workspace.id);
  }, 40_000);

  it("an alive-but-currently-unhealthy owner is never stolen from: a conflicting startBridge() during that window still fails, not steals", async () => {
    isolateStateDir();
    const root = tmp("lock-daemon-unhealthy");
    const workspace = new Workspace(root);
    const first = await ensureBridge(root);
    bridgeRoots.push(root);

    // The owner is alive and its lock is held -- a competing direct
    // startBridge() (bypassing ensureBridge's own health-first check
    // entirely, the worst case) must still be refused deterministically.
    await expect(startBridge({ workspaceRoot: root, port: 0, persistRuntime: false })).rejects.toThrow(WorkspaceLockConflictError);
    expect(readWorkspaceLock(workspace.id)?.pid).toBe(first.runtime.pid);
  }, 40_000);

  it("concurrent pair-equivalent admin calls during a real restart never see two canonical bridges", async () => {
    isolateStateDir();
    const root = tmp("lock-daemon-restart-race");
    const workspace = new Workspace(root);
    const first = await ensureBridge(root);
    bridgeRoots.push(root);

    // Kick off the real stop+respawn (the fixed restart primitive) and, in
    // parallel, hammer ensureBridge() from "other callers" the way
    // `c2c pair`/`c2c status` would during that window.
    const restart = (async () => {
      const stopped = await stopBridge(root);
      expect(stopped).toBe(true);
      return ensureBridge(root);
    })();
    const concurrentCallers = await Promise.allSettled([ensureBridge(root), ensureBridge(root)]);
    const second = await restart;

    // A caller racing the restart may legitimately observe either the OLD
    // pid (queried before the stop took effect) or the NEW one (queried
    // after) -- that's an ordinary time-of-check snapshot, not a bug. What
    // must NEVER happen: a THIRD, spurious pid (proof a stray duplicate got
    // spawned somewhere in the middle of the race).
    const resolvedPids = new Set<number>();
    resolvedPids.add(second.runtime.pid);
    for (const r of concurrentCallers) {
      if (r.status === "fulfilled") resolvedPids.add(r.value.runtime.pid);
    }
    for (const pid of resolvedPids) {
      expect([first.runtime.pid, second.runtime.pid]).toContain(pid);
    }

    // And once everything has settled, exactly one process is actually
    // alive and routable for this workspace: the new one.
    expect(observePid(first.runtime.pid)).toBe("missing");
    expect((await probeBridge(second.runtime.port))?.workspaceId).toBe(workspace.id);
  }, 40_000);
});

describe("doctor -- a live ownership conflict is never reported green", () => {
  async function runDoctorJson(root: string): Promise<{ report: Record<string, { ok: boolean; detail?: string }> }> {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await runCli(["node", "c2c", "doctor", "-w", root, "--agent", "claude-code", "--no-fix", "--json"]);
      const printed = writeSpy.mock.calls.map((call) => String(call[0])).join("");
      return JSON.parse(printed.trim()) as { report: Record<string, { ok: boolean; detail?: string }> };
    } finally {
      writeSpy.mockRestore();
      process.exitCode = 0;
    }
  }

  it("reports ownership: ok:true for a normal, single canonical bridge", async () => {
    isolateStateDir();
    const root = tmp("lock-doctor-ok");
    await ensureBridge(root);
    bridgeRoots.push(root);

    const { report } = await runDoctorJson(root);
    expect(report.ownership).toMatchObject({ ok: true });
  }, 30_000);

  it("flags ownership: ok:false when the lock's recorded holder (alive) disagrees with the runtime pointer -- exactly the live incident's signature", async () => {
    isolateStateDir();
    const root = tmp("lock-doctor-conflict");
    const workspace = new Workspace(root);
    await ensureBridge(root);
    bridgeRoots.push(root);

    // Simulate the exact live symptom: the lock's real holder is a
    // DIFFERENT, also-alive pid than what the runtime-state pointer
    // currently says (this test process's own pid stands in for "some
    // other live bridge process" -- observePid() will correctly report it
    // as alive).
    fs.writeFileSync(
      workspaceLockFile(workspace.id),
      JSON.stringify({ workspaceId: workspace.id, pid: process.pid, generation: "conflicting-generation", createdAt: new Date().toISOString() })
    );

    const { report } = await runDoctorJson(root);
    expect(report.ownership?.ok).toBe(false);
  }, 30_000);
});

describe("stale-lock reclaim under a real concurrent race (independent review, rounds 2026-09-03 through 2026-09-04)", () => {
  /**
   * The plain `rmSync` reclaim this replaces had a real TOCTOU: two callers
   * (A, B) that both independently observe the SAME dead stale lock could
   * interleave as A-deletes-then-recreates, B-then-deletes-A's-brand-new-
   * LIVE-lock (B's decision to delete was made from its OWN earlier read,
   * before A ever acted), letting B go on to "acquire" too -- two owners
   * for one workspace, exactly the invariant this whole feature exists to
   * prevent.
   *
   * IMPORTANT lesson baked into this test's shape (found the hard way,
   * round 3 of independent review, 2026-09-04): a worker that exits
   * IMMEDIATELY after winning is not a faithful race participant. If the
   * winner has already exited by the time a loser's OS-retried filesystem
   * call (Windows' EPERM/EBUSY sharing-violation retry, see
   * `withEpermRetry` in lock.ts) finally lands, `observePid(winner's pid)`
   * correctly reports "missing" -- the winner is, by then, ACTUALLY dead --
   * and a second worker legitimately reclaiming it is correct behavior, not
   * a bug. A test whose winner exits immediately therefore cannot tell
   * "two workers both won the initial simultaneous race" (a real bug) apart
   * from "worker A won, then genuinely exited, then worker B correctly
   * reclaimed the now-truly-dead A at some later point" (not a bug at all,
   * just a second, later, legitimate race with a different outcome) --
   * both look identical as "2 of N outcomes report ok:true" from outside.
   * This was confirmed directly: instrumenting lock.ts and re-running this
   * exact scenario showed the "second winner" only ever won AFTER
   * `observePid` on the first winner's pid had already flipped to
   * "missing" (i.e. after the first winner's process had actually exited),
   * never while it was still alive.
   *
   * So every test below that needs to assert "exactly one wins, never two"
   * keeps the winner genuinely alive (via `lockRaceWorker`'s
   * `holdReleaseFile` mode) for the whole window in which losers keep
   * retrying, and only inspects "how many ever won" once that window is
   * over and the winner is released on purpose -- at which point at most
   * one process could ever have held the lock file's identity at once, and
   * that can be confirmed by direct, repeated inspection of the lock file
   * itself during the hold window, not just by counting final outcomes.
   */
  async function raceForStaleLock(
    stateDir: string,
    workspaceId: string,
    deadPid: number,
    workerIds: string[]
  ): Promise<{ outcomes: Array<Record<string, any>>; holdReleaseFile: string }> {
    expect(observePid(deadPid)).toBe("missing");
    fs.writeFileSync(
      workspaceLockFile(workspaceId),
      JSON.stringify({ workspaceId, pid: deadPid, generation: "dead-gen", createdAt: new Date().toISOString() })
    );

    const signalFile = path.join(stateDir, `${workspaceId}-start-signal`);
    const holdReleaseFile = path.join(stateDir, `${workspaceId}-hold-release`);
    const resultFiles = new Map(workerIds.map((id) => [id, path.join(stateDir, `${workspaceId}-result-${id}.json`)]));

    const spawnWorker = (resultFile: string, workerId: string) =>
      spawn(
        process.execPath,
        ["--import", "tsx/esm", lockRaceWorker, workspaceId, signalFile, resultFile, workerId, holdReleaseFile],
        { stdio: "ignore", env: process.env }
      );

    const procs = workerIds.map((id) => spawnWorker(resultFiles.get(id)!, id));
    const exits = Promise.all(procs.map((p) => new Promise<void>((resolve) => p.once("exit", () => resolve()))));

    // Let every worker reach its wait-for-signal spin loop before releasing
    // them together, so their acquireWorkspaceLock() calls fire as close to
    // simultaneously as separate OS processes can.
    await new Promise((resolve) => setTimeout(resolve, 500));
    fs.writeFileSync(signalFile, "go");

    // Wait for the initial race to actually settle -- polling, not a fixed
    // delay: the very first sample(s) right after "go" would otherwise
    // legitimately catch the one-time transition from the pre-race dead
    // placeholder to the real winner, which is two DIFFERENT identities but
    // not a double-ownership bug. A fixed sleep here was found to flake
    // under system load (the race can occasionally take longer than a
    // guessed delay to settle, and the sampling loop below would then catch
    // the tail of that same legitimate transition) -- polling for the
    // placeholder to actually be gone removes the guesswork. What must
    // never happen is the lock disagreeing with itself AFTER a real winner
    // has taken over and is being held alive, which is what the sampling
    // loop below checks.
    await vi.waitUntil(
      () => {
        const lock = readWorkspaceLock(workspaceId);
        return lock !== null && lock.pid !== deadPid && observePid(lock.pid) === "present";
      },
      { timeout: 10_000, interval: 20 }
    );

    // While the winner holds, repeatedly sample the lock file itself: at
    // every single sample, it must belong to the SAME one identity, and
    // that identity's pid must be a genuinely live process (the real
    // winner, not the original dead placeholder sitting unclaimed) -- this
    // is the direct, momentary-ownership check the reviewer asked for,
    // independent of what any worker's own result file later claims.
    const observedIdentities = new Set<string>();
    for (let i = 0; i < 8; i++) {
      const lock = readWorkspaceLock(workspaceId);
      if (lock) observedIdentities.add(`${lock.pid}:${lock.generation}:${lock.createdAt}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // Exactly one distinct identity must have occupied the lock file during
    // the whole (post-settle) hold window -- if two different real
    // processes had simultaneously believed themselves the owner, this
    // would very likely have caught at least one sample disagreeing with
    // the others (and the per-worker `attempts` log below confirms it
    // exhaustively, not just by sampling).
    expect(observedIdentities.size).toBe(1);
    const settledLock = readWorkspaceLock(workspaceId);
    expect(settledLock).not.toBeNull();
    expect(observePid(settledLock!.pid)).toBe("present");

    fs.writeFileSync(holdReleaseFile, "go");
    await exits;

    const outcomes = workerIds.map((id) => ({ id, ...JSON.parse(fs.readFileSync(resultFiles.get(id)!, "utf8")) }));
    return { outcomes, holdReleaseFile };
  }

  it("two real subprocesses racing to reclaim the SAME dead stale lock: exactly one wins, kept alive throughout, and no loser's retry ever succeeds", async () => {
    const stateDir = isolateStateDir();
    const workspaceId = "lock-race-ws";
    const { outcomes } = await raceForStaleLock(stateDir, workspaceId, 999_999, ["A", "B"]);

    for (const o of outcomes) expect(o.error).toBeUndefined();
    const winners = outcomes.filter((o) => o.result.ok);
    expect(winners.length).toBe(1);
    for (const o of outcomes) {
      if (!o.result.ok) {
        expect(Array.isArray(o.attempts)).toBe(true);
        expect(o.attempts.every((a: LockAcquireResult) => !a.ok)).toBe(true);
      }
    }

    const winner = winners[0];
    const finalLock = readWorkspaceLock(workspaceId);
    expect(finalLock?.pid).toBe(winner.pid);
    expect(finalLock?.generation).toBe(`worker-${winner.workerId}`);
  }, 30_000);

  /**
   * Test C (independent review, FINAL_REVIEW_3, 2026-09-04): a 3-way
   * version with the winner explicitly kept alive throughout every loser's
   * repeated retries -- the earlier version of this test (which let the
   * winner exit immediately) was flagged as insufficient for exactly the
   * reason explained in this describe block's own doc comment above.
   */
  it("three real subprocesses racing to reclaim the SAME dead stale lock: exactly one wins, kept alive throughout, ownership never lost even momentarily", async () => {
    const stateDir = isolateStateDir();
    const workspaceId = "lock-race-3way-ws";
    const { outcomes } = await raceForStaleLock(stateDir, workspaceId, 999_998, ["A", "B", "C"]);

    for (const o of outcomes) expect(o.error).toBeUndefined();
    const winners = outcomes.filter((o) => o.result.ok);
    expect(winners.length).toBe(1);
    for (const o of outcomes) {
      if (!o.result.ok) {
        expect(Array.isArray(o.attempts)).toBe(true);
        expect(o.attempts.length).toBeGreaterThan(0);
        expect(o.attempts.every((a: LockAcquireResult) => !a.ok)).toBe(true);
      }
    }

    const winner = winners[0];
    const finalLock = readWorkspaceLock(workspaceId);
    expect(finalLock?.pid).toBe(winner.pid);
    expect(finalLock?.generation).toBe(`worker-${winner.workerId}`);
  }, 30_000);

  /**
   * Test A (FINAL_REVIEW_3): reclaim must be gated purely by a fresh
   * liveness check, never by elapsed time. A live holder kept alive well
   * past the OLD (now-removed) 5-second reclaim-mutex TTL must never be
   * reclaimable -- there is no TTL left in the design at all, but this
   * pins that a long pause can never, by itself, look like abandonment.
   */
  it("a live holder survives well past the old TTL window: a pure elapsed-time reclaim attempt still fails", async () => {
    const stateDir = isolateStateDir();
    const workspaceId = "lock-ttl-survive-ws";
    const signalFile = path.join(stateDir, "signal");
    const holdReleaseFile = path.join(stateDir, "hold-release");
    const resultFile = path.join(stateDir, "result.json");

    const holder = spawn(
      process.execPath,
      ["--import", "tsx/esm", lockRaceWorker, workspaceId, signalFile, resultFile, "holder", holdReleaseFile],
      { stdio: "ignore", env: process.env }
    );
    const holderExit = new Promise<void>((resolve) => holder.once("exit", () => resolve()));

    fs.writeFileSync(signalFile, "go");
    // Wait for the holder to actually acquire before proceeding.
    await vi.waitUntil(() => fs.existsSync(resultFile), { timeout: 5_000, interval: 20 });
    const holderResult = JSON.parse(fs.readFileSync(resultFile, "utf8"));
    expect(holderResult.result.ok).toBe(true);

    // Old reclaim-mutex TTL was 5000ms -- wait comfortably past it while the
    // holder is deliberately kept alive (still parked in its hold loop).
    await new Promise((resolve) => setTimeout(resolve, 5_500));
    expect(observePid(holderResult.pid)).toBe("present");

    const attempt = acquireWorkspaceLock({ workspaceId, pid: process.pid, generation: "would-be-thief", createdAt: new Date().toISOString() });
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) {
      expect(attempt.reason).toBe("held_by_live_process");
      expect(attempt.holder?.pid).toBe(holderResult.pid);
      expect(attempt.holder?.generation).toBe("worker-holder");
    }

    fs.writeFileSync(holdReleaseFile, "go");
    await holderExit;
  }, 20_000);

  /**
   * Test B (FINAL_REVIEW_3): an old owner's release must never delete a new
   * owner's fresh claim. In this design, a caller can only ever legitimately
   * reclaim a workspace once the prior holder's pid is CONFIRMED missing --
   * so the only way an "old owner" can still be around to attempt a release
   * after being superseded is if it acted on a STALE, previously-captured
   * identity object (e.g. a leftover reference from before a crash/restart)
   * rather than re-reading current state. This pins releaseWorkspaceLock's
   * full-identity check against exactly that: real process P1 acquires and
   * is then genuinely killed (hard crash, not a graceful release); a real
   * P2 legitimately reclaims the now-truly-dead P1; only THEN does this
   * test call releaseWorkspaceLock with P1's captured (now stale) identity
   * -- it must be a complete no-op, never touching P2's fresh lock.
   */
  it("an old owner's (stale, post-crash) release can never delete a new owner's fresh claim", async () => {
    const stateDir = isolateStateDir();
    const workspaceId = "lock-release-vs-new-owner-ws";
    const signalFile = path.join(stateDir, "signal");
    // P1 is kept alive (hold mode) until we deliberately SIGKILL it below --
    // otherwise it would exit on its own the instant it acquires, and a
    // kill against an already-exited pid is just an ESRCH race, not a
    // faithful "real crash of a genuinely still-running holder".
    const holdReleaseFileP1 = path.join(stateDir, "hold-release-p1");
    const resultFileP1 = path.join(stateDir, "result-p1.json");
    const resultFileP2 = path.join(stateDir, "result-p2.json");

    const spawnWorker = (resultFile: string, workerId: string, holdReleaseFile?: string) =>
      spawn(
        process.execPath,
        [
          "--import",
          "tsx/esm",
          lockRaceWorker,
          workspaceId,
          signalFile,
          resultFile,
          workerId,
          ...(holdReleaseFile ? [holdReleaseFile] : []),
        ],
        { stdio: "ignore", env: process.env }
      );

    const p1 = spawnWorker(resultFileP1, "p1", holdReleaseFileP1);
    fs.writeFileSync(signalFile, "go");
    await vi.waitUntil(() => fs.existsSync(resultFileP1), { timeout: 5_000, interval: 20 });
    const p1Result = JSON.parse(fs.readFileSync(resultFileP1, "utf8"));
    expect(p1Result.result.ok).toBe(true);
    const p1Info: WorkspaceLockInfo = p1Result.info;
    expect(observePid(p1Info.pid)).toBe("present");

    // Real, hard crash of a genuinely still-alive holder: no graceful
    // release, lock left pointing at a now-dead pid.
    process.kill(p1Info.pid, "SIGKILL");
    await new Promise<void>((resolve) => p1.once("exit", () => resolve()));
    await vi.waitUntil(() => observePid(p1Info.pid) === "missing", { timeout: 10_000, interval: 100 });

    // `signalFile` already exists from P1's run, so P2 (waiting on that same
    // file) fires immediately once spawned.
    const p2 = spawnWorker(resultFileP2, "p2");
    await new Promise<void>((resolve) => p2.once("exit", () => resolve()));
    const p2Result = JSON.parse(fs.readFileSync(resultFileP2, "utf8"));
    expect(p2Result.result.ok).toBe(true);
    expect(readWorkspaceLock(workspaceId)?.pid).toBe(p2Result.info.pid);

    // The core assertion: P1's stale identity, acted on AFTER it was
    // legitimately superseded, must never delete P2's fresh claim.
    releaseWorkspaceLock(p1Info);
    const finalLock = readWorkspaceLock(workspaceId);
    expect(finalLock?.pid).toBe(p2Result.info.pid);
    expect(finalLock?.generation).toBe("worker-p2");
  }, 20_000);

  /**
   * Test D (FINAL_REVIEW_3), at the lock primitive's own level (a
   * higher-level version already exists in the `ensureBridge()` describe
   * block above): a genuinely crashed holder is recoverable, and exactly
   * one new owner emerges even when more than one real process contends
   * for that now-dead slot.
   */
  it("a genuinely crashed holder is recovered by exactly one of several contenders", async () => {
    const stateDir = isolateStateDir();
    const workspaceId = "lock-crash-recover-ws";
    const signalFile = path.join(stateDir, "signal");
    const holdReleaseFile = path.join(stateDir, "hold-release-holder");
    const resultFileHolder = path.join(stateDir, "result-holder.json");

    const holder = spawn(
      process.execPath,
      ["--import", "tsx/esm", lockRaceWorker, workspaceId, signalFile, resultFileHolder, "holder", holdReleaseFile],
      { stdio: "ignore", env: process.env }
    );
    fs.writeFileSync(signalFile, "go");
    await vi.waitUntil(() => fs.existsSync(resultFileHolder), { timeout: 5_000, interval: 20 });
    const holderResult = JSON.parse(fs.readFileSync(resultFileHolder, "utf8"));
    expect(holderResult.result.ok).toBe(true);
    expect(observePid(holderResult.pid)).toBe("present");

    process.kill(holderResult.pid, "SIGKILL");
    await new Promise<void>((resolve) => holder.once("exit", () => resolve()));
    await vi.waitUntil(() => observePid(holderResult.pid) === "missing", { timeout: 10_000, interval: 100 });

    const { outcomes } = await raceForStaleLock(stateDir, workspaceId, holderResult.pid, ["X", "Y", "Z"]);
    for (const o of outcomes) expect(o.error).toBeUndefined();
    const winners = outcomes.filter((o) => o.result.ok);
    expect(winners.length).toBe(1);
  }, 30_000);

  /**
   * BLOCKER #1 (independent review, 2026-09-04, round 4): the arbitration
   * winner crashing between winning the arbiter file and actually replacing
   * the main lock used to leave a permanently-occupied arbiter path -- since
   * `fs.linkSync` only ever succeeds against an ABSENT target, nothing could
   * ever supersede a dead winner's claim, and every future contender for
   * this exact workspace would get EEXIST forever (a crash-induced
   * permanent deadlock). This test reproduces the EXACT window via a
   * test-only pause hook (`C2C_LOCK_TEST_ARBITER_PAUSE_FILE`, see lock.ts):
   * a real process is made to pause immediately after winning arbitration
   * and before touching the main lock, is then genuinely `SIGKILL`ed right
   * there, and a second real process must still be able to make forward
   * progress afterward -- not "eventually", not "after a TTL", immediately.
   */
  it("BLOCKER 1 (round 4): a real process killed between winning arbitration and replacing the main lock never permanently deadlocks the workspace", async () => {
    const stateDir = isolateStateDir();
    const workspaceId = "lock-arbiter-crash-ws";
    const deadPid = 999_997;
    expect(observePid(deadPid)).toBe("missing");
    fs.writeFileSync(
      workspaceLockFile(workspaceId),
      JSON.stringify({ workspaceId, pid: deadPid, generation: "dead-gen", createdAt: new Date().toISOString() })
    );

    const signalFile = path.join(stateDir, "signal");
    const resultFile = path.join(stateDir, "result-p1.json");
    const barrier = path.join(stateDir, "arbiter-pause-barrier");

    const p1 = spawn(
      process.execPath,
      ["--import", "tsx/esm", lockRaceWorker, workspaceId, signalFile, resultFile, "p1"],
      { stdio: "ignore", env: { ...process.env, C2C_LOCK_TEST_ARBITER_PAUSE_FILE: barrier } }
    );
    fs.writeFileSync(signalFile, "go");

    // Wait until P1 has actually won arbitration and is parked in the
    // barrier -- i.e. it has NOT yet touched the main lock (still `dead-gen`
    // at this point) and will never get the chance to, since we kill it
    // right here.
    await vi.waitUntil(() => fs.existsSync(`${barrier}.reached`), { timeout: 10_000, interval: 20 });
    expect(readWorkspaceLock(workspaceId)?.generation).toBe("dead-gen");
    expect(fs.existsSync(resultFile)).toBe(false); // P1 hasn't written a result -- still paused, not done

    process.kill(p1.pid!, "SIGKILL");
    await new Promise<void>((resolve) => p1.once("exit", () => resolve()));
    // We deliberately never write `${barrier}.go` -- P1 is gone for good,
    // orphaning whatever arbiter-chain path it won.

    // A second, completely normal (no barrier) real process must still be
    // able to reclaim this workspace -- immediately, not after any delay.
    // Kept alive (hold mode) so we can confirm it's a genuine, still-live
    // owner afterward, not just a result file claiming success.
    const signalFile2 = path.join(stateDir, "signal-2");
    const resultFile2 = path.join(stateDir, "result-p2.json");
    const holdReleaseFile2 = path.join(stateDir, "hold-release-p2");
    const p2 = spawn(
      process.execPath,
      ["--import", "tsx/esm", lockRaceWorker, workspaceId, signalFile2, resultFile2, "p2", holdReleaseFile2],
      { stdio: "ignore", env: process.env }
    );
    fs.writeFileSync(signalFile2, "go");
    await vi.waitUntil(() => fs.existsSync(resultFile2), { timeout: 5_000, interval: 20 });
    const p2Result = JSON.parse(fs.readFileSync(resultFile2, "utf8"));
    expect(p2Result.error).toBeUndefined();
    expect(p2Result.result.ok).toBe(true);
    expect(readWorkspaceLock(workspaceId)?.generation).toBe("worker-p2");

    // And exactly one live owner at the end -- no orphaned artifact ever
    // let a THIRD party sneak in too.
    expect(observePid(p2Result.pid)).toBe("present");

    fs.writeFileSync(holdReleaseFile2, "go");
    await new Promise<void>((resolve) => p2.once("exit", () => resolve()));
  }, 30_000);

  /**
   * BLOCKER #2 (independent review, 2026-09-04, round 4, strengthened round
   * 5): `releaseWorkspaceLock` used to read the main lock, compare identity,
   * and `rmSync` it -- a real check-then-act gap on the one path every
   * caller contends over. The fix changes the contract: release never
   * touches the shared main-lock path at all; it only ever creates a
   * tombstone unique to its OWN identity (see lock.ts).
   *
   * The round-4 version of this test only checked the state AFTER both the
   * hammer and P2 had exited -- a fifth-round audit correctly pointed out
   * this could go green even in a degenerate case (e.g. the hammer process
   * dying before ever calling `releaseWorkspaceLock` even once) without
   * actually proving anything happened concurrently. This version proves
   * the hammer genuinely ran (its own result file reports `calls > 0` and
   * it exited 0) AND that the fresh owner's ownership was never disturbed
   * at any point *during* the hammer's run, not just at the end: P2 is
   * acquired and held alive FIRST, then the hammer is run concurrently
   * against P1's (genuinely crashed) stale identity. On EVERY single
   * sample taken during the hammer's run, this directly asserts (not
   * "collect and check the aggregate afterward") that the main lock
   * exists, that its full identity is exactly P2's, and that
   * `observePid(P2)` is `present` -- a `null` read or any mismatch fails
   * immediately, at the sample where it happened. Sampling is synchronized
   * to the hammer's actual lifetime, not a guessed delay: the hammer
   * writes a ready-file the instant it enters its release loop (this test
   * waits for that before
   * sampling starts), and sampling continues until the hammer process has
   * actually exited (checked via its own `exit` event, not a fixed
   * duration) -- so the whole run is covered, no more and no less.
   */
  it("BLOCKER 2 (round 4/5): a real release hammer genuinely races a held-alive fresh owner and never once disturbs it", async () => {
    const stateDir = isolateStateDir();
    const workspaceId = "lock-release-hammer-ws";
    const signalFile = path.join(stateDir, "signal");
    const resultFileP1 = path.join(stateDir, "result-p1.json");
    // Kept alive (hold mode) until we deliberately SIGKILL it below --
    // otherwise it exits on its own the instant it acquires, and killing an
    // already-exited pid is just an ESRCH race, not a faithful "real crash
    // of a genuinely still-running holder".
    const holdReleaseFileP1 = path.join(stateDir, "hold-release-p1");

    const p1 = spawn(
      process.execPath,
      ["--import", "tsx/esm", lockRaceWorker, workspaceId, signalFile, resultFileP1, "p1", holdReleaseFileP1],
      { stdio: "ignore", env: process.env }
    );
    fs.writeFileSync(signalFile, "go");
    await vi.waitUntil(() => fs.existsSync(resultFileP1), { timeout: 5_000, interval: 20 });
    const p1Result = JSON.parse(fs.readFileSync(resultFileP1, "utf8"));
    expect(p1Result.result.ok).toBe(true);
    const p1Info: WorkspaceLockInfo = p1Result.info;
    expect(observePid(p1Info.pid)).toBe("present");

    // Real, hard crash of a genuinely still-alive holder -- P1's stale
    // identity is now legitimately reclaimable, and is what the concurrent
    // hammer will keep "releasing".
    process.kill(p1Info.pid, "SIGKILL");
    await new Promise<void>((resolve) => p1.once("exit", () => resolve()));
    await vi.waitUntil(() => observePid(p1Info.pid) === "missing", { timeout: 10_000, interval: 100 });

    // P2 acquires and is kept alive (hold mode) BEFORE the hammer starts, so
    // there is a real, held-open window in which to prove the hammer cannot
    // touch it.
    const p2Signal = path.join(stateDir, "signal-p2");
    const resultFileP2 = path.join(stateDir, "result-p2.json");
    const holdReleaseFileP2 = path.join(stateDir, "hold-release-p2");
    const p2 = spawn(
      process.execPath,
      ["--import", "tsx/esm", lockRaceWorker, workspaceId, p2Signal, resultFileP2, "p2", holdReleaseFileP2],
      { stdio: "ignore", env: process.env }
    );
    fs.writeFileSync(p2Signal, "go");
    await vi.waitUntil(() => fs.existsSync(resultFileP2), { timeout: 5_000, interval: 20 });
    const p2Result = JSON.parse(fs.readFileSync(resultFileP2, "utf8"));
    expect(p2Result.error).toBeUndefined();
    expect(p2Result.result.ok).toBe(true);
    const p2Info: WorkspaceLockInfo = p2Result.info;
    expect(observePid(p2Info.pid)).toBe("present");
    expect(readWorkspaceLock(workspaceId)).toMatchObject({ pid: p2Info.pid, generation: "worker-p2" });

    // Now race the hammer against P1's stale identity for its whole
    // duration, sampling P2's ownership repeatedly throughout that exact
    // window -- not just before/after.
    const hammerSignal = path.join(stateDir, "hammer-signal");
    const hammerResultFile = path.join(stateDir, "hammer-result.json");
    const hammerDurationMs = 800;
    const hammer = spawn(
      process.execPath,
      [
        "--import",
        "tsx/esm",
        lockReleaseHammer,
        workspaceId,
        String(p1Info.pid),
        p1Info.generation,
        p1Info.createdAt,
        hammerSignal,
        String(hammerDurationMs),
        hammerResultFile,
      ],
      { stdio: "ignore", env: process.env }
    );
    let hammerExited = false;
    const hammerExitCodePromise = new Promise<number | null>((resolve) =>
      hammer.once("exit", (code) => {
        hammerExited = true;
        resolve(code);
      })
    );
    const hammerReadyFile = `${hammerResultFile}.ready`;
    fs.writeFileSync(hammerSignal, "go");

    // Wait for the hammer to confirm (via its own ready-file signal, not a
    // guessed delay) that it has actually entered its release loop before
    // sampling starts, then keep sampling until the hammer process has
    // actually exited -- covering its whole run, not a time-guessed window
    // around it.
    await vi.waitUntil(() => fs.existsSync(hammerReadyFile), { timeout: 5_000, interval: 10 });

    // Directly assert, on EVERY sample, that the main lock exists AND is
    // exactly P2's full identity AND P2 is confirmed alive -- not "collect
    // whatever was observed and check it afterward" (a `null` sample, or
    // any sample not matching P2, fails immediately, right where it
    // happened, rather than being silently absorbed into an aggregate).
    while (!hammerExited) {
      const lock = readWorkspaceLock(workspaceId);
      expect(lock).not.toBeNull();
      expect(lock).toMatchObject({ pid: p2Info.pid, generation: p2Info.generation, createdAt: p2Info.createdAt });
      expect(observePid(p2Info.pid)).toBe("present");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const hammerExitCode = await hammerExitCodePromise;
    expect(hammerExitCode).toBe(0);
    const hammerResult = JSON.parse(fs.readFileSync(hammerResultFile, "utf8"));
    expect(hammerResult.error).toBeUndefined();
    // Proof the hammer genuinely did the thing this test is about, not just
    // that its process happened to exit cleanly.
    expect(hammerResult.calls).toBeGreaterThan(0);

    // Still present after the hammer is done, and still the recorded owner.
    expect(observePid(p2Info.pid)).toBe("present");
    const finalLock = readWorkspaceLock(workspaceId);
    expect(finalLock?.pid).toBe(p2Info.pid);
    expect(finalLock?.generation).toBe("worker-p2");

    // Not this test's concern (release/tombstone lifecycle itself is
    // covered by the "acquires freely..." and "an old owner's (stale,
    // post-crash) release..." tests above) -- just let P2 go so this test
    // doesn't leak a held-open subprocess.
    fs.writeFileSync(holdReleaseFileP2, "go");
    await new Promise<void>((resolve) => p2.once("exit", () => resolve()));
  }, 30_000);

  /**
   * BLOCKER #1, max-one-owner variant (independent review, 2026-09-04,
   * round 5): the crash-window regression above proves an orphaned arbiter
   * claim doesn't permanently deadlock the workspace, but doesn't itself
   * directly pin "at most one live owner, ever" IN that specific orphaned-
   * chain state -- the ordinary 2-/3-process race tests exercise "at most
   * one owner" but never against an already-orphaned arbiter claim from a
   * prior crash. This test combines both: reproduce the exact
   * crash-orphaned-arbiter state, then race TWO real contenders to recover
   * it, with the eventual winner kept alive throughout so the loser's
   * repeated retries are a real, faithful race -- proving at most one live
   * owner even in this specific, previously-untested state.
   */
  it("BLOCKER 1 (round 5): at most one live owner when two real contenders race to recover a crash-orphaned arbiter claim", async () => {
    const stateDir = isolateStateDir();
    const workspaceId = "lock-arbiter-crash-max1-ws";
    const deadPid = 999_996;
    expect(observePid(deadPid)).toBe("missing");
    fs.writeFileSync(
      workspaceLockFile(workspaceId),
      JSON.stringify({ workspaceId, pid: deadPid, generation: "dead-gen", createdAt: new Date().toISOString() })
    );

    // Reproduce the exact orphan-arbiter-chain state: P1 wins arbitration
    // for this dead main holder, is paused right there (test-only hook),
    // and is genuinely killed before ever touching the main lock -- leaving
    // its won arbiter claim permanently orphaned.
    const signalFileP1 = path.join(stateDir, "signal-p1");
    const resultFileP1 = path.join(stateDir, "result-p1.json");
    const barrier = path.join(stateDir, "arbiter-pause-barrier");
    const p1 = spawn(
      process.execPath,
      ["--import", "tsx/esm", lockRaceWorker, workspaceId, signalFileP1, resultFileP1, "p1"],
      { stdio: "ignore", env: { ...process.env, C2C_LOCK_TEST_ARBITER_PAUSE_FILE: barrier } }
    );
    fs.writeFileSync(signalFileP1, "go");
    await vi.waitUntil(() => fs.existsSync(`${barrier}.reached`), { timeout: 10_000, interval: 20 });
    expect(readWorkspaceLock(workspaceId)?.generation).toBe("dead-gen");
    process.kill(p1.pid!, "SIGKILL");
    await new Promise<void>((resolve) => p1.once("exit", () => resolve()));
    // Never write `${barrier}.go` -- P1 is gone for good. The main lock
    // file still shows the ORIGINAL dead-gen identity: nobody has replaced
    // it yet, and P1's won (but never consumed) arbiter claim is orphaned.
    expect(readWorkspaceLock(workspaceId)?.generation).toBe("dead-gen");

    // Now, with that orphan still in place, race TWO real contenders to
    // recover the same dead workspace -- whichever supersedes P1's
    // orphaned claim must be the sole eventual owner, kept alive throughout
    // so the other's repeated retries against it are a real race.
    const signalFile = path.join(stateDir, "signal-race");
    const holdReleaseFile = path.join(stateDir, "hold-release-race");
    const resultFiles = { P2: path.join(stateDir, "result-P2.json"), P3: path.join(stateDir, "result-P3.json") };
    const spawnWorker = (resultFile: string, workerId: string) =>
      spawn(
        process.execPath,
        ["--import", "tsx/esm", lockRaceWorker, workspaceId, signalFile, resultFile, workerId, holdReleaseFile],
        { stdio: "ignore", env: process.env }
      );
    const procs = { P2: spawnWorker(resultFiles.P2, "P2"), P3: spawnWorker(resultFiles.P3, "P3") };
    const exits = Promise.all(Object.values(procs).map((p) => new Promise<void>((resolve) => p.once("exit", () => resolve()))));
    await new Promise((resolve) => setTimeout(resolve, 500));
    fs.writeFileSync(signalFile, "go");

    // Wait for the race to settle onto a genuine, live winner (neither the
    // now-superseded dead-gen placeholder nor P1's orphaned claim).
    await vi.waitUntil(
      () => {
        const lock = readWorkspaceLock(workspaceId);
        return lock !== null && lock.pid !== deadPid && observePid(lock.pid) === "present";
      },
      { timeout: 10_000, interval: 20 }
    );

    // While the winner holds, repeatedly sample: at most one live owner,
    // ever, and its identity never changes.
    const observedIdentities = new Set<string>();
    for (let i = 0; i < 8; i++) {
      const lock = readWorkspaceLock(workspaceId);
      if (lock) observedIdentities.add(`${lock.pid}:${lock.generation}:${lock.createdAt}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(observedIdentities.size).toBe(1);
    const settledLock = readWorkspaceLock(workspaceId);
    expect(settledLock).not.toBeNull();
    expect(observePid(settledLock!.pid)).toBe("present");

    fs.writeFileSync(holdReleaseFile, "go");
    await exits;

    const outcomes = Object.entries(resultFiles).map(([id, f]) => ({ id, ...JSON.parse(fs.readFileSync(f, "utf8")) }));
    for (const o of outcomes) expect(o.error).toBeUndefined();
    const winners = outcomes.filter((o) => o.result.ok);
    expect(winners.length).toBe(1);
    for (const o of outcomes) {
      if (!o.result.ok) {
        expect(Array.isArray(o.attempts)).toBe(true);
        expect(o.attempts.length).toBeGreaterThan(0);
        expect(o.attempts.every((a: LockAcquireResult) => !a.ok)).toBe(true);
      }
    }
    const winner = winners[0];
    const finalLock = readWorkspaceLock(workspaceId);
    expect(finalLock?.pid).toBe(winner.pid);
    expect(finalLock?.generation).toBe(`worker-${winner.workerId}`);
  }, 30_000);
});

describe("sameLockInstance -- identity comparison used by stale reclaim (requirement: never pid-alone)", () => {
  it("pid matching alone is NOT sufficient -- a differing generation or createdAt means a different instance, even with the identical pid number", () => {
    const base = { workspaceId: "ws", pid: 4242, generation: "gen-A", createdAt: "2026-01-01T00:00:00.000Z" };
    expect(sameLockInstance(base, { ...base })).toBe(true);
    expect(sameLockInstance(base, { ...base, generation: "gen-B" })).toBe(false);
    expect(sameLockInstance(base, { ...base, createdAt: "2026-01-01T00:00:00.001Z" })).toBe(false);
    expect(sameLockInstance(base, { ...base, generation: "gen-B", createdAt: "2026-01-01T00:00:00.001Z" })).toBe(false);
    // A genuinely different workspace sharing the same pid/generation/
    // createdAt by pure coincidence is still not misidentified, since
    // callers always compare within a single workspace's own lock file --
    // included here only to document that this function itself doesn't
    // special-case workspaceId (callers never mix workspaces).
    expect(sameLockInstance(base, { ...base, workspaceId: "other-ws" })).toBe(true);
  });
});
