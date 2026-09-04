import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir, getStateDir } from "../config/paths.js";
import {
  clearRuntimeState,
  findBridgeObservation,
  findLiveBridge,
  observePid,
  type RuntimeState,
} from "../bridge/runtime.js";
import { Workspace } from "../workspace/manager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Path to the CLI entry, works from dist/ and from tsx dev runs.
 *
 *  Must point at `cli/run.(js|ts)`, never `cli/index.(js|ts)` — since
 *  ITERATION 3's fix for the dist/npm `bin/c2c.js` no-op regression,
 *  `index.ts` only defines the program and exports `runCli()`; it has no
 *  top-level auto-execution at all. `run.ts` is the one file that
 *  unconditionally calls `runCli(process.argv)`. This exact function was
 *  missed in that fix and still pointed at `index.(js|ts)` — spawning it
 *  as `serve` would start a process that parses nothing and opens no
 *  port, silently breaking every path that calls `ensureBridge()` (new
 *  bridge spawn, bridge restart, `doctor --fix`, Named fallback repair)
 *  the moment no live bridge is already running to reuse. `bin/c2c.js`
 *  resolves the same `cli/run.(js|ts)` pair — see its own comment; if
 *  that ever needs to change, this must change identically (see
 *  tests/cli-entrypoint.test.ts for the regression coverage on both). */
function cliEntry(): { cmd: string; args: string[] } {
  const distEntry = path.resolve(__dirname, "..", "cli", "run.js");
  if (fs.existsSync(distEntry)) {
    return { cmd: process.execPath, args: [distEntry] };
  }
  // dev fallback: run TypeScript sources through the tsx ESM loader
  const projectRoot = path.resolve(__dirname, "..", "..");
  const tsEntry = path.join(projectRoot, "src", "cli", "run.ts");
  return { cmd: process.execPath, args: ["--import", "tsx/esm", tsEntry] };
}

export interface EnsureBridgeResult {
  runtime: RuntimeState;
  spawned: boolean;
}

/**
 * Ensure a bridge is running for the workspace. Reuses a live instance,
 * otherwise spawns a detached daemon and waits for it to become healthy.
 */
export async function ensureBridge(workspaceRoot: string, opts: { port?: number } = {}): Promise<EnsureBridgeResult> {
  const workspace = new Workspace(workspaceRoot);
  const observation = await findBridgeObservation(workspace.id);
  if (observation.state === "healthy") return { runtime: observation.runtime, spawned: false };
  if (observation.state === "unknown") {
    throw new Error(
      `Bridge state is uncertain (${observation.reason}); refusing to start another bridge.`
    );
  }
  if (observation.state === "stale") {
    // Our own bridge died without reaching its graceful shutdown (which
    // would have cleared this file itself -- see server.ts's shutdown()),
    // and its old port has since been legitimately claimed by a different
    // workspace's live bridge. That other bridge is never touched here --
    // only our own stale pointer is discarded. The fresh spawn below never
    // reuses the stale port itself: it asks for the same DEFAULT_PORT every
    // fresh start prefers, and server.ts's listen() already falls back to
    // an OS-assigned ephemeral port on EADDRINUSE if something (including
    // that other workspace) is still holding it.
    clearRuntimeState(workspace.id);
  }

  const logDir = ensureDir(path.join(getStateDir(), "logs"));
  const logFile = path.join(logDir, `bridge-${workspace.id}.out.log`);
  const out = fs.openSync(logFile, "a", 0o600);
  try {
    // Existing files may have been created with a permissive umask. Keep the
    // daemon's inherited stdout/stderr log owner-readable only.
    fs.chmodSync(logFile, 0o600);
  } catch {
    // Windows / filesystems without chmod semantics
  }
  const { cmd, args } = cliEntry();
  const child = spawn(
    cmd,
    [...args, "serve", "--workspace", workspace.root, ...(opts.port ? ["--port", String(opts.port)] : [])],
    {
      detached: true,
      stdio: ["ignore", out, out],
      env: { ...process.env },
    }
  );
  child.unref();
  fs.closeSync(out);

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const runtime = await findLiveBridge(workspace.id);
    if (runtime) return { runtime, spawned: true };
    if (child.exitCode !== null && child.exitCode !== 0) {
      // The most common reason this child exits immediately: it lost the
      // workspace's single-instance ownership lock (see bridge/lock.ts) to
      // an already-alive bridge -- exactly what happens when THIS call's
      // own earlier `findBridgeObservation()` above was misled by a
      // transient health-probe failure against a bridge that was actually
      // fine. Re-check once, now, before reporting failure: if a real
      // bridge answers healthy at this point (very likely the one that won
      // the lock), converge on it rather than surfacing a spurious error --
      // this is what makes "ensureBridge() from a second process while the
      // first is merely slow to answer" resolve to the SAME instance
      // instead of erroring (connector reliability hardening, independent
      // review 2026-09-03).
      const recheck = await findBridgeObservation(workspace.id);
      if (recheck.state === "healthy") return { runtime: recheck.runtime, spawned: false };
      throw new Error(`Bridge process exited with code ${child.exitCode}. See ${logFile}`);
    }
  }
  throw new Error(`Bridge did not become healthy within 20s. See ${logFile}`);
}

export async function adminFetch<T = unknown>(
  runtime: RuntimeState,
  method: "GET" | "POST",
  route: string,
  timeoutMs = 60_000,
  /** Optional JSON body. Added for /admin/self-test-token/revoke (P0-3); every
   *  pre-existing call site omits this and is completely unaffected. */
  requestBody?: unknown
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.port}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${runtime.adminToken}`,
        ...(requestBody !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: requestBody !== undefined ? JSON.stringify(requestBody) : undefined,
      signal: controller.signal,
    });
    const body = (await response.json().catch(() => ({}))) as T & { message?: string };
    if (!response.ok) {
      throw new Error((body as { message?: string }).message ?? `Admin request failed (${response.status})`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Stop the bridge for this workspace, if any. Never signals a pid whose
 * identity as *this workspace's* bridge isn't confirmed by a live health
 * check first -- a recorded pid can outlive the process it once named (the
 * OS is free to reuse it for something entirely unrelated), and blind-
 * signaling it was the exact bug this replaced: `workspace_mismatch` and
 * `probe_failed` used to fall through to `process.kill(runtime.pid, ...)`
 * unconditionally.
 *
 * Only ever returns `true` once the old process is CONFIRMED gone (see
 * `waitForPidExit`) -- never merely because `/admin/shutdown` answered.
 * That route (server.ts) responds before the real shutdown work runs, so
 * trusting the HTTP response alone races a still-alive old process. This
 * was a real, live bug: `c2c restart` reported success while reusing the
 * exact same PID, because `ensureBridge()`'s "reuse a healthy instance"
 * check ran before the old process had actually exited (independent
 * review, 2026-09-03 -- connector reliability hardening PRIORITY F).
 */
export async function stopBridge(workspaceRoot: string): Promise<boolean> {
  const workspace = new Workspace(workspaceRoot);
  const observation = await findBridgeObservation(workspace.id);

  if (observation.state === "healthy") {
    const pid = observation.runtime.pid;
    try {
      await adminFetch(observation.runtime, "POST", "/admin/shutdown", 5000);
    } catch {
      // Identity was just confirmed live via that health check above; the
      // admin call itself failing (not the identity) is the only reason
      // left to fall back to a direct signal here.
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        return false;
      }
    }
    return await waitForPidExit(workspace.id, pid);
  }

  if (observation.state === "stale") {
    // Our own bridge is already dead (see findBridgeObservation) -- there
    // is nothing left to signal, just drop the stale pointer.
    clearRuntimeState(workspace.id);
    return true;
  }

  // "stopped": nothing recorded, nothing to do. "unknown": the recorded
  // pid may have been reused by an unrelated process -- never guess.
  return false;
}

/**
 * Block until `pid` is confirmed gone (bounded, honest -- returns `false`,
 * never a false `true`, if it outlives the deadline). This is what makes
 * `stopBridge`'s return value trustworthy enough for a caller to safely
 * call `ensureBridge()` immediately afterward and know any "healthy"
 * result it gets back is necessarily a NEW process, not the old one still
 * finishing its shutdown.
 */
async function waitForPidExit(workspaceId: string, pid: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (observePid(pid) === "missing") {
      // The old process may have been killed before its own shutdown()
      // reached clearRuntimeState() (e.g. the SIGTERM fallback above) --
      // drop our own stale pointer here too so the very next
      // findBridgeObservation() sees "stopped", never a leftover "unknown".
      clearRuntimeState(workspaceId);
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}
