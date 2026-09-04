import { describe, it, expect, vi, afterEach } from "vitest";
import path from "node:path";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { nullLogger } from "../src/logger/index.js";
import { runOAuthSelfTest } from "../src/auth/oauth-self-test.js";
import type { RuntimeState } from "../src/bridge/runtime.js";
import { makeTmpDir, cleanup, write, isolateStateDir, pkceVerifierAndChallenge } from "./helpers.js";

// Connector Reliability Hardening -- OAuth flow (independent review,
// 2026-09-03). Root cause of the reported "Reconnect -> setup error /
// pairing page Connect once: no visible change, Connect again: 'This
// authorization request has expired'" symptom: `pendingRequests` (the
// state between showing the pairing page and verifying its code) and
// authorization codes were plain in-memory Maps, wiped on every bridge
// restart, AND the pending request was deleted the instant a correct
// pairing code was entered -- before anything confirmed the subsequent
// redirect + ChatGPT's own token exchange actually succeeded. These tests
// pin the fix: both are now durably persisted, and a retry of an
// already-verified request is idempotent instead of "expired".

const REDIRECT_URI = "http://127.0.0.1:19999/callback";

afterEach(() => {
  vi.restoreAllMocks();
});

interface StartOpts {
  name: string;
  logger?: typeof nullLogger;
}

async function startTestBridge(opts: StartOpts): Promise<{ bridge: Bridge; root: string; authFile: string; base: string }> {
  const root = makeTmpDir(opts.name);
  write(root, "hello.txt", "hello\n");
  const authFile = path.join(makeTmpDir(`${opts.name}-auth`), "store.json");
  const bridge = await startBridge({
    workspaceRoot: root,
    port: 0,
    persistRuntime: false,
    authStoreFile: authFile,
    logger: opts.logger,
  });
  return { bridge, root, authFile, base: bridge.localBaseUrl() };
}

/** Simulates a real bridge restart: closes the running Express server and
 *  starts a genuinely NEW one against the SAME persisted auth file and
 *  workspace -- unlike constructing a second `AuthStore` directly, this
 *  also discards any in-process-only state a bug might still be keeping
 *  (e.g. a plain in-memory Map local to a router closure), which is
 *  exactly the class of bug this file exists to catch. */
async function restartBridge(bridge: Bridge, root: string, authFile: string): Promise<Bridge> {
  await bridge.close();
  return startBridge({ workspaceRoot: root, port: 0, persistRuntime: false, authStoreFile: authFile });
}

async function registerClient(base: string, redirectUri = REDIRECT_URI): Promise<string> {
  const response = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "ChatGPT-Test", redirect_uris: [redirectUri] }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { client_id: string };
  return body.client_id;
}

async function getAuthorize(
  base: string,
  clientId: string,
  challenge: string,
  redirectUri = REDIRECT_URI,
  state = "st-123"
): Promise<{ requestId: string | null; status: number; html: string; location: string | null }> {
  const authorizeUrl = new URL(`${base}/oauth/authorize`);
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("scope", "workspace.read");
  const res = await fetch(authorizeUrl, { redirect: "manual" });
  const html = await res.text();
  const requestId = html.match(/name="request_id" value="([a-f0-9]+)"/)?.[1] ?? null;
  return { requestId, status: res.status, html, location: res.headers.get("location") };
}

async function postAuthorize(
  base: string,
  requestId: string,
  pairingCode: string
): Promise<{ status: number; code: string | null; state: string | null; body: string }> {
  const res = await fetch(`${base}/oauth/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ request_id: requestId, pairing_code: pairingCode }),
    redirect: "manual",
  });
  const body = await res.text();
  if (res.status !== 302) return { status: res.status, code: null, state: null, body };
  const location = res.headers.get("location")!;
  const url = new URL(location);
  return { status: res.status, code: url.searchParams.get("code"), state: url.searchParams.get("state"), body };
}

async function exchangeToken(
  base: string,
  clientId: string,
  code: string,
  verifier: string,
  redirectUri = REDIRECT_URI
): Promise<{ status: number; body: Record<string, string> }> {
  const response = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: redirectUri,
    }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, string> };
}

describe("A1 -- durable pending state survives a real bridge restart", () => {
  it("a bridge restart between GET /oauth/authorize and pairing-code submission does NOT lose the pending request", async () => {
    isolateStateDir();
    const { bridge, root, authFile, base } = await startTestBridge({ name: "restart-mid-pairing" });
    try {
      const clientId = await registerClient(base);
      const { challenge } = pkceVerifierAndChallenge();
      const { requestId, status } = await getAuthorize(base, clientId, challenge);
      expect(status).toBe(200);
      expect(requestId).toBeTruthy();

      const pairing = bridge.pairing.create();
      const restarted = await restartBridge(bridge, root, authFile);
      try {
        const result = await postAuthorize(restarted.localBaseUrl(), requestId!, pairing.code);
        // Independent review: this is the EXACT reproduction of the
        // reported bug -- before the fix, this returned 400 "expired"
        // because pendingRequests was a plain in-memory Map wiped by the
        // restart. It must now succeed.
        expect(result.status).toBe(302);
        expect(result.code).toBeTruthy();
      } finally {
        await restarted.close();
      }
    } finally {
      cleanup(root);
    }
  });

  it("a bridge restart after pairing succeeds but before the token exchange does NOT lose the authorization code", async () => {
    isolateStateDir();
    const { bridge, root, authFile, base } = await startTestBridge({ name: "restart-mid-token" });
    try {
      const clientId = await registerClient(base);
      const { verifier, challenge } = pkceVerifierAndChallenge();
      const { requestId } = await getAuthorize(base, clientId, challenge);
      const pairing = bridge.pairing.create();
      const { code } = await postAuthorize(base, requestId!, pairing.code);
      expect(code).toBeTruthy();

      const restarted = await restartBridge(bridge, root, authFile);
      try {
        const token = await exchangeToken(restarted.localBaseUrl(), clientId, code!, verifier);
        expect(token.status).toBe(200);
        expect(token.body.access_token).toMatch(/^c2c_at_/);
      } finally {
        await restarted.close();
      }
    } finally {
      cleanup(root);
    }
  });

  it("client registrations persist across a real bridge restart (PRIORITY B)", async () => {
    isolateStateDir();
    const { bridge, root, authFile, base } = await startTestBridge({ name: "restart-client-lookup" });
    try {
      const clientId = await registerClient(base);
      const restarted = await restartBridge(bridge, root, authFile);
      try {
        const { challenge } = pkceVerifierAndChallenge();
        const { status } = await getAuthorize(restarted.localBaseUrl(), clientId, challenge);
        expect(status).toBe(200); // still a known client after restart
      } finally {
        await restarted.close();
      }
    } finally {
      cleanup(root);
    }
  });
});

describe("A2/A3 -- idempotent retry of an already-verified request (the exact reported reproduction)", () => {
  it("reproduces '1st Connect: no visible change, 2nd Connect: expired' and proves it's fixed: a duplicate POST with the SAME request_id+pairing_code gets a fresh code and redirect, never 'expired'", async () => {
    isolateStateDir();
    const { bridge, root, base } = await startTestBridge({ name: "double-submit" });
    try {
      const clientId = await registerClient(base);
      const { challenge } = pkceVerifierAndChallenge();
      const { requestId } = await getAuthorize(base, clientId, challenge);
      const pairing = bridge.pairing.create();

      const first = await postAuthorize(base, requestId!, pairing.code);
      expect(first.status).toBe(302);
      expect(first.code).toBeTruthy();

      // Simulates the browser re-submitting the SAME form -- double-click,
      // back-button resubmit, or a retry after the first redirect
      // appeared to do nothing. Before the fix this returned 400 "This
      // authorization request has expired." on this exact second call.
      const second = await postAuthorize(base, requestId!, pairing.code);
      expect(second.status).toBe(302); // a real redirect, not the old 400 "expired" error page
      expect(second.code).toBeTruthy();
      expect(second.code).not.toBe(first.code); // a FRESH, distinct single-use code
      expect(second.state).toBe(first.state);
    } finally {
      cleanup(root);
    }
  });

  it("both the first and the retry-issued authorization codes independently exchange for real tokens", async () => {
    isolateStateDir();
    const { bridge, root, base } = await startTestBridge({ name: "double-submit-both-redeemable" });
    try {
      const clientId = await registerClient(base);
      const { verifier, challenge } = pkceVerifierAndChallenge();
      const { requestId } = await getAuthorize(base, clientId, challenge);
      const pairing = bridge.pairing.create();

      const first = await postAuthorize(base, requestId!, pairing.code);
      const second = await postAuthorize(base, requestId!, pairing.code);

      const firstToken = await exchangeToken(base, clientId, first.code!, verifier);
      expect(firstToken.status).toBe(200);
      const secondToken = await exchangeToken(base, clientId, second.code!, verifier);
      expect(secondToken.status).toBe(200);
    } finally {
      cleanup(root);
    }
  });

  it("caps retries -- eventually returns a clear, specific error instead of minting authorization codes forever", async () => {
    isolateStateDir();
    const { bridge, root, base } = await startTestBridge({ name: "retry-cap" });
    try {
      const clientId = await registerClient(base);
      const { challenge } = pkceVerifierAndChallenge();
      const { requestId } = await getAuthorize(base, clientId, challenge);
      const pairing = bridge.pairing.create();

      await postAuthorize(base, requestId!, pairing.code); // consumes -> status "consumed"
      let last: Awaited<ReturnType<typeof postAuthorize>> | null = null;
      for (let i = 0; i < 10; i++) {
        last = await postAuthorize(base, requestId!, pairing.code);
        if (last.status !== 302) break;
      }
      expect(last!.status).toBe(429);
      expect(last!.body).toContain("Too many attempts");
      expect(last!.body).not.toContain("expired"); // distinct message, not confused with genuine expiry
    } finally {
      cleanup(root);
    }
  });

  it("a genuinely unknown request_id gets 'Unknown authorization request', a message DISTINCT from 'expired'", async () => {
    isolateStateDir();
    const { root, base } = await startTestBridge({ name: "unknown-request-id" });
    try {
      const result = await postAuthorize(base, "0123456789abcdef0123456789abcdef", "AAAA-AAAA");
      expect(result.status).toBe(400);
      expect(result.body).toContain("Unknown authorization request");
      expect(result.body).not.toContain("expired");
    } finally {
      cleanup(root);
    }
  });

  it("a genuinely TTL-expired pending request is treated as gone, not silently revivable", async () => {
    isolateStateDir();
    const { bridge, root, base } = await startTestBridge({ name: "genuine-ttl-expiry" });
    try {
      const clientId = await registerClient(base);
      const { challenge } = pkceVerifierAndChallenge();
      const { requestId } = await getAuthorize(base, clientId, challenge);
      const pairing = bridge.pairing.create();

      // Force genuine time-expiry directly on the BRIDGE'S OWN live,
      // already-in-memory AuthStore instance -- a separate AuthStore
      // pointed at the same file would only affect what's on disk, not
      // what the running server actually holds in memory (it doesn't
      // re-read the file per request), so mutating a second instance here
      // would have no observable effect on this specific bridge.
      const record = bridge.authStore.getPendingAuthRequest(requestId!);
      expect(record).toBeTruthy();
      (record as { expiresAt: number }).expiresAt = Date.now() - 1000;

      const result = await postAuthorize(base, requestId!, pairing.code);
      expect(result.status).toBe(400);
      expect(result.body).toContain("Unknown authorization request");
    } finally {
      cleanup(root);
    }
  });
});

describe("PRIORITY B -- client/redirect_uri validation is unaffected by the durability changes", () => {
  it("rejects an unknown client_id at GET /oauth/authorize", async () => {
    isolateStateDir();
    const { root, base } = await startTestBridge({ name: "unknown-client" });
    try {
      const { challenge } = pkceVerifierAndChallenge();
      const { status, html } = await getAuthorize(base, "c2c_client_does_not_exist", challenge);
      expect(status).toBe(400);
      expect(html).toContain("Unknown client");
    } finally {
      cleanup(root);
    }
  });

  it("rejects a redirect_uri that doesn't match the client's registration", async () => {
    isolateStateDir();
    const { root, base } = await startTestBridge({ name: "redirect-uri-mismatch" });
    try {
      const clientId = await registerClient(base);
      const { challenge } = pkceVerifierAndChallenge();
      const { status, html } = await getAuthorize(base, clientId, challenge, "http://127.0.0.1:1/not-registered");
      expect(status).toBe(400);
      expect(html).toContain("Invalid redirect_uri");
    } finally {
      cleanup(root);
    }
  });

  it("a client registered a long time ago (never expires) still authorizes correctly -- 'stale' age alone is never a rejection reason", async () => {
    isolateStateDir();
    const { bridge, root, base } = await startTestBridge({ name: "old-client-still-valid" });
    try {
      const clientId = await registerClient(base);
      // Backdate its createdAt (on the bridge's own live store -- a
      // separate AuthStore instance pointed at the same file would only
      // affect what's on disk, not what this running server actually
      // holds in memory) to simulate a long-lived registration.
      const client = bridge.authStore.getClient(clientId)!;
      client.createdAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

      const { challenge } = pkceVerifierAndChallenge();
      const { status } = await getAuthorize(base, clientId, challenge);
      expect(status).toBe(200);
    } finally {
      cleanup(root);
    }
  });

  it("unregisterClient removes the client and any of its tokens, and it can no longer authorize", async () => {
    isolateStateDir();
    const { bridge, root, base } = await startTestBridge({ name: "unregister-client" });
    try {
      const clientId = await registerClient(base);
      const tokens = bridge.authStore.issueTokens({ clientId, scopes: ["workspace.read"] });
      expect(bridge.authStore.verifyAccessToken(tokens.accessToken).ok).toBe(true);

      expect(bridge.authStore.unregisterClient(clientId)).toBe(true);
      expect(bridge.authStore.verifyAccessToken(tokens.accessToken).ok).toBe(false);
      expect(bridge.authStore.unregisterClient(clientId)).toBe(false); // already gone -- safe no-op

      const { challenge } = pkceVerifierAndChallenge();
      const { status } = await getAuthorize(base, clientId, challenge);
      expect(status).toBe(400); // unknown client now
    } finally {
      cleanup(root);
    }
  });
});

describe("multiple concurrent pending authorization requests coexist independently", () => {
  it("two GET /oauth/authorize calls create two independent pending requests; completing one never disturbs the other", async () => {
    isolateStateDir();
    const { bridge, root, base } = await startTestBridge({ name: "concurrent-requests" });
    try {
      const clientId = await registerClient(base);
      const { challenge: challengeA } = pkceVerifierAndChallenge();
      const { challenge: challengeB } = pkceVerifierAndChallenge();
      const { requestId: requestIdA } = await getAuthorize(base, clientId, challengeA, REDIRECT_URI, "state-a");
      const { requestId: requestIdB } = await getAuthorize(base, clientId, challengeB, REDIRECT_URI, "state-b");
      expect(requestIdA).toBeTruthy();
      expect(requestIdB).toBeTruthy();
      expect(requestIdA).not.toBe(requestIdB);

      // Only one pairing session can be active at a time (by design, see
      // PairingManager.create()) -- complete A, then confirm B's own
      // pending record is untouched (still "pending", not silently
      // consumed/corrupted by A's completion).
      const pairing = bridge.pairing.create();
      const resultA = await postAuthorize(base, requestIdA!, pairing.code);
      expect(resultA.status).toBe(302);
      expect(resultA.state).toBe("state-a");

      const stillPendingB = bridge.authStore.getPendingAuthRequest(requestIdB!);
      expect(stillPendingB?.status).toBe("pending");
    } finally {
      cleanup(root);
    }
  });
});

describe("PRIORITY C -- structured, secret-free logging on every reject path", () => {
  it("logs a rejection for an unknown client at GET /oauth/authorize, with no bearer/token/code value in the line", async () => {
    isolateStateDir();
    const warnSpy = vi.spyOn(nullLogger, "warn");
    const { root, base } = await startTestBridge({ name: "log-unknown-client", logger: nullLogger });
    try {
      const { challenge } = pkceVerifierAndChallenge();
      await getAuthorize(base, "c2c_client_does_not_exist", challenge);
      const line = warnSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes("route=authorize"));
      expect(line).toBeTruthy();
      expect(line).toContain("outcome=rejected");
      expect(line).toContain("reason=unknown_client");
    } finally {
      cleanup(root);
    }
  });

  it("logs a rejection for DCR with an invalid redirect_uri", async () => {
    isolateStateDir();
    const warnSpy = vi.spyOn(nullLogger, "warn");
    const { root, base } = await startTestBridge({ name: "log-dcr-invalid", logger: nullLogger });
    try {
      await fetch(`${base}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["http://evil.example.com/cb"] }),
      });
      const line = warnSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes("route=register"));
      expect(line).toBeTruthy();
      expect(line).toContain("reason=invalid_redirect_uri");
    } finally {
      cleanup(root);
    }
  });

  it("logs a rejection for an unknown request_id at POST /oauth/authorize", async () => {
    isolateStateDir();
    const warnSpy = vi.spyOn(nullLogger, "warn");
    const { root, base } = await startTestBridge({ name: "log-request-not-found", logger: nullLogger });
    try {
      await postAuthorize(base, "0123456789abcdef0123456789abcdef", "AAAA-AAAA");
      const line = warnSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes("reason=request_not_found"));
      expect(line).toBeTruthy();
    } finally {
      cleanup(root);
    }
  });

  it("logs a rejection for a PKCE mismatch at POST /oauth/token", async () => {
    isolateStateDir();
    const warnSpy = vi.spyOn(nullLogger, "warn");
    const { bridge, root, base } = await startTestBridge({ name: "log-pkce-mismatch", logger: nullLogger });
    try {
      const clientId = await registerClient(base);
      const { challenge } = pkceVerifierAndChallenge();
      const { requestId } = await getAuthorize(base, clientId, challenge);
      const pairing = bridge.pairing.create();
      const { code } = await postAuthorize(base, requestId!, pairing.code);
      await exchangeToken(base, clientId, code!, "totally-the-wrong-verifier-value");
      const line = warnSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes("reason=pkce_mismatch"));
      expect(line).toBeTruthy();
    } finally {
      cleanup(root);
    }
  });

  it("logs an acceptance for a successful DCR/authorize/token step, and NONE of the log lines ever contain a bearer token, pairing code, or authorization code value", async () => {
    isolateStateDir();
    const infoSpy = vi.spyOn(nullLogger, "info");
    const warnSpy = vi.spyOn(nullLogger, "warn");
    const { bridge, root, base } = await startTestBridge({ name: "log-no-secrets", logger: nullLogger });
    try {
      const clientId = await registerClient(base);
      const { verifier, challenge } = pkceVerifierAndChallenge();
      const { requestId } = await getAuthorize(base, clientId, challenge);
      const pairing = bridge.pairing.create();
      const { code } = await postAuthorize(base, requestId!, pairing.code);
      const token = await exchangeToken(base, clientId, code!, verifier);
      expect(token.status).toBe(200);

      const allLines = [...infoSpy.mock.calls, ...warnSpy.mock.calls].map((c) => String(c[0]));
      const joined = allLines.join("\n");
      expect(joined).not.toContain(pairing.code);
      expect(joined).not.toContain(code!);
      expect(joined).not.toContain(token.body.access_token);
      expect(joined).not.toContain(token.body.refresh_token);
      // But real signal IS present -- this isn't just an empty log.
      expect(joined).toContain("route=register");
      expect(joined).toContain("route=authorize");
      expect(joined).toContain("route=token");
      expect(joined).toContain(`client_id=${clientId}`);
    } finally {
      cleanup(root);
    }
  });
});

describe("PRIORITY D -- doctor's real DCR->authorize->pairing->token->MCP self-test", () => {
  function toRuntime(bridge: Bridge): RuntimeState {
    return {
      service: "c2c-bridge",
      version: "0.0.0-test",
      workspaceId: bridge.workspace.id,
      workspaceRoot: bridge.workspace.root,
      pid: process.pid,
      port: bridge.port,
      adminToken: bridge.adminToken,
      publicUrl: null,
      startedAt: new Date().toISOString(),
      generation: "test-generation",
    };
  }

  it("succeeds end to end against a real, healthy bridge, and cleans up after itself", async () => {
    isolateStateDir();
    const { bridge, root } = await startTestBridge({ name: "self-test-happy-path" });
    try {
      const before = bridge.authStore.tokenCount();
      const result = await runOAuthSelfTest(toRuntime(bridge));
      expect(result).toMatchObject({ ok: true, skipped: false });

      // Cleanup: no lingering tokens, no lingering client.
      expect(bridge.authStore.tokenCount()).toBe(before);
      expect(bridge.authStore.hasUsableAuthorization()).toBe(before > 0);
    } finally {
      cleanup(root);
    }
  });

  it("does NOT count toward hasUsableAuthorization()/tokenCount() even mid-flight (never a false 'ChatGPT is connected' signal)", async () => {
    isolateStateDir();
    const { bridge, root } = await startTestBridge({ name: "self-test-no-contamination" });
    try {
      expect(bridge.authStore.hasUsableAuthorization()).toBe(false);
      const result = await runOAuthSelfTest(toRuntime(bridge));
      expect(result.ok).toBe(true);
      expect(bridge.authStore.hasUsableAuthorization()).toBe(false);
    } finally {
      cleanup(root);
    }
  });

  it("skips entirely -- never fails, never proceeds -- when a real pairing session is already active", async () => {
    isolateStateDir();
    const { bridge, root } = await startTestBridge({ name: "self-test-skip-active-session" });
    try {
      bridge.pairing.create(); // a "real" user pairing session, in progress
      const result = await runOAuthSelfTest(toRuntime(bridge));
      expect(result).toMatchObject({ ok: true, skipped: true });
      // And the real session must survive completely untouched.
      expect(bridge.pairing.hasActiveSession()).toBe(true);
    } finally {
      cleanup(root);
    }
  });

  it("BLOCKER 2 (independent review 2026-09-04): /admin/pairing/if-idle -- the atomic check-and-create route the self-test uses -- never destroys an already-active real pairing session", async () => {
    // The previous fix only checked pairingActive ONCE, before several
    // more round trips (DCR, GET /oauth/authorize) that happen before the
    // self-test's own (previously unconditional) pairing call -- a real
    // `c2c pair` landing in that gap was silently destroyed by the
    // self-test's own later PairingManager.create(), since create()
    // always clears whatever session already exists. This is a direct,
    // fully deterministic test of the fix's actual guarantee (no timing
    // dependency): the route must check-and-create as one atomic step.
    isolateStateDir();
    const { bridge, root } = await startTestBridge({ name: "if-idle-atomicity" });
    try {
      const real = bridge.pairing.create(); // a real, in-progress user session
      const res = await fetch(`${bridge.localBaseUrl()}/admin/pairing/if-idle`, {
        method: "POST",
        headers: { Authorization: `Bearer ${bridge.adminToken}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { created: boolean };
      expect(body.created).toBe(false);
      // The real session must be completely untouched, not just "still
      // active in some form" -- verify the ORIGINAL code still works.
      expect(bridge.pairing.hasActiveSession()).toBe(true);
      const verdict = bridge.pairing.verify(real.code);
      expect(verdict.ok).toBe(true);
    } finally {
      cleanup(root);
    }
  });

  it("BLOCKER 2 (independent review 2026-09-04): a real pairing session created mid-flight -- after the self-test's initial check, before its own pairing call -- is never destroyed, and remains usable afterward", async () => {
    // A best-effort REAL race (not just the deterministic route-level test
    // above): fires a genuine bridge.pairing.create() timed to land in the
    // gap between the self-test's initial /admin/info check and its own
    // (now atomic) pairing call, which real DCR + GET /oauth/authorize
    // round trips make a real, if brief, window on a real bridge. The one
    // assertion that must hold regardless of exactly how the race resolves
    // moment-to-moment: the real session survives and stays usable.
    isolateStateDir();
    const { bridge, root } = await startTestBridge({ name: "self-test-toctou-race" });
    try {
      expect(bridge.pairing.hasActiveSession()).toBe(false);
      const selfTestPromise = runOAuthSelfTest(toRuntime(bridge));
      const realCodePromise = new Promise<string>((resolve) => {
        setTimeout(() => resolve(bridge.pairing.create().code), 15);
      });
      const [, realCode] = await Promise.all([selfTestPromise, realCodePromise]);
      expect(realCode).not.toBeNull();
      expect(bridge.pairing.hasActiveSession()).toBe(true);
      const verdict = bridge.pairing.verify(realCode!);
      expect(verdict.ok).toBe(true);
    } finally {
      cleanup(root);
    }
  });

  it("its own token exchange is never mistaken for proof a real external client connected (connector-confirmation exclusion)", async () => {
    isolateStateDir();
    const { bridge, root } = await startTestBridge({ name: "self-test-no-false-confirmation" });
    try {
      // Alias "public" to loopback, exactly like the self-test's own
      // requests arrive on -- the scenario that would otherwise let a
      // diagnostic round trip masquerade as a real external one.
      const startResponse = await fetch(`${bridge.localBaseUrl()}/admin/tunnel/start`, {
        method: "POST",
        headers: { Authorization: `Bearer ${bridge.adminToken}` },
      });
      expect(startResponse.status).toBe(200);

      const { readConnectorConfirmation } = await import("../src/config/connectorConfirmation.js");
      expect(readConnectorConfirmation(bridge.workspace.id)).toBeNull();
      const result = await runOAuthSelfTest(toRuntime(bridge));
      expect(result.ok).toBe(true);
      expect(readConnectorConfirmation(bridge.workspace.id)).toBeNull(); // still null -- self-test never confirms
    } finally {
      cleanup(root);
    }
  });

  it("detects a deliberately broken/unreachable bridge with a clear failure detail instead of crashing or reporting a false pass", async () => {
    isolateStateDir();
    const { bridge, root } = await startTestBridge({ name: "self-test-detects-broken-bridge" });
    try {
      const runtime = toRuntime(bridge);
      // Point at a port nothing is listening on so every request the
      // self-test makes (starting with its own /admin/info pairing-safety
      // check) fails immediately -- proving a broken connector is reported
      // as ok:false with a real detail, never silently swallowed into a
      // false "ok:true".
      const brokenRuntime: RuntimeState = { ...runtime, port: 1 };
      const result = await runOAuthSelfTest(brokenRuntime);
      expect(result.ok).toBe(false);
      expect(result.skipped).toBe(false);
      expect(result.detail).toBeTruthy();
    } finally {
      cleanup(root);
    }
  });

  it("detects a deliberately broken DCR endpoint specifically -- an unregistered client fails at the authorize stage, not silently", async () => {
    isolateStateDir();
    const { bridge, root } = await startTestBridge({ name: "self-test-detects-broken-authorize" });
    try {
      // Simulates DCR having silently failed to persist a client (a real
      // regression this whole task exists to catch) by removing whatever
      // client the self-test itself just registered, from a race with its
      // own flow -- exercised here by revoking ALL clients right after
      // startup so ANY authorize attempt hits "unknown client".
      const original = bridge.authStore.getClient.bind(bridge.authStore);
      const spy = vi.spyOn(bridge.authStore, "getClient").mockImplementation(() => undefined);
      try {
        const result = await runOAuthSelfTest(toRuntime(bridge));
        expect(result.ok).toBe(false);
        expect(result.skipped).toBe(false);
        expect(result.stage).toBe("authorize_get");
      } finally {
        spy.mockRestore();
        void original;
      }
    } finally {
      cleanup(root);
    }
  });
});
