import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import path from "node:path";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { readConnectorConfirmation, isConnectorRepairPending } from "../src/config/connectorConfirmation.js";
import type { TunnelProvider, TunnelStatus, TunnelDoctorReport } from "../src/tunnel/provider.js";
import { imonikaiStatus, attemptNamedFallbackRepair, type AdminInfo } from "../src/cli/index.js";
import { Workspace } from "../src/workspace/manager.js";
import { writeTunnelState } from "../src/tunnel/state.js";
import { findLiveBridge, type RuntimeState } from "../src/bridge/runtime.js";
import { makeTmpDir, cleanup, isolateStateDir, pkceVerifierAndChallenge } from "./helpers.js";

/** `fetch()` refuses to let callers override the Host header (Node/undici
 *  silently replaces it with the real connection target) — there is no way
 *  to simulate "this request's Host header names the public tunnel
 *  hostname" through it. `node:http` has no such restriction: it connects
 *  to `hostname`/`port` but sends whatever `Host` (and other) headers are
 *  given, exactly like a real reverse proxy (cloudflared) forwarding a
 *  request whose original Host was the public hostname to our loopback
 *  bridge. Used to test that connector-confirmation only fires when a
 *  request's OWN observed origin matches the public URL — not merely
 *  because a public URL happens to be configured. */
function postForm(
  base: string,
  urlPath: string,
  body: URLSearchParams,
  opts?: { hostHeader?: string; forwardedProto?: string }
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const url = new URL(base);
    const payload = body.toString();
    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
      "content-length": Buffer.byteLength(payload).toString(),
    };
    if (opts?.hostHeader) headers.Host = opts.hostHeader;
    if (opts?.forwardedProto) headers["x-forwarded-proto"] = opts.forwardedProto;
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: urlPath, method: "POST", headers },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data ? JSON.parse(data) : {} });
        });
      }
    );
    req.on("error", reject);
    req.end(payload);
  });
}

const REDIRECT_URI = "http://127.0.0.1:19998/callback";

class FakeTunnel implements TunnelProvider {
  readonly name: string;
  private url: string | null = null;
  private readonly fixedUrl: string;
  private readonly failStart: boolean;

  constructor(opts: { name: string; url: string; failStart?: boolean }) {
    this.name = opts.name;
    this.fixedUrl = opts.url;
    this.failStart = opts.failStart ?? false;
  }

  async start(): Promise<string> {
    if (this.failStart) throw new Error("cloudflared exited before establishing the named tunnel");
    this.url = this.fixedUrl;
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

const openBridges: Bridge[] = [];
const tmpDirs: string[] = [];

afterEach(async () => {
  while (openBridges.length) await openBridges.pop()!.close();
  while (tmpDirs.length) cleanup(tmpDirs.pop()!);
});

async function newBridge(tunnelProvider: TunnelProvider, quickFallbackProvider?: () => TunnelProvider): Promise<Bridge> {
  isolateStateDir();
  const root = makeTmpDir("confirm-ws");
  tmpDirs.push(root);
  const authDir = makeTmpDir("confirm-auth");
  tmpDirs.push(authDir);
  const bridge = await startBridge({
    workspaceRoot: root,
    port: 0,
    persistRuntime: false,
    authStoreFile: path.join(authDir, "store.json"),
    tunnelProvider,
    quickFallbackProvider: quickFallbackProvider ? () => quickFallbackProvider() : undefined,
  });
  openBridges.push(bridge);
  return bridge;
}

/** Runs pairing/authorize as normal (always over loopback — irrelevant to
 *  confirmation, which only looks at the /oauth/token request), then the
 *  final token exchange either over plain loopback (default — simulates a
 *  request that never actually traveled through the public tunnel) or
 *  with a Host/X-Forwarded-Proto override simulating one that genuinely
 *  arrived via the public origin (pass `tokenRequestOrigin`). */
async function completeOAuthRoundTrip(
  bridge: Bridge,
  base: string,
  tokenRequestOrigin?: { hostHeader: string; forwardedProto: string }
): Promise<void> {
  const registration = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Test", redirect_uris: [REDIRECT_URI] }),
  });
  const { client_id: clientId } = (await registration.json()) as { client_id: string };
  const { verifier, challenge } = pkceVerifierAndChallenge();

  const authorizeUrl = new URL(`${base}/oauth/authorize`);
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  const pageResponse = await fetch(authorizeUrl, { redirect: "manual" });
  const html = await pageResponse.text();
  const requestId = html.match(/name="request_id" value="([a-f0-9]+)"/)?.[1];
  if (!requestId) throw new Error("no request_id in pairing page");

  const pairing = bridge.pairing.create();
  const postResponse = await fetch(`${base}/oauth/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ request_id: requestId, pairing_code: pairing.code }),
    redirect: "manual",
  });
  const location = postResponse.headers.get("location");
  const code = location ? new URL(location).searchParams.get("code") : null;
  if (!code) throw new Error("no authorization code issued");

  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
  });

  if (tokenRequestOrigin) {
    const result = await postForm(base, "/oauth/token", tokenBody, {
      hostHeader: tokenRequestOrigin.hostHeader,
      forwardedProto: tokenRequestOrigin.forwardedProto,
    });
    expect(result.status).toBe(200);
  } else {
    const tokenResponse = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenBody,
    });
    expect(tokenResponse.status).toBe(200);
  }
}

describe("connector confirmation (P1-2: desired vs. confirmed connector endpoint)", () => {
  it("has no confirmation yet, and repair is pending, before any OAuth round trip completes", async () => {
    const bridge = await newBridge(new FakeTunnel({ name: "cloudflare-named", url: "https://one.example.com" }));
    expect(readConnectorConfirmation(bridge.workspace.id)).toBeNull();
    expect(isConnectorRepairPending("https://one.example.com/mcp", bridge.workspace.id)).toBe(true);
  });

  it("records a confirmation only once a token request whose OWN origin matches the current public URL succeeds", async () => {
    const bridge = await newBridge(new FakeTunnel({ name: "cloudflare-named", url: "https://two.example.com" }));
    const base = bridge.localBaseUrl();
    const startResponse = await fetchAdmin(bridge, "/admin/tunnel/start");
    expect(startResponse.status).toBe(200);

    // Writing local desired state is NOT enough — merely starting the
    // tunnel must not itself count as "ChatGPT connected".
    expect(isConnectorRepairPending("https://two.example.com/mcp", bridge.workspace.id)).toBe(true);
    expect(readConnectorConfirmation(bridge.workspace.id)).toBeNull();

    // The token request itself must arrive AS IF via the public origin
    // (Host + X-Forwarded-Proto matching it) — exactly what cloudflared
    // forwards for a request that genuinely came in through the tunnel.
    await completeOAuthRoundTrip(bridge, base, { hostHeader: "two.example.com", forwardedProto: "https" });

    const confirmation = readConnectorConfirmation(bridge.workspace.id);
    expect(confirmation?.confirmedMcpUrl).toBe("https://two.example.com/mcp");
    expect(isConnectorRepairPending("https://two.example.com/mcp", bridge.workspace.id)).toBe(false);
  });

  it("regression: a token exchange that only ever traveled over loopback must NOT confirm the public URL", async () => {
    // This exact scenario was the bug ChatGPT's independent review caught
    // in iteration 1: onAuthorizationCodeExchanged used to record whatever
    // publicBaseUrl was currently configured, regardless of what origin the
    // token request itself arrived on — so a token exchange done entirely
    // over loopback (a local admin call, an internal retry, or simply a
    // test hitting bridge.localBaseUrl()) would wrongly "confirm" a public
    // tunnel URL nothing ever actually reached.
    const bridge = await newBridge(new FakeTunnel({ name: "cloudflare-named", url: "https://five.example.com" }));
    const base = bridge.localBaseUrl();
    await fetchAdmin(bridge, "/admin/tunnel/start");

    await completeOAuthRoundTrip(bridge, base); // no origin override -> plain loopback

    expect(readConnectorConfirmation(bridge.workspace.id)).toBeNull();
    expect(isConnectorRepairPending("https://five.example.com/mcp", bridge.workspace.id)).toBe(true);
  });

  it("still shows repair pending against a NEW desired URL even after an old URL was confirmed", async () => {
    const bridge = await newBridge(new FakeTunnel({ name: "cloudflare-named", url: "https://three.example.com" }));
    const base = bridge.localBaseUrl();
    await fetchAdmin(bridge, "/admin/tunnel/start");
    await completeOAuthRoundTrip(bridge, base, { hostHeader: "three.example.com", forwardedProto: "https" });
    expect(isConnectorRepairPending("https://three.example.com/mcp", bridge.workspace.id)).toBe(false);

    // The tunnel address changed (e.g. Quick Tunnel restarted with a new
    // random hostname) but ChatGPT has not reconnected yet — this must
    // read as repair-pending even though "a" confirmation exists on disk.
    expect(isConnectorRepairPending("https://four.example.com/mcp", bridge.workspace.id)).toBe(true);
  });

  it("does not confirm when the token request's origin names a DIFFERENT host than the current public URL", async () => {
    // Guards against a too-loose comparison (e.g. matching on protocol
    // alone, or substring matching) — an origin that simply isn't the
    // current public URL must never confirm it, even if it looks
    // superficially similar (same scheme, a plausible-looking hostname).
    const bridge = await newBridge(new FakeTunnel({ name: "cloudflare-named", url: "https://six.example.com" }));
    const base = bridge.localBaseUrl();
    await fetchAdmin(bridge, "/admin/tunnel/start");
    await completeOAuthRoundTrip(bridge, base, { hostHeader: "attacker.example.com", forwardedProto: "https" });
    expect(readConnectorConfirmation(bridge.workspace.id)).toBeNull();
    expect(isConnectorRepairPending("https://six.example.com/mcp", bridge.workspace.id)).toBe(true);
  });
});

describe("Named Tunnel start failure falls back to Quick Tunnel (P2-2)", () => {
  it("falls back to a working Quick Tunnel instead of leaving the workspace with no connection at all", async () => {
    const bridge = await newBridge(
      new FakeTunnel({ name: "cloudflare-named", url: "https://never.example.com", failStart: true }),
      () => new FakeTunnel({ name: "cloudflare-quick", url: "https://fallback.trycloudflare.com" })
    );
    const startResponse = await fetchAdmin(bridge, "/admin/tunnel/start");
    expect(startResponse.status).toBe(200);
    const body = (await startResponse.json()) as { url?: string; fallback?: boolean };
    expect(body.fallback).toBe(true);
    expect(body.url).toBe("https://fallback.trycloudflare.com");
    // The bridge's active tunnel provider actually swapped to the fallback
    // — /admin/info and /admin/tunnel/stop must act on it, not the dead
    // Named provider.
    expect(bridge.tunnel.name).toBe("cloudflare-quick");
  });

  it("surfaces a real 500 (never a silent partial success) when both Named and the fallback fail", async () => {
    const bridge = await newBridge(
      new FakeTunnel({ name: "cloudflare-named", url: "https://never.example.com", failStart: true }),
      () => new FakeTunnel({ name: "cloudflare-quick", url: "https://also-fails.example.com", failStart: true })
    );
    const startResponse = await fetchAdmin(bridge, "/admin/tunnel/start");
    expect(startResponse.status).toBe(500);
    const body = (await startResponse.json()) as { error?: string; message?: string };
    expect(body.error).toBe("tunnel_failed");
    expect(body.message).toMatch(/before establishing the named tunnel/);
  });
});

describe("imonikai status reflects the LIVE active tunnel provider, not just the persisted preference (issue 3)", () => {
  it("reports mode:quick, namedFallbackActive:true, and needsInit:true when Named is configured but Quick is actually running", async () => {
    // Simulates the exact state ChatGPT's review flagged: a workspace
    // whose persisted preference is "named" (permanentUrlConfigured would
    // read true) but whose bridge, right now, actually degraded to Quick
    // (the P2-2 runtime fallback — Named failed to start this run without
    // touching the persisted preference). A status reader that only looks
    // at persisted state would wrongly report this as a healthy, complete
    // Named setup.
    isolateStateDir();
    const root = makeTmpDir("status-fallback-ws");
    tmpDirs.push(root);
    const workspace = new Workspace(root);
    writeTunnelState({
      workspaceId: workspace.id,
      preference: "named",
      askedAt: new Date().toISOString(),
      provider: "cloudflare-named",
      tunnelName: `c2c-${workspace.id}`,
      tunnelId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      hostname: "configured-but-degraded.example.com",
      zone: "example.com",
      configuredAt: new Date().toISOString(),
    });

    const authDir = makeTmpDir("status-fallback-auth");
    tmpDirs.push(authDir);
    const bridge = await startBridge({
      workspaceRoot: root,
      port: 0,
      persistRuntime: true,
      authStoreFile: path.join(authDir, "store.json"),
      // The active provider actually running is Quick — as if Named just
      // failed to start and server.ts's fallback took over — regardless
      // of what the persisted TunnelState above says.
      tunnelProvider: new FakeTunnel({ name: "cloudflare-quick", url: "https://degraded-quick.trycloudflare.com" }),
    });
    openBridges.push(bridge);

    const startResponse = await fetchAdmin(bridge, "/admin/tunnel/start");
    expect(startResponse.status).toBe(200);

    const status = await imonikaiStatus(root);
    expect(status.tunnel.permanentUrlConfigured).toBe(true); // still "configured"
    expect(status.tunnel.mode).toBe("quick"); // but LIVE reality is quick
    expect(status.tunnel.namedFallbackActive).toBe(true);
    expect(status.needsInit).toBe(true); // a Skill must not treat this as done
  });

  it("reports mode:named and namedFallbackActive:false when Named really is what's running", async () => {
    isolateStateDir();
    const root = makeTmpDir("status-healthy-ws");
    tmpDirs.push(root);
    const workspace = new Workspace(root);
    writeTunnelState({
      workspaceId: workspace.id,
      preference: "named",
      askedAt: new Date().toISOString(),
      provider: "cloudflare-named",
      tunnelName: `c2c-${workspace.id}`,
      tunnelId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
      hostname: "healthy.example.com",
      zone: "example.com",
      configuredAt: new Date().toISOString(),
    });

    const authDir = makeTmpDir("status-healthy-auth");
    tmpDirs.push(authDir);
    const bridge = await startBridge({
      workspaceRoot: root,
      port: 0,
      persistRuntime: true,
      authStoreFile: path.join(authDir, "store.json"),
      tunnelProvider: new FakeTunnel({ name: "cloudflare-named", url: "https://healthy.example.com" }),
    });
    openBridges.push(bridge);
    await fetchAdmin(bridge, "/admin/tunnel/start");

    const status = await imonikaiStatus(root);
    expect(status.tunnel.mode).toBe("named");
    expect(status.tunnel.namedFallbackActive).toBe(false);
  });
});

describe("Named fallback detection -> repair -> Named restored, application-level (issue: doctor --fix routing)", () => {
  it("goes namedFallbackActive:true -> attemptNamedFallbackRepair -> namedFallbackActive:false, through the exact functions doctor --fix and imonikai status use", async () => {
    // Full loop ChatGPT's review asked for: a workspace configured for
    // Named but currently degraded to Quick is detected by imonikaiStatus
    // (namedFallbackActive:true, needsInit:true — see the previous
    // describe block), and the SAME repair action `doctor --fix` performs
    // (attemptNamedFallbackRepair) actually restores it to Named — verified
    // by re-reading imonikaiStatus afterward, not by trusting the repair
    // function's own return value alone.
    isolateStateDir();
    const root = makeTmpDir("repair-ws");
    tmpDirs.push(root);
    const authDir = makeTmpDir("repair-auth");
    tmpDirs.push(authDir);
    const workspace = new Workspace(root);
    writeTunnelState({
      workspaceId: workspace.id,
      preference: "named",
      askedAt: new Date().toISOString(),
      provider: "cloudflare-named",
      tunnelName: `c2c-${workspace.id}`,
      tunnelId: "dddddddd-dddd-dddd-dddd-dddddddddddd",
      hostname: "repairable.example.com",
      zone: "example.com",
      configuredAt: new Date().toISOString(),
    });

    let bridge = await startBridge({
      workspaceRoot: root,
      port: 0,
      persistRuntime: true,
      authStoreFile: path.join(authDir, "store.json"),
      tunnelProvider: new FakeTunnel({ name: "cloudflare-quick", url: "https://degraded.trycloudflare.com" }),
    });
    openBridges.push(bridge);
    await fetchAdmin(bridge, "/admin/tunnel/start");

    // 1: status correctly detects the degraded state (same assertions as
    // the previous describe block — re-checked here as this test's own
    // starting point, not assumed).
    let status = await imonikaiStatus(root);
    expect(status.tunnel.namedFallbackActive).toBe(true);
    expect(status.needsInit).toBe(true);

    // 2: repair. The real `restart` default (stop/ensureBridge, a real
    // `c2c serve` subprocess) needs an actual cloudflared/Cloudflare
    // account — out of scope for a unit test (see cli-entrypoint.test.ts
    // for the one place this suite does spawn a real subprocess, for a
    // different reason). Inject a fake `restart` that does the same KIND
    // of thing a real restart does when it succeeds — stop the degraded
    // bridge, bring up a new one that actually holds a Named provider —
    // so the repair's *effect* is genuinely observable afterward through
    // the same live, persisted-runtime path imonikaiStatus reads, not
    // fabricated in the return value alone.
    const fakeRestart = async (rootArg: string): Promise<{ runtime: RuntimeState; info: AdminInfo }> => {
      await bridge.close();
      bridge = await startBridge({
        workspaceRoot: rootArg,
        port: 0,
        persistRuntime: true,
        authStoreFile: path.join(authDir, "store.json"),
        tunnelProvider: new FakeTunnel({ name: "cloudflare-named", url: "https://repairable.example.com" }),
      });
      openBridges.push(bridge);
      await fetchAdmin(bridge, "/admin/tunnel/start");
      const runtime = await findLiveBridge(workspace.id);
      if (!runtime) throw new Error("repaired bridge did not come up live");
      const info = (await (
        await fetch(`${bridge.localBaseUrl()}/admin/info`, {
          headers: { authorization: `Bearer ${bridge.adminToken}` },
        })
      ).json()) as AdminInfo;
      return { runtime, info };
    };

    const repairResult = await attemptNamedFallbackRepair(root, fakeRestart);
    expect(repairResult.repaired).toBe(true);

    // 3: re-read status through the normal path — the repair's effect must
    // be independently observable, not just asserted from repairResult.
    status = await imonikaiStatus(root);
    expect(status.tunnel.mode).toBe("named");
    expect(status.tunnel.namedFallbackActive).toBe(false);
    // needsInit is not asserted false here: this test never ran an OAuth
    // round trip, so `authorized` (a separate, legitimate reason for
    // needsInit) is genuinely false regardless of the Named repair — see
    // needsInit: !authorized || namedFallbackActive. What this test is
    // about is specifically namedFallbackActive, asserted above.
  });

  it("repairResult.repaired is false when the restart still comes back on Quick (transient failure persists)", async () => {
    isolateStateDir();
    const root = makeTmpDir("repair-fail-ws");
    tmpDirs.push(root);
    const authDir = makeTmpDir("repair-fail-auth");
    tmpDirs.push(authDir);
    const workspace = new Workspace(root);
    writeTunnelState({
      workspaceId: workspace.id,
      preference: "named",
      askedAt: new Date().toISOString(),
      provider: "cloudflare-named",
      tunnelName: `c2c-${workspace.id}`,
      tunnelId: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
      hostname: "still-broken.example.com",
      zone: "example.com",
      configuredAt: new Date().toISOString(),
    });
    const bridge = await startBridge({
      workspaceRoot: root,
      port: 0,
      persistRuntime: true,
      authStoreFile: path.join(authDir, "store.json"),
      tunnelProvider: new FakeTunnel({ name: "cloudflare-quick", url: "https://still-degraded.trycloudflare.com" }),
    });
    openBridges.push(bridge);
    await fetchAdmin(bridge, "/admin/tunnel/start");

    const fakeRestartStillQuick = async (): Promise<{ runtime: RuntimeState; info: AdminInfo }> => {
      const runtime = await findLiveBridge(workspace.id);
      if (!runtime) throw new Error("bridge not live");
      const info = (await (
        await fetch(`${bridge.localBaseUrl()}/admin/info`, {
          headers: { authorization: `Bearer ${bridge.adminToken}` },
        })
      ).json()) as AdminInfo;
      return { runtime, info }; // still reports cloudflare-quick — unchanged
    };

    const repairResult = await attemptNamedFallbackRepair(root, fakeRestartStillQuick);
    expect(repairResult.repaired).toBe(false);
    expect(repairResult.info.tunnel.provider).toBe("cloudflare-quick");
  });

  it("repairResult.repaired is false when provider already reads 'cloudflare-named' but the tunnel never actually connected", async () => {
    // The exact bug ChatGPT's review caught: a freshly (re)started bridge
    // for a workspace with preference:"named" constructs a
    // CloudflaredNamedTunnel at startup (tunnelForWorkspace()) BEFORE
    // .start() is ever called — info.tunnel.provider already reads
    // "cloudflare-named" at that point even though nothing is running yet
    // (running:false, url:null). Checking provider name alone would
    // wrongly report "repaired". This constructs that exact info shape
    // directly, without going through a real bridge at all — it's testing
    // attemptNamedFallbackRepair's OWN decision logic in isolation.
    const fakeRestartConstructedButNotStarted = async (): Promise<{ runtime: RuntimeState; info: AdminInfo }> => ({
      runtime: {
        service: "c2c-bridge",
        version: "0.1.1",
        workspaceId: "fake-workspace",
        workspaceRoot: "/tmp/fake",
        pid: process.pid,
        port: 1,
        adminToken: "fake",
        publicUrl: null,
        startedAt: new Date().toISOString(),
      },
      info: {
        workspaceId: "fake-workspace",
        workspaceName: "fake",
        workspaceRoot: "/tmp/fake",
        port: 1,
        publicUrl: null,
        tunnel: { running: false, url: null, provider: "cloudflare-named" },
        tokenCount: 0,
        hasUsableAuthorization: false,
        pairingActive: false,
        pid: process.pid,
        startedAt: new Date().toISOString(),
      },
    });

    const repairResult = await attemptNamedFallbackRepair("/tmp/fake", fakeRestartConstructedButNotStarted);
    expect(repairResult.repaired).toBe(false);
  });
});

async function fetchAdmin(bridge: Bridge, path: string): Promise<Response> {
  return fetch(`${bridge.localBaseUrl()}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${bridge.adminToken}` },
  });
}
