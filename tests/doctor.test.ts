import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { runCli } from "../src/cli/index.js";
import type { AdminInfo } from "../src/process/daemon.js";
import { readRuntimeState, writeRuntimeState } from "../src/bridge/runtime.js";
import { writeLastEndpoint } from "../src/config/endpoint.js";
import type { TunnelProvider, TunnelStatus, TunnelDoctorReport } from "../src/tunnel/provider.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

async function adminInfo(bridge: Bridge): Promise<AdminInfo> {
  const response = await fetch(`${bridge.localBaseUrl()}/admin/info`, {
    headers: { Authorization: `Bearer ${bridge.adminToken}` },
  });
  return (await response.json()) as AdminInfo;
}

// Connector reliability hardening, ITERATION 1 (P0-1 through P0-4, P1-5).
// These run `doctor --json` through the real, exported `runCli()` against a
// real bridge -- the same pattern tests/runtime.test.ts uses for `status` --
// so they exercise the actual CLI action, not a reimplementation of it.

async function startRealBridge(name: string): Promise<Bridge> {
  const root = makeTmpDir(name);
  write(root, "a.txt", "a");
  return startBridge({
    workspaceRoot: root,
    port: 0,
    persistRuntime: true,
    authStoreFile: path.join(makeTmpDir(`${name}-auth`), "store.json"),
  });
}

async function runDoctorJson(root: string, extraArgs: string[] = []): Promise<Record<string, unknown>> {
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

/** Same as runDoctorJson but without --json -- for asserting on the
 *  human-readable summary line itself (P0-4 regression below). */
async function runDoctorText(root: string, extraArgs: string[] = []): Promise<string> {
  const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    await runCli(["node", "c2c", "doctor", "-w", root, "--agent", "claude-code", ...extraArgs]);
    return writeSpy.mock.calls.map((call) => String(call[0])).join("");
  } finally {
    writeSpy.mockRestore();
    process.exitCode = 0;
  }
}

/** Reports itself running/healthy at whatever URL is written into `urlBox`
 *  AFTER construction (the bridge's own port isn't known until it's already
 *  listening) -- letting doctor's own real `fetch(currentUrl + "/health")`
 *  health check succeed for real, without any actual external network use,
 *  by pointing "the public URL" at the bridge's own loopback address. */
class LoopbackHealthyTunnel implements TunnelProvider {
  readonly name = "cloudflare-quick";
  private url: string | null = null;
  constructor(private readonly urlBox: { current: string | null }) {}
  async start(): Promise<string> {
    if (!this.urlBox.current) throw new Error("loopback url not set yet");
    this.url = this.urlBox.current;
    return this.url;
  }
  async stop(): Promise<void> {
    this.url = null;
  }
  async restart(): Promise<string> {
    return this.start();
  }
  status(): TunnelStatus {
    return { running: this.url !== null, url: this.url, provider: this.name };
  }
  getPublicUrl(): string | null {
    return this.url;
  }
  async doctor(): Promise<TunnelDoctorReport> {
    return { provider: this.name, binaryFound: true, binaryPath: null, running: this.url !== null, url: this.url, problems: [] };
  }
}

describe("doctor: LOCAL / REMOTE separation (P0-1, P0-2)", () => {
  it("always reports remote.connectorState as the literal 'unconfirmed', never inferred", async () => {
    isolateStateDir();
    const bridge = await startRealBridge("doctor-remote");
    try {
      const result = await runDoctorJson(bridge.workspace.root);
      expect(result.remote).toMatchObject({
        connectorState: "unconfirmed",
        connectorStateNote: expect.stringContaining("cannot observe"),
      });
    } finally {
      await bridge.close();
      cleanup(bridge.workspace.root);
    }
  });
});

describe("doctor: destructive-repair authorization is decoupled from chatgptRepair.needed (P0-4)", () => {
  it("keeps destructiveConnectorRepairAuthorized false even while chatgptRepair.needed is true (address reclaimed)", async () => {
    isolateStateDir();
    const bridge = await startRealBridge("doctor-destructive");
    try {
      // Simulate a workspace that previously had a public URL, so doctor's
      // existing address-reclaim detection fires (chatgptRepair.needed=true,
      // reason="address_reclaimed") without needing a real cloudflared tunnel.
      writeLastEndpoint({
        workspaceId: bridge.workspace.id,
        port: bridge.port,
        publicUrl: "https://old-tunnel.example.invalid",
        mcpUrl: "https://old-tunnel.example.invalid/mcp",
        connectorName: "Codex with ChatGPT · doctor-destructive",
      });

      // --no-fix: this test asserts diagnostic reporting, not repair
      // execution -- skips the real cloudflared tunnel-start attempt that
      // `expectedPublic` would otherwise trigger, which is slow and depends
      // on real network/Cloudflare-edge access.
      const result = await runDoctorJson(bridge.workspace.root, ["--no-fix"]);

      expect((result.chatgptRepair as { needed: boolean; reason?: string }).needed).toBe(true);
      expect((result.chatgptRepair as { needed: boolean; reason?: string }).reason).toBe("address_reclaimed");
      // The one property this iteration exists to guarantee: a true,
      // non-destructive chatgptRepair.needed must never imply destructive
      // authorization. This flag stays false regardless.
      expect(result.destructiveConnectorRepairAuthorized).toBe(false);
      expect(result.destructiveConnectorRepairNote).toEqual(expect.stringContaining("Always false"));
    } finally {
      await bridge.close();
      cleanup(bridge.workspace.root);
    }
  });

  it("is false on a plain healthy workspace with nothing to repair at all", async () => {
    isolateStateDir();
    const bridge = await startRealBridge("doctor-destructive-clean");
    try {
      const result = await runDoctorJson(bridge.workspace.root);
      expect((result.chatgptRepair as { needed: boolean }).needed).toBe(false);
      expect(result.destructiveConnectorRepairAuthorized).toBe(false);
    } finally {
      await bridge.close();
      cleanup(bridge.workspace.root);
    }
  });
});

describe("doctor: authorized MCP round trip via a self-test token (P0-3)", () => {
  it("succeeds with a STRUCTURED scope:'local' field, and never contaminates hasUsableAuthorization/tokenCount", async () => {
    isolateStateDir();
    const bridge = await startRealBridge("doctor-mcp-auth");
    try {
      const before = await adminInfo(bridge);
      expect(before.tokenCount).toBe(0);
      expect(before.hasUsableAuthorization).toBe(false);

      const result = await runDoctorJson(bridge.workspace.root);
      const mcpAuthenticated = (result.report as Record<string, { ok: boolean; detail?: string; scope?: string }>)
        .mcpAuthenticated;
      expect(mcpAuthenticated.ok).toBe(true);
      // Independent review (2026-09-03) flagged that `scope: "local"` living
      // only inside the free-text `detail` string lets a consumer checking
      // just `.ok` conflate this with a remote (ChatGPT-reachable) result.
      // It must be a structured field, not prose.
      expect(mcpAuthenticated.scope).toBe("local");

      // A local-only authorized round trip must never be confused with an
      // actual remote (ChatGPT-side) confirmation -- assert both together so
      // this distinction can never silently drift apart.
      expect((result.remote as { connectorState: string }).connectorState).toBe("unconfirmed");

      // The exact signal doctor's own self-test round trip must never move.
      const after = await adminInfo(bridge);
      expect(after.tokenCount).toBe(0);
      expect(after.hasUsableAuthorization).toBe(false);
    } finally {
      await bridge.close();
      cleanup(bridge.workspace.root);
    }
  });

  it("keeps the legacy `oauth` field byte-for-byte while adding `authMiddleware` alongside it (backward compatibility)", async () => {
    isolateStateDir();
    const bridge = await startRealBridge("doctor-oauth-compat");
    try {
      const result = await runDoctorJson(bridge.workspace.root);
      const report = result.report as Record<string, { ok: boolean; detail?: string }>;
      expect(report.oauth).toEqual({ ok: true });
      expect(report.authMiddleware.ok).toBe(true);
    } finally {
      await bridge.close();
      cleanup(bridge.workspace.root);
    }
  });
});

describe("doctor: version/schema drift against an already-running bridge (P1-5)", () => {
  it("flags versionDrift and schemaDrift when the persisted runtime file predates the current build", async () => {
    isolateStateDir();
    const bridge = await startRealBridge("doctor-drift");
    try {
      const live = readRuntimeState(bridge.workspace.id);
      if (!live) throw new Error("expected a persisted runtime file for a just-started bridge");

      // The live process keeps answering health checks correctly (real pid,
      // real port, real adminToken) -- only the ON-DISK bookkeeping is made
      // to look like it was written by an older build, exactly as found live
      // during the connector reliability audit (2 of 3 running bridges
      // predated the `generation` field).
      const { generation: _drop, ...withoutGeneration } = live;
      writeRuntimeState({ ...withoutGeneration, version: "0.0.1-old" } as unknown as typeof live);

      const result = await runDoctorJson(bridge.workspace.root);
      expect(result.versionInfo).toMatchObject({
        runtimeVersion: "0.0.1-old",
        versionDrift: true,
        schemaDrift: true,
      });
      const bridgeReport = (result.report as Record<string, { ok: boolean; detail?: string }>).bridge;
      expect(bridgeReport.detail).toEqual(expect.stringContaining("0.0.1-old"));
    } finally {
      await bridge.close();
      cleanup(bridge.workspace.root);
    }
  });

  it("reports no drift for a freshly started bridge", async () => {
    isolateStateDir();
    const bridge = await startRealBridge("doctor-no-drift");
    try {
      const result = await runDoctorJson(bridge.workspace.root);
      expect(result.versionInfo).toMatchObject({ versionDrift: false, schemaDrift: false });
    } finally {
      await bridge.close();
      cleanup(bridge.workspace.root);
    }
  });
});

// Independent review (ChatGPT, via the real C2C connector, iteration 3,
// 2026-09-03) found that even after the destructiveConnectorRepairAuthorized
// contract was added, chatgptRepair.needed ALONE (without checking
// chatgptRepair.reason) still drove the destructive "delete and re-add the
// connector" instruction in doctor's own human-readable summary line, and in
// several places across both SKILL.md docs. These pin the fix at the code
// level: only reason === "address_reclaimed" gets the destructive wording;
// every other chatgptRepair.needed case gets a non-destructive one.
describe("doctor: chatgptRepair.needed alone never implies destructive authorization (P0-4 regression, iteration 3)", () => {
  it("does not tell the user to delete/recreate when needed=true but reason is NOT address_reclaimed (connectorRepairPending only)", async () => {
    isolateStateDir();
    const root = makeTmpDir("doctor-repair-pending");
    write(root, "a.txt", "a");
    const urlBox: { current: string | null } = { current: null };
    const bridge = await startBridge({
      workspaceRoot: root,
      port: 0,
      persistRuntime: true,
      authStoreFile: path.join(makeTmpDir("doctor-repair-pending-auth"), "store.json"),
      tunnelProvider: new LoopbackHealthyTunnel(urlBox),
    });
    try {
      // Point "the public URL" at the bridge's own loopback address so
      // doctor's real health check succeeds without any real network use.
      urlBox.current = bridge.localBaseUrl();
      const startResponse = await fetch(`${bridge.localBaseUrl()}/admin/tunnel/start`, {
        method: "POST",
        headers: { Authorization: `Bearer ${bridge.adminToken}` },
      });
      expect(startResponse.status).toBe(200);

      // No lastEndpoint recorded yet -> connectorAction is "create", not
      // "update", so chatgptRepair.reason stays undefined -- but no
      // connector-confirmation round trip has ever happened either, so
      // connectorRepairPending (and therefore needed) is true.
      const json = await runDoctorJson(root, ["--no-fix"]);
      const chatgptRepair = json.chatgptRepair as {
        needed: boolean;
        reason?: string;
        connectorRepairPending: boolean;
      };
      expect(chatgptRepair.needed).toBe(true);
      expect(chatgptRepair.reason).toBeUndefined();
      expect(chatgptRepair.connectorRepairPending).toBe(true);
      expect(json.destructiveConnectorRepairAuthorized).toBe(false);

      const text = await runDoctorText(root, ["--no-fix"]);
      expect(text).not.toMatch(/删除并重新添加/);
      expect(text).toMatch(/unconfirmed/);
    } finally {
      await bridge.close();
      cleanup(root);
    }
  });

  it("still tells the user to delete/recreate when reason IS address_reclaimed (existing self-heal path unaffected)", async () => {
    isolateStateDir();
    const bridge = await startRealBridge("doctor-address-reclaimed");
    try {
      writeLastEndpoint({
        workspaceId: bridge.workspace.id,
        port: bridge.port,
        publicUrl: "https://old-tunnel.example.invalid",
        mcpUrl: "https://old-tunnel.example.invalid/mcp",
        connectorName: "Codex with ChatGPT · doctor-address-reclaimed",
      });

      const json = await runDoctorJson(bridge.workspace.root, ["--no-fix"]);
      const chatgptRepair = json.chatgptRepair as { needed: boolean; reason?: string };
      expect(chatgptRepair.needed).toBe(true);
      expect(chatgptRepair.reason).toBe("address_reclaimed");

      const text = await runDoctorText(bridge.workspace.root, ["--no-fix"]);
      expect(text).toMatch(/删除并重新添加/);
    } finally {
      await bridge.close();
      cleanup(bridge.workspace.root);
    }
  });
});
