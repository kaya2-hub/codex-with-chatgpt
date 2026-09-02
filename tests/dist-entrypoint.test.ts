import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensureBridge, stopBridge } from "../src/process/daemon.js";
import { attemptNamedFallbackRepair } from "../src/cli/index.js";
import { Workspace } from "../src/workspace/manager.js";
import { probeBridge } from "../src/bridge/runtime.js";
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
