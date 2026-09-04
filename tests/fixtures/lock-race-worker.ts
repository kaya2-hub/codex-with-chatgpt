// Real-subprocess worker for the stale-lock-reclaim race regression tests
// (independent review, 2026-09-04 -- see tests/workspace-lock.test.ts).
// Spawned as its own OS process so the races it exercises are genuine
// cross-process filesystem races on bridge/lock.ts's acquireWorkspaceLock(),
// not something simulated within a single Node event loop.
//
// usage: node lock-race-worker.ts <workspaceId> <signalFile> <resultFile> <workerId> [holdReleaseFile]
//
// Waits for `signalFile` to exist, then immediately calls
// acquireWorkspaceLock() and records the outcome (or any thrown error) to
// `resultFile` right away -- so a test can determine the winner promptly
// without waiting for this process to exit.
//
// If `holdReleaseFile` is given, this worker does NOT exit immediately
// afterwards:
//   - the WINNER (result.ok === true) stays alive -- holding the lock, its
//     pid genuinely `present` the whole time -- until `holdReleaseFile`
//     appears, so a test can prove ownership is never even momentarily lost
//     while real losers keep retrying against a real live holder (a winner
//     that exits right after winning would make the next observer see a
//     merely-just-exited pid as "missing" and legitimately reclaim it --
//     which is a correct reclaim of a genuinely dead process, not a race
//     bug, but it means the test wasn't actually exercising "can you steal
//     from a live holder", only "can you reclaim a dead one").
//   - a LOSER keeps retrying `acquireWorkspaceLock()` in a loop (recording
//     every attempt's outcome to `resultFile` as an array under `attempts`)
//     until `holdReleaseFile` appears, so a test can confirm that NONE of
//     those repeated attempts against the still-alive winner ever succeeds.
// Any number of these can be spawned against the same `signalFile` to force
// an N-way concurrent race -- releasing them all by writing `signalFile`
// once every worker is already parked in its wait loop is what actually
// reproduces cross-process filesystem races; an artificially staged
// "observe, pause, resume" sequence does NOT, since acquireWorkspaceLock()
// always re-observes everything fresh on every call and has no memory of an
// earlier observation to act on stale-ly.
import fs from "node:fs";
import { acquireWorkspaceLock, type LockAcquireResult, type WorkspaceLockInfo } from "../../src/bridge/lock.js";

const [, , workspaceId, signalFile, resultFile, workerId, holdReleaseFile] = process.argv;

// Fixed once per process, reused for every attempt this worker makes -- a
// real holder's identity (pid/generation/createdAt) never changes across
// its own retries, only across genuinely different processes.
const info: WorkspaceLockInfo = {
  workspaceId,
  pid: process.pid,
  generation: `worker-${workerId}`,
  createdAt: new Date().toISOString(),
};

function waitFor(predicate: () => boolean, timeoutMs: number, timeoutMessage: string): void {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(timeoutMessage);
  }
}

function acquireOnce(): LockAcquireResult {
  return acquireWorkspaceLock(info);
}

try {
  waitFor(() => fs.existsSync(signalFile), 10_000, "timed out waiting for start signal");

  const result = acquireOnce();

  if (!holdReleaseFile) {
    fs.writeFileSync(resultFile, JSON.stringify({ workerId, pid: process.pid, info, result }));
    process.exit(0);
  }

  if (result.ok) {
    // Winner: stay alive (genuinely `present` to observePid) until told to
    // let go, so losers race a real live holder, not a just-exited pid.
    fs.writeFileSync(resultFile, JSON.stringify({ workerId, pid: process.pid, info, result }));
    waitFor(() => fs.existsSync(holdReleaseFile), 10_000, "winner timed out waiting for hold-release signal");
    process.exit(0);
  }

  // Loser: keep retrying against the still-alive winner until released,
  // recording every attempt so the test can assert none of them ever wins.
  const attempts: LockAcquireResult[] = [result];
  while (!fs.existsSync(holdReleaseFile)) {
    attempts.push(acquireOnce());
  }
  fs.writeFileSync(resultFile, JSON.stringify({ workerId, pid: process.pid, info, result, attempts }));
  process.exit(0);
} catch (error) {
  fs.writeFileSync(
    resultFile,
    JSON.stringify({ workerId, pid: process.pid, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) })
  );
  process.exit(1);
}
