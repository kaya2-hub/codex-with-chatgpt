import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import { startBridge } from "../src/bridge/server.js";
import {
  findBridgeObservation,
  findLiveBridge,
  readRuntimeState,
  writeRuntimeState,
  type RuntimeState,
} from "../src/bridge/runtime.js";
import { ensureBridge, stopBridge } from "../src/process/daemon.js";
import { runCli } from "../src/cli/index.js";
import { SERVICE_NAME, VERSION } from "../src/version.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

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

describe("findBridgeObservation", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  it("treats a missing runtime file as stopped", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-missing");
    dirs.push(root);
    write(root, "a.txt", "a");
    const workspace = new Workspace(root);
    const observation = await findBridgeObservation(workspace.id);
    expect(observation.state).toBe("stopped");
    if (observation.state === "stopped") expect(observation.reason).toBe("runtime_missing");
    expect(await findLiveBridge(workspace.id)).toBeNull();
  });

  it("treats a dead pid plus a failed probe as stopped", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-dead");
    dirs.push(root);
    write(root, "a.txt", "a");
    const workspace = new Workspace(root);
    writeRuntimeState(stubRuntime(workspace.id, workspace.root, 999_999_999, 1));
    const observation = await findBridgeObservation(workspace.id);
    expect(observation.state).toBe("stopped");
    if (observation.state === "stopped") expect(observation.reason).toBe("pid_missing");
    expect(await findLiveBridge(workspace.id)).toBeNull();
  });

  it("does not treat a live pid plus a failed probe as stopped", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-unknown");
    dirs.push(root);
    write(root, "a.txt", "a");
    const workspace = new Workspace(root);
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      detached: true,
    });
    child.unref();
    try {
      if (!child.pid) throw new Error("failed to spawn helper");
      writeRuntimeState(stubRuntime(workspace.id, workspace.root, child.pid, 1));
      const observation = await findBridgeObservation(workspace.id);
      expect(observation.state).toBe("unknown");
      if (observation.state === "unknown") expect(observation.reason).toBe("probe_failed");
      expect(await findLiveBridge(workspace.id)).toBeNull();
      await expect(ensureBridge(root)).rejects.toThrow(/uncertain/);
    } finally {
      if (child.pid) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          /* ignore */
        }
      }
    }
  });

  it("reports healthy when the local bridge answers", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-live");
    dirs.push(root);
    write(root, "a.txt", "a");
    const auth = path.join(makeTmpDir("obs-auth"), "store.json");
    dirs.push(path.dirname(auth));
    const bridge = await startBridge({
      workspaceRoot: root,
      port: 0,
      persistRuntime: true,
      authStoreFile: auth,
    });
    try {
      const observation = await findBridgeObservation(bridge.workspace.id);
      expect(observation.state).toBe("healthy");
      expect(await findLiveBridge(bridge.workspace.id)).not.toBeNull();
    } finally {
      await bridge.close();
    }
  });
});

// Regression coverage for the real incident this "stale" state exists to
// self-heal from: workspace A's bridge died without reaching its graceful
// shutdown (which would have cleared its own runtime file); the OS later
// handed that exact port to workspace B's fresh bridge; A's runtime file
// still pointed at it. `doctor`/`start`/`restart` must repair A safely --
// and never so much as glance at, let alone signal or shut down, B's live
// bridge -- while the genuinely ambiguous case (A's recorded pid is still
// alive; on all evidence so far this only happens when the OS has handed
// that pid to some unrelated program) must keep refusing to auto-repair.
describe("stale bridge state: dead pid, port reclaimed by a different live workspace", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  async function startRealBridge(name: string) {
    const root = makeTmpDir(name);
    dirs.push(root);
    write(root, "a.txt", "a");
    const auth = path.join(makeTmpDir(`${name}-auth`), "store.json");
    dirs.push(path.dirname(auth));
    return startBridge({ workspaceRoot: root, port: 0, persistRuntime: true, authStoreFile: auth });
  }

  function makeStaleWorkspace(name: string, deadPid: number, portOwnedByOther: number): Workspace {
    const root = makeTmpDir(name);
    dirs.push(root);
    write(root, "a.txt", "a");
    const workspace = new Workspace(root);
    writeRuntimeState(stubRuntime(workspace.id, workspace.root, deadPid, portOwnedByOther));
    return workspace;
  }

  it("classifies as stale (not unknown) when the recorded pid is dead and the port now answers as a different live workspace", async () => {
    dirs.push(isolateStateDir());
    const other = await startRealBridge("stale-classify-other");
    try {
      const mine = makeStaleWorkspace("stale-classify-mine", 999_999_999, other.port);

      const observation = await findBridgeObservation(mine.id);
      expect(observation.state).toBe("stale");
      if (observation.state === "stale") expect(observation.reason).toBe("dead_pid_port_reclaimed_elsewhere");

      // Merely observing this must never itself touch the other workspace.
      const otherObservation = await findBridgeObservation(other.workspace.id);
      expect(otherObservation.state).toBe("healthy");
    } finally {
      await other.close();
    }
  });

  it("stays unknown (refuses to auto-repair) when the recorded pid is still alive, even though the port also mismatches", async () => {
    dirs.push(isolateStateDir());
    const other = await startRealBridge("stale-danger-other");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
    child.unref();
    try {
      if (!child.pid) throw new Error("failed to spawn helper");
      const mine = makeStaleWorkspace("stale-danger-mine", child.pid, other.port);

      const observation = await findBridgeObservation(mine.id);
      expect(observation.state).toBe("unknown");
      if (observation.state === "unknown") expect(observation.reason).toBe("workspace_mismatch");

      await expect(ensureBridge(mine.root)).rejects.toThrow(/uncertain/);

      // The one property that actually matters: stopBridge must never
      // signal a pid it can't verify. The dummy process (standing in for
      // an unrelated program that happened to reuse this pid) must survive.
      const stopped = await stopBridge(mine.root);
      expect(stopped).toBe(false);
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
    } finally {
      await other.close();
      if (child.pid) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
  });

  it("ensureBridge reclaims a stale workspace onto a fresh port, and never touches the other workspace's live bridge", async () => {
    dirs.push(isolateStateDir());
    const other = await startRealBridge("stale-reclaim-other");
    let reclaimedRoot: string | null = null;
    try {
      const mine = makeStaleWorkspace("stale-reclaim-mine", 999_999_999, other.port);
      const staleGeneration = readRuntimeState(mine.id)?.generation;
      reclaimedRoot = mine.root;

      const result = await ensureBridge(mine.root);
      expect(result.spawned).toBe(true);
      expect(result.runtime.workspaceId).toBe(mine.id);
      expect(result.runtime.port).not.toBe(other.port);
      // Proves this is a genuinely new instance, not the stale record with
      // its port field merely patched up.
      expect(result.runtime.generation).not.toBe(staleGeneration);

      // The other workspace must still be the exact same live instance --
      // reclaiming never shuts it down or replaces it.
      const otherObservation = await findBridgeObservation(other.workspace.id);
      expect(otherObservation.state).toBe("healthy");
      if (otherObservation.state === "healthy") expect(otherObservation.runtime.port).toBe(other.port);
    } finally {
      if (reclaimedRoot) await stopBridge(reclaimedRoot).catch(() => undefined);
      await other.close();
    }
  });

  it("stopBridge on a stale workspace just drops the stale pointer -- never signals anything, never touches the other workspace", async () => {
    dirs.push(isolateStateDir());
    const other = await startRealBridge("stale-stop-other");
    try {
      const mine = makeStaleWorkspace("stale-stop-mine", 999_999_999, other.port);

      const stopped = await stopBridge(mine.root);
      expect(stopped).toBe(true);
      expect(readRuntimeState(mine.id)).toBeNull();

      const otherObservation = await findBridgeObservation(other.workspace.id);
      expect(otherObservation.state).toBe("healthy");
    } finally {
      await other.close();
    }
  });

  // Regression for the gap ChatGPT's independent review found: `c2c status`
  // is a SEPARATE findBridgeObservation consumer from doctor/ensureBridge/
  // stopBridge, and originally handled only "unknown" and "stopped" before
  // falling through to adminFetch(observation.runtime, ...) -- which, for a
  // stale A, would have sent an admin request carrying A's token to B's
  // bridge (identified by A's stale runtime.port). Uses the real `status`
  // CLI action via the exported runCli() (safe to call in-process -- it
  // uses process.exitCode, never process.exit(), specifically for this).
  it("`c2c status --json` on a stale workspace reports stale without ever calling the other workspace's admin API", async () => {
    dirs.push(isolateStateDir());
    const other = await startRealBridge("stale-status-other");
    const adminFetchSpy = vi.spyOn(global, "fetch");
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const mine = makeStaleWorkspace("stale-status-mine", 999_999_999, other.port);

      await runCli(["node", "c2c", "status", "-w", mine.root, "--json"]);

      const printed = writeSpy.mock.calls.map((call) => String(call[0])).join("");
      const parsed = JSON.parse(printed.trim());
      expect(parsed).toMatchObject({ ok: false, running: false, state: "stale" });

      // The only fetch calls allowed here are the health probe (findBridgeObservation
      // itself, GET .../health) -- never an authenticated /admin/* call, which
      // is the one that would actually reach and act on the other workspace.
      const adminCalls = adminFetchSpy.mock.calls.filter((call) => String(call[0]).includes("/admin/"));
      expect(adminCalls).toHaveLength(0);

      const otherObservation = await findBridgeObservation(other.workspace.id);
      expect(otherObservation.state).toBe("healthy");
    } finally {
      writeSpy.mockRestore();
      adminFetchSpy.mockRestore();
      process.exitCode = 0;
      await other.close();
    }
  });
});
