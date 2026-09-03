import { describe, it, expect, vi } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { runCli } from "../src/cli/index.js";
import { findBridgeObservation, readRuntimeState, writeRuntimeState, type RuntimeState } from "../src/bridge/runtime.js";
import { stopBridge } from "../src/process/daemon.js";
import { SERVICE_NAME, VERSION } from "../src/version.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

// P2-7 (connector reliability hardening): fault injection through the REAL
// `doctor` / `doctor --fix` CLI action (via runCli), not just the daemon.ts/
// runtime.ts functions those actions call -- complements the function-level
// coverage in tests/runtime.test.ts and the P0/P1 coverage in
// tests/doctor.test.ts. Every scenario that involves a second ("other")
// workspace asserts it is completely unaffected.

async function runDoctor(root: string, extraArgs: string[] = []): Promise<Record<string, unknown>> {
  const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    await runCli(["node", "c2c", "doctor", "-w", root, "--agent", "claude-code", "--json", ...extraArgs]);
    const printed = writeSpy.mock.calls.map((call) => String(call[0])).join("");
    return JSON.parse(printed.trim()) as Record<string, unknown>;
  } finally {
    writeSpy.mockRestore();
    process.exitCode = 0;
  }
}

function stubRuntime(workspaceId: string, workspaceRoot: string, pid: number, port: number): RuntimeState {
  return {
    service: SERVICE_NAME,
    version: VERSION,
    workspaceId,
    workspaceRoot,
    pid,
    port,
    adminToken: "test-token",
    publicUrl: null,
    startedAt: new Date().toISOString(),
    generation: `stub-${Math.random().toString(36).slice(2)}`,
  };
}

async function startOtherBridge(name: string): Promise<Bridge> {
  const root = makeTmpDir(name);
  write(root, "a.txt", "a");
  return startBridge({
    workspaceRoot: root,
    port: 0,
    persistRuntime: true,
    authStoreFile: path.join(makeTmpDir(`${name}-auth`), "store.json"),
  });
}

describe("doctor fault injection: bridge stopped", () => {
  it("reports stopped with no --fix, and doctor --fix starts a real bridge", async () => {
    isolateStateDir();
    const root = makeTmpDir("fault-stopped");
    write(root, "a.txt", "a");
    try {
      const before = await runDoctor(root, ["--no-fix"]);
      expect((before.report as Record<string, { ok: boolean; detail?: string }>).bridge).toMatchObject({
        ok: false,
        detail: "未运行",
      });

      const after = await runDoctor(root);
      expect((after.report as Record<string, { ok: boolean }>).bridge.ok).toBe(true);

      const workspace = new Workspace(root);
      const observation = await findBridgeObservation(workspace.id);
      expect(observation.state).toBe("healthy");
    } finally {
      await stopBridge(root).catch(() => undefined);
      cleanup(root);
    }
  }, 30_000);
});

describe("doctor fault injection: stale runtime (dead PID, port reclaimed by another live workspace)", () => {
  it("doctor (no --fix) reports stale without repairing; doctor --fix repairs safely and never touches the other workspace", async () => {
    isolateStateDir();
    const other = await startOtherBridge("fault-stale-other");
    const mineRoot = makeTmpDir("fault-stale-mine");
    write(mineRoot, "a.txt", "a");
    let repaired = false;
    try {
      const mineWorkspace = new Workspace(mineRoot);
      writeRuntimeState(stubRuntime(mineWorkspace.id, mineWorkspace.root, 999_999_999, other.port));

      const otherPidBefore = readRuntimeState(other.workspace.id)?.pid;
      const otherGenerationBefore = readRuntimeState(other.workspace.id)?.generation;

      const noFix = await runDoctor(mineRoot, ["--no-fix"]);
      expect((noFix.report as Record<string, { ok: boolean; detail?: string }>).bridge.detail).toMatch(/合法占用/);
      // Read-only check must not have touched the other workspace at all.
      const otherStillSame = await findBridgeObservation(other.workspace.id);
      expect(otherStillSame.state).toBe("healthy");
      if (otherStillSame.state === "healthy") expect(otherStillSame.runtime.port).toBe(other.port);

      const fixed = await runDoctor(mineRoot);
      repaired = true;
      expect((fixed.report as Record<string, { ok: boolean }>).bridge.ok).toBe(true);
      const mineObservation = await findBridgeObservation(mineWorkspace.id);
      expect(mineObservation.state).toBe("healthy");
      if (mineObservation.state === "healthy") expect(mineObservation.runtime.port).not.toBe(other.port);

      // The other workspace's bridge is still the exact same live instance --
      // same pid, same generation, same port -- never restarted or replaced.
      const otherAfter = await findBridgeObservation(other.workspace.id);
      expect(otherAfter.state).toBe("healthy");
      if (otherAfter.state === "healthy") {
        expect(otherAfter.runtime.port).toBe(other.port);
        expect(otherAfter.runtime.pid).toBe(otherPidBefore);
        expect(otherAfter.runtime.generation).toBe(otherGenerationBefore);
      }
    } finally {
      if (repaired) await stopBridge(mineRoot).catch(() => undefined);
      await other.close();
      cleanup(mineRoot);
    }
  }, 30_000);
});

describe("doctor fault injection: workspace mismatch (live PID, different workspace answers)", () => {
  it("doctor --fix still refuses to repair (unknown), and never signals the live process or the other workspace", async () => {
    isolateStateDir();
    const other = await startOtherBridge("fault-mismatch-other");
    const mineRoot = makeTmpDir("fault-mismatch-mine");
    write(mineRoot, "a.txt", "a");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
    child.unref();
    try {
      if (!child.pid) throw new Error("failed to spawn helper process");
      const mineWorkspace = new Workspace(mineRoot);
      writeRuntimeState(stubRuntime(mineWorkspace.id, mineWorkspace.root, child.pid, other.port));

      const otherBefore = readRuntimeState(other.workspace.id);

      const fixed = await runDoctor(mineRoot);
      expect((fixed.report as Record<string, { ok: boolean; detail?: string }>).bridge.detail).toMatch(/无法确认/);

      // The unrelated live process must survive -- doctor must never signal
      // a pid it can't verify as its own bridge.
      expect(() => process.kill(child.pid!, 0)).not.toThrow();

      // Full identity check, not just port -- pid and generation must be
      // byte-identical too (independent review, iteration 7).
      const otherObservation = await findBridgeObservation(other.workspace.id);
      expect(otherObservation.state).toBe("healthy");
      if (otherObservation.state === "healthy") {
        expect(otherObservation.runtime.port).toBe(otherBefore?.port);
        expect(otherObservation.runtime.pid).toBe(otherBefore?.pid);
        expect(otherObservation.runtime.generation).toBe(otherBefore?.generation);
      }
    } finally {
      if (child.pid) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      await other.close();
      cleanup(mineRoot);
    }
  }, 30_000);
});

describe("doctor fault injection: version/schema drift is purely observational", () => {
  it("doctor --fix does not restart a healthy-but-drifted bridge just because of the drift", async () => {
    isolateStateDir();
    const root = makeTmpDir("fault-drift");
    write(root, "a.txt", "a");
    try {
      const started = await runDoctor(root); // spawns a real bridge
      const workspace = new Workspace(root);
      const live = readRuntimeState(workspace.id);
      if (!live) throw new Error("expected a persisted runtime file");
      const pidBefore = live.pid;
      const portBefore = live.port;

      const { generation: _drop, ...withoutGeneration } = live;
      writeRuntimeState({ ...withoutGeneration, version: "0.0.1-old" } as unknown as typeof live);

      const afterDrift = await runDoctor(root);
      expect(afterDrift.versionInfo).toMatchObject({ versionDrift: true, schemaDrift: true });

      // Purely observational: the SAME process is still running, drift
      // detection never triggered a restart by itself.
      const liveAfter = readRuntimeState(workspace.id);
      expect(liveAfter?.pid).toBe(pidBefore);
      expect(liveAfter?.port).toBe(portBefore);
      void started;
    } finally {
      await stopBridge(root).catch(() => undefined);
      cleanup(root);
    }
  }, 30_000);
});

describe("doctor fault injection: doctor --fix is idempotent on an already-healthy bridge", () => {
  it("running doctor --fix twice in a row causes no restart / no side effects", async () => {
    isolateStateDir();
    const root = makeTmpDir("fault-idempotent");
    write(root, "a.txt", "a");
    try {
      await runDoctor(root);
      const workspace = new Workspace(root);
      const first = readRuntimeState(workspace.id);

      await runDoctor(root);
      const second = readRuntimeState(workspace.id);

      expect(second?.pid).toBe(first?.pid);
      expect(second?.port).toBe(first?.port);
      expect(second?.generation).toBe(first?.generation);
    } finally {
      await stopBridge(root).catch(() => undefined);
      cleanup(root);
    }
  }, 30_000);
});
