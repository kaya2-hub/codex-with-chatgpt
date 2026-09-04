// Real-subprocess worker for the BLOCKER-2 release-race regression
// (independent review, 2026-09-04, round 4 -- see tests/workspace-lock.test.ts).
// Repeatedly calls releaseWorkspaceLock() with a FIXED, given (possibly
// stale) identity in a tight loop for a bounded duration, so a test can
// race it -- as a real, separate OS process -- against a concurrent
// legitimate acquirer for the same workspace, maximizing the chance of
// genuinely overlapping at the OS scheduler level.
//
// Writes a result file so the parent test can verify this actually ran
// (independent review, 2026-09-04, round 5 -- a fifth-round audit correctly
// pointed out the earlier version of this fixture let a test go green even
// if the hammer died before ever calling releaseWorkspaceLock even once):
// `{ calls, error? }` -- `calls` is the number of releaseWorkspaceLock()
// invocations actually completed. A result file with `calls > 0` and a
// clean exit code is the parent test's proof this hammer really ran, not
// just that its process happened to exit 0.
//
// Also writes `${resultFile}.ready` the instant it actually enters the
// hammer loop (independent review, round 5, second finding: the parent
// test previously started sampling on a guessed delay rather than a real
// readiness signal) -- the parent test waits for this file before starting
// to sample, and keeps sampling until this process actually exits, so the
// whole hammer run is covered, not just a window around it.
//
// usage: node lock-release-hammer.ts <workspaceId> <pid> <generation> <createdAt> <signalFile> <durationMs> <resultFile>
import fs from "node:fs";
import { releaseWorkspaceLock } from "../../src/bridge/lock.js";

const [, , workspaceId, pidStr, generation, createdAt, signalFile, durationMsStr, resultFile] = process.argv;
const info = { workspaceId, pid: Number(pidStr), generation, createdAt };
const durationMs = Number(durationMsStr);
const readyFile = `${resultFile}.ready`;

try {
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(signalFile)) {
    if (Date.now() > deadline) throw new Error("timed out waiting for start signal");
  }

  fs.writeFileSync(readyFile, "1");

  const stop = Date.now() + durationMs;
  let calls = 0;
  while (Date.now() < stop) {
    releaseWorkspaceLock(info);
    calls++;
  }
  fs.writeFileSync(resultFile, JSON.stringify({ calls }));
  process.exit(0);
} catch (error) {
  fs.writeFileSync(resultFile, JSON.stringify({ calls: 0, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }));
  process.exit(1);
}
