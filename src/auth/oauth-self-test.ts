import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RuntimeState } from "../bridge/runtime.js";
import { adminFetch } from "../process/daemon.js";
import { base64UrlSha256 } from "./store.js";
import { VERSION } from "../version.js";

export interface OAuthSelfTestResult {
  ok: boolean;
  /** True when the test deliberately did not run at all (a real pairing
   *  session was active) -- never counts as a failure. */
  skipped: boolean;
  stage?: "register" | "authorize_get" | "authorize_post" | "token" | "mcp";
  detail: string;
}

interface AdminInfoLite {
  pairingActive: boolean;
}

interface PairingResponseLite {
  code: string;
}

const SELF_TEST_REDIRECT_URI = "http://127.0.0.1:1/c2c-doctor-oauth-self-test-callback";
/** Exported so server.ts can recognize -- and exclude from connector-
 *  confirmation recording -- its own diagnostic client by name (see
 *  OAuthDeps.onAuthorizationCodeExchanged's doc comment in oauth.ts). */
export const OAUTH_SELF_TEST_CLIENT_NAME = "c2c-doctor-oauth-self-test";
const STEP_TIMEOUT_MS = 10_000;

/**
 * doctor's real DCR -> authorize -> pairing -> token exchange -> authenticated
 * MCP call self-test (connector reliability hardening PRIORITY D,
 * independent review 2026-09-03). Unlike `issueSelfTestToken()` (which
 * mints a token directly, in-process, proving only that bearerAuth + /mcp
 * work), this makes REAL HTTP requests to the SAME public routes ChatGPT's
 * own OAuth client uses -- `POST /oauth/register`, `GET`+`POST
 * /oauth/authorize`, `POST /oauth/token` -- so a "green" result here means
 * the actual wire contract ChatGPT depends on works end to end, not just
 * that a synthetically-issued token is honored by the auth middleware.
 * Deliberately does NOT use `issueSelfTestToken()` for this judgment (that
 * remains a separate, narrower check -- see doctor's own `mcpAuthenticated`
 * field).
 *
 * Never disrupts a real, in-progress pairing session: `PairingManager` only
 * ever holds ONE active session at a time (`create()` clears any previous
 * one), so this checks `pairingActive` via `/admin/info` FIRST and skips
 * entirely -- never fails, never proceeds -- if a real session is already
 * under way. The whole point of this check is to catch a broken connector,
 * not to become a new way to break one.
 *
 * Always cleans up after itself in a `finally`, success or failure: revokes
 * any tokens it issued (so it can never contaminate
 * `hasUsableAuthorization()`/`tokenCount()`, which answer "has ChatGPT's
 * own connector authorized this workspace") and unregisters its own
 * throwaway DCR client (so the store doesn't accumulate one
 * "c2c-doctor-oauth-self-test" client per `doctor` run).
 */
export async function runOAuthSelfTest(runtime: RuntimeState): Promise<OAuthSelfTestResult> {
  const base = `http://127.0.0.1:${runtime.port}`;
  let clientId: string | null = null;
  let accessToken: string | null = null;
  let refreshToken: string | null = null;

  try {
    const info = await adminFetch<AdminInfoLite>(runtime, "GET", "/admin/info", 5000);
    if (info.pairingActive) {
      return {
        ok: true,
        skipped: true,
        detail: "skipped -- a real pairing session is currently active; running this would disrupt it",
      };
    }

    // 1. Dynamic Client Registration -- the exact public endpoint ChatGPT's
    //    client calls.
    const registerRes = await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: OAUTH_SELF_TEST_CLIENT_NAME, redirect_uris: [SELF_TEST_REDIRECT_URI] }),
      signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
    });
    if (!registerRes.ok) {
      return { ok: false, skipped: false, stage: "register", detail: `DCR failed: HTTP ${registerRes.status}` };
    }
    const registerBody = (await registerRes.json().catch(() => ({}))) as { client_id?: string };
    if (!registerBody.client_id) {
      return { ok: false, skipped: false, stage: "register", detail: "DCR response was missing client_id" };
    }
    clientId = registerBody.client_id;

    // 2. GET /oauth/authorize -- the real pairing-page endpoint.
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = base64UrlSha256(codeVerifier);
    const state = randomBytes(8).toString("hex");
    const authorizeUrl = new URL(`${base}/oauth/authorize`);
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", SELF_TEST_REDIRECT_URI);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("code_challenge", codeChallenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("scope", "workspace.read");
    authorizeUrl.searchParams.set("state", state);
    const getRes = await fetch(authorizeUrl.toString(), { signal: AbortSignal.timeout(STEP_TIMEOUT_MS) });
    if (!getRes.ok) {
      return { ok: false, skipped: false, stage: "authorize_get", detail: `GET /oauth/authorize failed: HTTP ${getRes.status}` };
    }
    const html = await getRes.text();
    const match = html.match(/name="request_id" value="([0-9a-f]+)"/);
    if (!match) {
      return { ok: false, skipped: false, stage: "authorize_get", detail: "pairing page response did not contain a request_id" };
    }
    const requestId = match[1];

    // 3. Mint a real pairing code -- server-side, admin-only, exactly what
    //    `c2c pair` does for a human. Uses the atomic check-and-create
    //    route (never the plain /admin/pairing `c2c pair` itself uses):
    //    the step-1 pairingActive check above happened before several more
    //    round trips (DCR, this GET) -- a real `c2c pair` landing in that
    //    gap would have been silently destroyed by an unconditional create
    //    here. This route checks-and-creates in one synchronous step on
    //    the server, so a real session that appeared after step 1 is still
    //    protected (independent review, 2026-09-04).
    const pairing = await adminFetch<PairingResponseLite & { created: boolean }>(
      runtime,
      "POST",
      "/admin/pairing/if-idle",
      5000
    );
    if (!pairing.created) {
      return {
        ok: true,
        skipped: true,
        detail: "skipped -- a real pairing session became active during setup; running this would disrupt it",
      };
    }

    // 4. POST /oauth/authorize -- the real pairing-verification endpoint.
    //    redirect:"manual" so the Location header is read directly instead
    //    of needing something actually listening at the (synthetic)
    //    redirect_uri.
    const postRes = await fetch(`${base}/oauth/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ request_id: requestId, pairing_code: pairing.code }).toString(),
      redirect: "manual",
      signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
    });
    if (postRes.status !== 302) {
      return { ok: false, skipped: false, stage: "authorize_post", detail: `POST /oauth/authorize did not redirect: HTTP ${postRes.status}` };
    }
    const location = postRes.headers.get("location");
    if (!location) {
      return { ok: false, skipped: false, stage: "authorize_post", detail: "302 response had no Location header" };
    }
    const redirectUrl = new URL(location);
    const code = redirectUrl.searchParams.get("code");
    const returnedState = redirectUrl.searchParams.get("state");
    if (!code) {
      return { ok: false, skipped: false, stage: "authorize_post", detail: "redirect did not include an authorization code" };
    }
    if (returnedState !== state) {
      return { ok: false, skipped: false, stage: "authorize_post", detail: "redirect state parameter did not match (CSRF-protection check failed)" };
    }

    // 5. POST /oauth/token -- the real token-exchange endpoint.
    const tokenRes = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: codeVerifier,
        client_id: clientId,
        redirect_uri: SELF_TEST_REDIRECT_URI,
      }).toString(),
      signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
    });
    if (!tokenRes.ok) {
      return { ok: false, skipped: false, stage: "token", detail: `POST /oauth/token failed: HTTP ${tokenRes.status}` };
    }
    const tokenBody = (await tokenRes.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string };
    if (!tokenBody.access_token) {
      return { ok: false, skipped: false, stage: "token", detail: "token response was missing access_token" };
    }
    accessToken = tokenBody.access_token;
    refreshToken = tokenBody.refresh_token ?? null;

    // 6. Authenticated MCP call, via the real MCP client SDK -- the exact
    //    bearerAuth + /mcp code path ChatGPT itself uses, with a token that
    //    just went through the full public OAuth contract (not one minted
    //    in-process).
    const client = new Client({ name: "c2c-doctor-oauth-self-test", version: VERSION });
    try {
      const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
      });
      await client.connect(transport);
      const result = await client.callTool({ name: "workspace_info", arguments: {} });
      const content = result.content as { type: string; text: string }[] | undefined;
      const parsed = JSON.parse(content?.[0]?.text ?? "{}") as { workspaceId?: string };
      if (parsed.workspaceId !== runtime.workspaceId) {
        return { ok: false, skipped: false, stage: "mcp", detail: "authenticated MCP call returned content for a different workspace" };
      }
    } finally {
      await client.close().catch(() => undefined);
    }

    return {
      ok: true,
      skipped: false,
      detail: "DCR -> authorize -> pairing -> token exchange -> authenticated MCP request all succeeded",
    };
  } catch (error) {
    return { ok: false, skipped: false, detail: error instanceof Error ? error.message : "unknown error" };
  } finally {
    if (accessToken) {
      await fetch(`${base}/oauth/revoke`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: accessToken }).toString(),
      }).catch(() => undefined);
    }
    if (refreshToken) {
      await fetch(`${base}/oauth/revoke`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: refreshToken }).toString(),
      }).catch(() => undefined);
    }
    if (clientId) {
      await adminFetch(runtime, "POST", "/admin/oauth-client/unregister", 5000, { clientId }).catch(() => undefined);
    }
  }
}
