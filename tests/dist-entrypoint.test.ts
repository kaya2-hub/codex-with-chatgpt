import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensureBridge, stopBridge, adminFetch } from "../src/process/daemon.js";
import { attemptNamedFallbackRepair } from "../src/cli/index.js";
import { Workspace } from "../src/workspace/manager.js";
import { probeBridge, readRuntimeState, observePid } from "../src/bridge/runtime.js";
import { chooseQuickTunnel } from "../src/tunnel/named-provision.js";
import { makeTmpDir, cleanup, isolateStateDir } from "./helpers.js";

/**
 * Regression coverage for two real bugs found in ChatGPT's independent
 * review (2026-09-02):
 *
 * - ITERATION 2: `bin/c2c.js` picks between the compiled `dist/` build and
 *   a `src/` tsx fallback, but an earlier fix made `src/cli/index.ts` only
 *   auto-run itself when it detected it was "the main module"
 *   (`import.meta.url === process.argv[1]`) — true when tsx runs
 *   `src/cli/index.ts` directly (dev path), FALSE when `bin/c2c.js`
 *   dynamically `import()`s the compiled `dist/cli/index.js` (the real
 *   npm-published path), where `process.argv[1]` stays `bin/c2c.js`. The
 *   compiled CLI silently became a no-op.
 * - ITERATION 4: the fix for that (an explicit `runCli()` export, with
 *   `src/cli/run.ts` as the one real, always-self-invoking entry point)
 *   updated `bin/c2c.js` but missed `src/process/daemon.ts`'s `cliEntry()`,
 *   which still pointed at `cli/index.(js|ts)` — spawning it as `serve`
 *   for `ensureBridge()` starts a process that parses nothing and opens
 *   no port. Every path that calls `ensureBridge()` (a new bridge spawn,
 *   a restart, `doctor --fix`, Named fallback repair) would hang 20s and
 *   throw. This was masked in the live session only because the
 *   already-running c2c-dev bridge (started before the regression
 *   existed) was never restarted.
 *
 * Both bugs only reproduce against a REAL compiled `dist/` — this file
 * owns building one (`beforeAll`) and removing it again (`afterAll`) as
 * the ONE place in the suite that does so. `bin/c2c.js` and
 * `daemon.ts`'s `cliEntry()` both hardcode the project-root `dist/`
 * location (that's the whole point — it's what a real npm install looks
 * like), so an earlier version of this coverage, split across two files
 * each with their own beforeAll/afterAll, raced: vitest runs test files
 * in parallel worker threads by default (see vitest.config.ts's
 * `pool: "threads"`), so one file's cleanup could delete `dist/` while
 * the other was still mid-build or mid-use. Kept as one file specifically
 * to guarantee a single, non-racing build lifecycle.
 */
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distRunEntry = path.join(projectRoot, "dist", "cli", "run.js");
const distDaemonEntry = path.join(projectRoot, "dist", "process", "daemon.js");
const distDirPreexisted = fs.existsSync(path.join(projectRoot, "dist"));

beforeAll(() => {
  // Real build — same command `npm run build` runs, invoked directly via
  // node + the typescript package's own bin script (not `npx`/a shell) so
  // this doesn't depend on PATH/shell resolution of wrapper scripts (npx.cmd
  // on Windows, etc.) inside the test runner's own process.
  const tsc = path.join(projectRoot, "node_modules", "typescript", "bin", "tsc");
  execFileSync(process.execPath, [tsc, "-p", "tsconfig.json"], { cwd: projectRoot, stdio: "pipe" });
  expect(fs.existsSync(distRunEntry)).toBe(true);
  expect(fs.existsSync(distDaemonEntry)).toBe(true);
}, 60_000);

afterAll(() => {
  // Restore the dev-checkout convention (stale-dist detection in
  // bin/c2c.js is a safety net, not a reason to leave dist/ lying around).
  if (!distDirPreexisted) fs.rmSync(path.join(projectRoot, "dist"), { recursive: true, force: true });
});

describe("bin/c2c.js actually runs the CLI when dist/ is present (npm-published path)", () => {
  it("prints the real version, not silently doing nothing", () => {
    const result = spawnSync(process.execPath, ["bin/c2c.js", "--version"], {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(result.status).toBe(0);
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")) as { version: string };
    expect(result.stdout.trim()).toBe(pkg.version);
  });

  it("actually executes a representative read-only command end to end", () => {
    // `doctor --no-fix --json` needs no running bridge and no network — a
    // safe, fully read-only, representative real command. A no-op CLI
    // would print nothing at all and exit non-zero/hang; a working one
    // prints a JSON report.
    const result = spawnSync(process.execPath, ["bin/c2c.js", "doctor", "--no-fix", "--json", "-w", projectRoot], {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout.trim()) as { report: Record<string, unknown> };
    expect(parsed.report).toBeTruthy();
    expect(parsed.report.node).toBeTruthy();
  });
});

const tmpDirs: string[] = [];
const bridgeRoots: string[] = [];

afterEach(async () => {
  while (bridgeRoots.length) {
    const root = bridgeRoots.pop()!;
    await stopBridge(root).catch(() => undefined);
  }
  while (tmpDirs.length) cleanup(tmpDirs.pop()!);
});

describe("ensureBridge() actually spawns a working serve process (real daemon spawn path)", () => {
  it("dev path (tsx, src/cli/run.ts): the spawned bridge becomes live and healthy", async () => {
    isolateStateDir();
    const root = makeTmpDir("daemon-dev-ws");
    tmpDirs.push(root);
    const workspace = new Workspace(root);

    // Calling ensureBridge() the normal way (imported at top of this file)
    // always exercises the dev/tsx fallback branch of cliEntry(): under
    // vitest's own TS transform, daemon.ts's own import.meta.url never
    // resolves to a dist/ path, so its `distEntry` check is always false
    // here regardless of whether a dist/ build happens to exist on disk —
    // exactly mirroring how a real dev checkout without dist/ behaves.
    const result = await ensureBridge(root);
    bridgeRoots.push(root);
    expect(result.spawned).toBe(true);
    const health = await probeBridge(result.runtime.port);
    expect(health?.workspaceId).toBe(workspace.id);
  }, 30_000);

  it("dist path (dist/cli/run.js): the spawned bridge becomes live and healthy", async () => {
    isolateStateDir();
    const root = makeTmpDir("daemon-dist-ws");
    tmpDirs.push(root);
    const workspace = new Workspace(root);

    // Dynamically importing the compiled dist/process/daemon.js directly
    // (by absolute file:// URL, bypassing vitest's own module graph/TS
    // transform entirely) loads it as Node's native ESM loader would —
    // its OWN import.meta.url genuinely resolves under dist/, so
    // cliEntry()'s distEntry check inside THIS loaded instance correctly
    // finds dist/cli/run.js and spawns that, exactly like a real
    // installed npm package would.
    const distDaemon = (await import(pathToFileURL(distDaemonEntry).href)) as typeof import("../src/process/daemon.js");
    const result = await distDaemon.ensureBridge(root);
    bridgeRoots.push(root);
    expect(result.spawned).toBe(true);
    const health = await probeBridge(result.runtime.port);
    expect(health?.workspaceId).toBe(workspace.id);
  }, 30_000);
});

/**
 * Regression coverage for a third real bug, found live while smoke-testing
 * the OAuth connector reliability hardening work (2026-09-03): `c2c restart`
 * reported success ("Bridge 已重启") while the OS-level process never
 * actually changed -- confirmed live via `Get-Process node` showing the
 * exact same PID/StartTime before and after. Root cause: `/admin/shutdown`
 * (server.ts) responds *before* the real shutdown work runs (so its own
 * HTTP response isn't cut short by the socket closing under it), but
 * `stopBridge()` used to return `true` the moment that response arrived --
 * so the very next `ensureBridge()` call could see the still-alive old
 * process as "healthy" and just reuse it instead of spawning fresh. Fixed
 * by making `stopBridge()` block until the old pid is CONFIRMED gone
 * (`waitForPidExit` in daemon.ts) before ever returning `true`. These tests
 * use real spawned subprocesses throughout (via `ensureBridge`/`stopBridge`
 * and a real `bin/c2c.js restart` subprocess), never a mock of either.
 */
describe("stopBridge() + ensureBridge() -- a real restart cycle actually replaces the process", () => {
  it("PID, generation, and startedAt all change across a real stop+respawn, and the old pid is confirmed gone", async () => {
    isolateStateDir();
    const root = makeTmpDir("daemon-restart-ws");
    tmpDirs.push(root);
    const workspace = new Workspace(root);

    const first = await ensureBridge(root);
    bridgeRoots.push(root);
    expect(first.spawned).toBe(true);
    expect((await probeBridge(first.runtime.port))?.workspaceId).toBe(workspace.id);

    const stopped = await stopBridge(root);
    expect(stopped).toBe(true);
    // stopBridge() must not have returned true while the old process was
    // still alive -- verify directly, not just trust the boolean.
    expect(observePid(first.runtime.pid)).toBe("missing");

    const second = await ensureBridge(root);
    expect(second.spawned).toBe(true);
    expect(second.runtime.pid).not.toBe(first.runtime.pid);
    expect(second.runtime.generation).not.toBe(first.runtime.generation);
    expect((await probeBridge(second.runtime.port))?.workspaceId).toBe(workspace.id);
  }, 40_000);

  it("stopBridge() on a workspace with no running bridge returns false -- never lies about having stopped something", async () => {
    isolateStateDir();
    const root = makeTmpDir("daemon-restart-none-ws");
    tmpDirs.push(root);
    expect(await stopBridge(root)).toBe(false);
  });
});

describe("`c2c restart` (real subprocess, real bridge processes, dist/ build)", () => {
  it("actually replaces the process end to end: different PID and generation after a real restart", async () => {
    isolateStateDir();
    const root = makeTmpDir("cli-restart-ws");
    tmpDirs.push(root);
    const workspace = new Workspace(root);

    const first = await ensureBridge(root);
    bridgeRoots.push(root);
    expect(first.spawned).toBe(true);

    const result = spawnSync(process.execPath, ["bin/c2c.js", "restart", "-w", root], {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.status).toBe(0);

    const after = readRuntimeState(workspace.id);
    expect(after).toBeTruthy();
    expect(after!.pid).not.toBe(first.runtime.pid);
    expect(after!.generation).not.toBe(first.runtime.generation);
    expect(observePid(first.runtime.pid)).toBe("missing");
    expect((await probeBridge(after!.port))?.workspaceId).toBe(workspace.id);
  }, 40_000);

  it("`c2c restart` against a workspace with no bridge running just starts one (no false 'stop failed')", async () => {
    isolateStateDir();
    const root = makeTmpDir("cli-restart-fresh-ws");
    tmpDirs.push(root);
    const workspace = new Workspace(root);

    const result = spawnSync(process.execPath, ["bin/c2c.js", "restart", "-w", root], {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 30_000,
    });
    bridgeRoots.push(root);
    expect(result.status).toBe(0);

    const after = readRuntimeState(workspace.id);
    expect(after).toBeTruthy();
    expect((await probeBridge(after!.port))?.workspaceId).toBe(workspace.id);
  }, 40_000);
});

describe("OAuth pending-authorization state survives a REAL `c2c restart` (real subprocess, not the in-process bridge.close()+startBridge() simulation tests/oauth-connector-reliability.test.ts uses)", () => {
  it("a pairing request created before a real OS-level restart can still be completed against the new process", async () => {
    isolateStateDir();
    const root = makeTmpDir("oauth-real-restart-ws");
    tmpDirs.push(root);
    const workspace = new Workspace(root);

    const first = await ensureBridge(root);
    bridgeRoots.push(root);
    const base = `http://127.0.0.1:${first.runtime.port}`;

    // Register a client and start an authorize request -- the exact public
    // contract ChatGPT's own OAuth client uses.
    const registerRes = await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "restart-test-client", redirect_uris: ["http://127.0.0.1:1/cb"] }),
    });
    expect(registerRes.status).toBe(201);
    const { client_id: clientId } = (await registerRes.json()) as { client_id: string };

    const authorizeUrl = new URL(`${base}/oauth/authorize`);
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", "http://127.0.0.1:1/cb");
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("code_challenge", "test-challenge-not-exchanged-in-this-test");
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("scope", "workspace.read");
    const getRes = await fetch(authorizeUrl.toString());
    expect(getRes.status).toBe(200);
    const html = await getRes.text();
    const requestId = html.match(/name="request_id" value="([0-9a-f]+)"/)?.[1];
    expect(requestId).toBeTruthy();

    // Real, actual OS-level restart via the (now-fixed) daemon primitives --
    // not a simulation. Proves stopBridge()'s fix and AuthStore's
    // pendingAuthRequests durability actually compose correctly together.
    const stopped = await stopBridge(root);
    expect(stopped).toBe(true);
    const second = await ensureBridge(root);
    expect(second.spawned).toBe(true);
    expect(second.runtime.pid).not.toBe(first.runtime.pid);

    const secondBase = `http://127.0.0.1:${second.runtime.port}`;
    const pairing = await adminFetch<{ code: string }>(second.runtime, "POST", "/admin/pairing");
    const postRes = await fetch(`${secondBase}/oauth/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ request_id: requestId!, pairing_code: pairing.code }).toString(),
      redirect: "manual",
    });
    expect(postRes.status).toBe(302);
    const location = postRes.headers.get("location");
    expect(location).toBeTruthy();
    expect(new URL(location!).searchParams.get("code")).toBeTruthy();
  }, 40_000);
});

// Opt-in only (C2C_TEST_NETWORK=1) — needs a real cloudflared binary and
// real outbound network access to Cloudflare's trycloudflare.com edge.
// The default `npx vitest run` must stay green with no external network at
// all: cloudflared-missing machines, CI, a flaky network, or a
// Cloudflare/trycloudflare hiccup would otherwise fail the whole suite for
// reasons that have nothing to do with this project's own code. The
// DECISION logic this exercises (defaultBridgeRestart calling
// /admin/tunnel/start; attemptNamedFallbackRepair requiring
// running/url, not just the provider name) already has full hermetic
// coverage elsewhere (this file's daemon-spawn tests, and
// tests/connector-confirmation.test.ts's injected-restart tests) — this
// is additional real-world confidence, run manually:
//   C2C_TEST_NETWORK=1 npx vitest run tests/dist-entrypoint.test.ts
describe.skipIf(!process.env.C2C_TEST_NETWORK)(
  "attemptNamedFallbackRepair()'s DEFAULT restart (real subprocess, real cloudflared — opt-in smoke test, C2C_TEST_NETWORK=1)",
  () => {
    it("real ensureBridge + real /admin/tunnel/start against a Quick Tunnel: repaired is false (provider is quick, not named), and nothing throws", async () => {
      isolateStateDir();
      const root = makeTmpDir("daemon-repair-quick-ws");
      tmpDirs.push(root);
      const workspace = new Workspace(root);
      chooseQuickTunnel(workspace.id);

      bridgeRoots.push(root);
      const repairResult = await attemptNamedFallbackRepair(root);
      expect(repairResult.repaired).toBe(false);
      expect(repairResult.info.tunnel.provider).toBe("cloudflare-quick");
      expect(repairResult.info.tunnel.running).toBe(true);
      expect(repairResult.info.tunnel.url).toMatch(/^https:\/\//);
    }, 40_000);
  }
);
