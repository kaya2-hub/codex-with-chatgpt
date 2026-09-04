import { Router, type Request, type Response, urlencoded, json } from "express";
import { randomBytes } from "node:crypto";
import { AuthStore, SUPPORTED_SCOPES, base64UrlSha256, filterScopes, safeEqual } from "./store.js";
import { PairingManager } from "../pairing/manager.js";
import type { Logger } from "../logger/index.js";
import { PRODUCT_NAME } from "../version.js";
import { escapeHtml, setAuthSecurityHeaders } from "./html.js";
import { logOAuthEvent } from "./oauth-log.js";

export interface OAuthDeps {
  store: AuthStore;
  pairing: PairingManager;
  workspaceName: string;
  getBaseUrl: (req: Request) => string;
  logger: Logger;
  /** This bridge process's own generation id -- threaded into every OAuth
   *  log line so a reader can tell whether a request pair straddled a
   *  restart (see oauth-log.ts). */
  generation?: string;
  /** Called once a `POST /oauth/token` authorization_code exchange actually
   *  succeeds, with the ORIGIN THE REQUEST ITSELF ARRIVED ON (`req.protocol`
   *  + `req.get("host")` — never the configured/desired public URL) and the
   *  exchanging client's id. The caller must compare the origin against
   *  what it currently believes the public URL to be, and must exclude its
   *  own OAuth self-test client, before recording a "confirmed" endpoint —
   *  see connectorConfirmation.ts. A request that arrived over loopback (a
   *  local admin call, a test hitting `bridge.localBaseUrl()`, an internal
   *  retry) must never be able to confirm the public tunnel URL just
   *  because one happens to be configured -- and neither must doctor's own
   *  diagnostic self-test round trip, regardless of what URL is
   *  configured. */
  onAuthorizationCodeExchanged?: (requestOrigin: string, clientId: string) => void;
}

/** Independent review, 2026-09-03: an already-"consumed" pending request
 *  (its pairing code was already proven correct once) can be safely
 *  re-issued a fresh authorization code -- browser double-submit, a
 *  back-button resubmit, a downstream redirect/exchange failure on
 *  ChatGPT's own side -- without asking for the pairing code again. Capped
 *  so a stuck client can't mint authorization codes indefinitely. */
const MAX_PENDING_AUTH_RETRIES = 5;

function isAllowedRedirectUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  if (parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")) {
    return true;
  }
  return false;
}

function authorizationServerMetadata(base: string): Record<string, unknown> {
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...SUPPORTED_SCOPES],
  };
}

function protectedResourceMetadata(base: string): Record<string, unknown> {
  return {
    resource: `${base}/mcp`,
    authorization_servers: [base],
    scopes_supported: [...SUPPORTED_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: PRODUCT_NAME,
  };
}

function pairingPage(opts: {
  requestId: string;
  workspaceName: string;
  scopes: string[];
  error?: string;
}): string {
  const scopeLabels: Record<string, string> = {
    "workspace.read": "Read files in this workspace",
    "workspace.search": "Search this workspace",
    "git.read": "Read git status and diffs",
    "execution.read": "Read coding-agent execution summaries",
    offline_access: "Stay connected between sessions",
  };
  const scopeList = opts.scopes
    .map((scope) => `<li>${escapeHtml(scopeLabels[scope] ?? scope)}</li>`)
    .join("");
  const errorHtml = opts.error
    ? `<p class="error" role="alert">${escapeHtml(opts.error)}</p>`
    : "";
  const escapedProductName = escapeHtml(PRODUCT_NAME);
  const escapedWorkspaceName = escapeHtml(opts.workspaceName);
  const escapedRequestId = escapeHtml(opts.requestId);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapedProductName}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         display: flex; align-items: center; justify-content: center; min-height: 100vh;
         margin: 0; background: #f5f5f7; color: #1d1d1f; }
  @media (prefers-color-scheme: dark) { body { background: #111; color: #eee; } .card { background: #1c1c1e !important; } }
  .card { background: #fff; border-radius: 16px; padding: 40px; max-width: 420px; width: 90%;
          box-shadow: 0 4px 24px rgba(0,0,0,.08); }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #86868b; font-size: 14px; margin: 0 0 20px; }
  ul { font-size: 13px; color: #6e6e73; padding-left: 18px; margin: 0 0 24px; }
  li { margin-bottom: 4px; }
  input[type=text] { width: 100%; box-sizing: border-box; font-size: 24px; letter-spacing: 4px;
          text-align: center; text-transform: uppercase; padding: 12px; border: 1.5px solid #d2d2d7;
          border-radius: 10px; font-family: ui-monospace, monospace; background: transparent; color: inherit; }
  input[type=text]:focus { outline: none; border-color: #0071e3; }
  button { width: 100%; margin-top: 16px; padding: 12px; font-size: 16px; border: 0; border-radius: 10px;
           background: #0071e3; color: #fff; cursor: pointer; }
  button:hover { background: #0077ed; }
  .error { color: #d70015; font-size: 13px; margin: 12px 0 0; }
  .hint { color: #86868b; font-size: 12px; margin-top: 16px; text-align: center; }
</style>
</head>
<body>
<div class="card">
  <h1>${escapedProductName}</h1>
  <p class="sub">ChatGPT is requesting access to workspace <strong>${escapedWorkspaceName}</strong> (read-only):</p>
  <ul>${scopeList}</ul>
  <form method="POST" action="authorize">
    <input type="hidden" name="request_id" value="${escapedRequestId}">
    <input type="text" name="pairing_code" id="pairing_code" placeholder="XXXX-XXXX"
           autocomplete="one-time-code" autofocus maxlength="9" required>
    ${errorHtml}
    <button type="submit">Connect</button>
  </form>
  <p class="hint">The pairing code was generated by your coding agent (Codex or Claude Code) on this computer.<br>It expires in a few minutes.</p>
</div>
</body>
</html>`;
}

export function createOAuthRouter(deps: OAuthDeps): Router {
  const router = Router();
  const correlationId = (): string => randomBytes(6).toString("hex");
  const log = (event: Omit<Parameters<typeof logOAuthEvent>[1], "correlationId" | "generation"> & { correlationId: string }): void =>
    logOAuthEvent(deps.logger, { ...event, generation: deps.generation });

  // ---- Discovery metadata -------------------------------------------------

  const asMetadataHandler = (req: Request, res: Response): void => {
    res.json(authorizationServerMetadata(deps.getBaseUrl(req)));
  };
  const prMetadataHandler = (req: Request, res: Response): void => {
    res.json(protectedResourceMetadata(deps.getBaseUrl(req)));
  };
  router.get("/.well-known/oauth-authorization-server", asMetadataHandler);
  router.get("/.well-known/oauth-authorization-server/mcp", asMetadataHandler);
  router.get("/.well-known/openid-configuration", asMetadataHandler);
  router.get("/.well-known/oauth-protected-resource", prMetadataHandler);
  router.get("/.well-known/oauth-protected-resource/mcp", prMetadataHandler);

  // ---- Dynamic Client Registration (RFC 7591) ------------------------------

  router.post("/oauth/register", json(), (req, res) => {
    const cid = correlationId();
    const body = req.body as { client_name?: string; redirect_uris?: unknown };
    const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
    if (
      redirectUris.length === 0 ||
      !redirectUris.every((uri) => typeof uri === "string" && isAllowedRedirectUri(uri))
    ) {
      log({ route: "register", method: "POST", outcome: "rejected", reason: "invalid_redirect_uri", correlationId: cid });
      res.status(400).json({
        error: "invalid_redirect_uri",
        error_description: "redirect_uris must be https URLs (or http://localhost for development)",
      });
      return;
    }
    const client = deps.store.registerClient({
      clientName: typeof body.client_name === "string" ? body.client_name.slice(0, 200) : undefined,
      redirectUris: redirectUris as string[],
    });
    deps.logger.info(`Registered OAuth client ${client.clientId} (${client.clientName ?? "unnamed"})`);
    log({ route: "register", method: "POST", outcome: "accepted", clientId: client.clientId, correlationId: cid });
    res.status(201).json({
      client_id: client.clientId,
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  });

  // ---- Authorization endpoint ----------------------------------------------

  router.get("/oauth/authorize", (req, res) => {
    const cid = correlationId();
    const query = req.query as Record<string, string | undefined>;
    const client = query.client_id ? deps.store.getClient(query.client_id) : undefined;
    if (!client) {
      log({ route: "authorize", method: "GET", outcome: "rejected", reason: "unknown_client", clientId: query.client_id, correlationId: cid });
      setAuthSecurityHeaders(res);
      res.status(400).send("Unknown client. Please reconnect from ChatGPT.");
      return;
    }
    const redirectUri = query.redirect_uri;
    if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
      log({ route: "authorize", method: "GET", outcome: "rejected", reason: "redirect_uri_mismatch", clientId: client.clientId, correlationId: cid });
      setAuthSecurityHeaders(res);
      res.status(400).send("Invalid redirect_uri.");
      return;
    }
    const fail = (error: string, description: string, reason: string): void => {
      log({ route: "authorize", method: "GET", outcome: "rejected", reason, clientId: client.clientId, correlationId: cid });
      const url = new URL(redirectUri);
      url.searchParams.set("error", error);
      url.searchParams.set("error_description", description);
      if (query.state) url.searchParams.set("state", query.state);
      res.redirect(url.toString());
    };
    if (query.response_type !== "code") {
      fail("unsupported_response_type", "Only response_type=code is supported", "unsupported_response_type");
      return;
    }
    if (!query.code_challenge || query.code_challenge_method !== "S256") {
      fail("invalid_request", "PKCE with S256 is required", "invalid_pkce_request");
      return;
    }
    const scopes = filterScopes(query.scope);
    if (scopes.length === 0) {
      // query.scope was non-empty but named only unsupported values —
      // never fall back to granting everything (see filterScopes).
      fail("invalid_scope", "None of the requested scopes are supported by this server", "invalid_scope");
      return;
    }
    const request = deps.store.createPendingAuthRequest({
      clientId: client.clientId,
      redirectUri,
      scopes,
      state: query.state,
      codeChallenge: query.code_challenge,
      resource: query.resource,
      ttlMs: 10 * 60_000,
    });
    log({ route: "authorize", method: "GET", outcome: "accepted", clientId: client.clientId, requestId: request.id, correlationId: cid });
    setAuthSecurityHeaders(res);
    res
      .status(200)
      .type("html")
      .send(pairingPage({ requestId: request.id, workspaceName: deps.workspaceName, scopes }));
  });

  router.post("/oauth/authorize", urlencoded({ extended: false }), (req, res) => {
    const cid = correlationId();
    const body = req.body as { request_id?: string; pairing_code?: string };
    const requestId = body.request_id;
    const request = requestId ? deps.store.getPendingAuthRequest(requestId) : undefined;

    if (!request) {
      // Independent review, 2026-09-03: deliberately a DIFFERENT message
      // from "expired" -- this request_id was never issued, or its
      // (unconditional, TTL-bounded) prune already removed it. "Expired"
      // below is reserved for a request that WAS found but is genuinely
      // past its original window; conflating the two made every failure
      // mode look identical to the user.
      log({ route: "authorize", method: "POST", outcome: "rejected", reason: "request_not_found", requestId, correlationId: cid });
      setAuthSecurityHeaders(res);
      res.status(400).send("Unknown authorization request. Please reconnect from ChatGPT.");
      return;
    }

    const redirectWithCode = (code: string): void => {
      const url = new URL(request.redirectUri);
      url.searchParams.set("code", code);
      if (request.state) url.searchParams.set("state", request.state);
      res.redirect(url.toString());
    };

    if (request.status === "consumed") {
      // IDEMPOTENT RETRY (independent review, 2026-09-03): this pairing
      // code was already proven correct once for this exact request. A
      // second POST here — browser double-submit, a back-button resubmit,
      // a downstream failure on ChatGPT's own side after the first
      // redirect — must not present the old, ambiguous "expired" message
      // (that was the actual reproduction of "1st Connect: no visible
      // change, 2nd Connect: expired"). Safely re-issue a FRESH,
      // single-use authorization code for the SAME client/redirect/PKCE
      // and redirect again, bounded by a retry cap.
      if (request.retryCount >= MAX_PENDING_AUTH_RETRIES) {
        log({ route: "authorize", method: "POST", outcome: "rejected", reason: "retry_limit_exceeded", requestId: request.id, clientId: request.clientId, correlationId: cid });
        setAuthSecurityHeaders(res);
        res.status(429).send("Too many attempts for this connection request. Please reconnect from ChatGPT.");
        return;
      }
      deps.store.incrementPendingAuthRequestRetry(request.id);
      const code = deps.store.createAuthorizationCode({
        clientId: request.clientId,
        redirectUri: request.redirectUri,
        codeChallenge: request.codeChallenge,
        scopes: request.scopes,
        pairingSessionId: "retry",
        resource: request.resource,
      });
      deps.logger.info(`Re-issued authorization code for already-verified request (client ${request.clientId})`);
      log({ route: "authorize", method: "POST", outcome: "accepted", reason: "idempotent_retry", requestId: request.id, clientId: request.clientId, correlationId: cid });
      redirectWithCode(code);
      return;
    }

    // status === "pending": first attempt, needs real pairing-code verification.
    const verdict = deps.pairing.verify(body.pairing_code ?? "", req.ip);
    if (!verdict.ok) {
      const messages: Record<string, string> = {
        invalid: `Incorrect pairing code.${verdict.attemptsLeft !== undefined ? ` ${verdict.attemptsLeft} attempts left.` : ""}`,
        expired: "This pairing code has expired. Ask your coding agent to generate a new one.",
        too_many_attempts: "Too many incorrect attempts. Ask your coding agent to generate a new pairing code.",
        rate_limited: "Too many attempts. Please wait a minute and try again.",
        no_active_session: "No active pairing session. Ask your coding agent to generate a pairing code.",
      };
      deps.logger.warn(`Pairing verification failed: ${verdict.reason}`);
      log({ route: "authorize", method: "POST", outcome: "rejected", reason: `pairing_${verdict.reason}`, requestId: request.id, clientId: request.clientId, correlationId: cid });
      setAuthSecurityHeaders(res);
      res
        .status(verdict.reason === "invalid" ? 401 : 410)
        .type("html")
        .send(
          pairingPage({
            requestId: request.id,
            workspaceName: deps.workspaceName,
            scopes: request.scopes,
            error: messages[verdict.reason] ?? "Verification failed.",
          })
        );
      return;
    }

    deps.store.markPendingAuthRequestConsumed(request.id);
    const code = deps.store.createAuthorizationCode({
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      scopes: request.scopes,
      pairingSessionId: verdict.sessionId,
      resource: request.resource,
    });
    deps.logger.info(`Pairing verified; issued authorization code for client ${request.clientId}`);
    log({ route: "authorize", method: "POST", outcome: "accepted", reason: "pairing_verified", requestId: request.id, clientId: request.clientId, correlationId: cid });
    redirectWithCode(code);
  });

  // ---- Token endpoint --------------------------------------------------------

  router.post("/oauth/token", urlencoded({ extended: false }), json(), (req, res) => {
    const cid = correlationId();
    const body = req.body as Record<string, string | undefined>;
    const grantType = body.grant_type;

    if (grantType === "authorization_code") {
      const { code, code_verifier: codeVerifier, client_id: clientId, redirect_uri: redirectUri } = body;
      if (!code || !codeVerifier || !clientId) {
        log({ route: "token", method: "POST", outcome: "rejected", reason: "invalid_request", clientId, correlationId: cid });
        res.status(400).json({ error: "invalid_request" });
        return;
      }
      const record = deps.store.consumeAuthorizationCode(code);
      if (!record || record.clientId !== clientId) {
        log({ route: "token", method: "POST", outcome: "rejected", reason: "invalid_grant_code", clientId, correlationId: cid });
        res.status(400).json({ error: "invalid_grant" });
        return;
      }
      if (redirectUri && redirectUri !== record.redirectUri) {
        log({ route: "token", method: "POST", outcome: "rejected", reason: "redirect_uri_mismatch", clientId, correlationId: cid });
        res.status(400).json({ error: "invalid_grant", error_description: "redirect_uri mismatch" });
        return;
      }
      if (!safeEqual(base64UrlSha256(codeVerifier), record.codeChallenge)) {
        deps.logger.warn("PKCE verification failed at token endpoint");
        log({ route: "token", method: "POST", outcome: "rejected", reason: "pkce_mismatch", clientId, correlationId: cid });
        res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
        return;
      }
      const tokens = deps.store.issueTokens({ clientId, scopes: record.scopes });
      deps.logger.info(`Issued access token for client ${clientId}`);
      log({ route: "token", method: "POST", outcome: "accepted", reason: "authorization_code", clientId, correlationId: cid });
      // This is potential proof an external OAuth client completed a live
      // round trip — but only if the request itself actually arrived via
      // the public origin, not loopback, AND the exchanging client isn't
      // doctor's own OAuth self-test client (independent review,
      // 2026-09-03: a diagnostic round trip doctor runs against itself
      // must never be able to masquerade as proof a real external client
      // connected — the same principle issueSelfTestToken() already
      // applies by excluding self-test tokens from
      // hasUsableAuthorization()/tokenCount()). The caller (server.ts)
      // verifies both before recording anything as confirmed.
      deps.onAuthorizationCodeExchanged?.(`${req.protocol}://${req.get("host") ?? ""}`, clientId);
      res.json({
        access_token: tokens.accessToken,
        token_type: "Bearer",
        expires_in: tokens.expiresIn,
        refresh_token: tokens.refreshToken ?? undefined,
        scope: tokens.scopes.join(" "),
      });
      return;
    }

    if (grantType === "refresh_token") {
      const { refresh_token: refreshToken, client_id: clientId } = body;
      if (!refreshToken || !clientId) {
        log({ route: "token", method: "POST", outcome: "rejected", reason: "invalid_request", clientId, correlationId: cid });
        res.status(400).json({ error: "invalid_request" });
        return;
      }
      const result = deps.store.refresh(refreshToken, clientId);
      if (!result.ok) {
        log({ route: "token", method: "POST", outcome: "rejected", reason: `refresh_${result.reason}`, clientId, correlationId: cid });
        res.status(400).json({ error: result.reason });
        return;
      }
      log({ route: "token", method: "POST", outcome: "accepted", reason: "refresh_token", clientId, correlationId: cid });
      res.json({
        access_token: result.tokens.accessToken,
        token_type: "Bearer",
        expires_in: result.tokens.expiresIn,
        refresh_token: result.tokens.refreshToken ?? undefined,
        scope: result.tokens.scopes.join(" "),
      });
      return;
    }

    log({ route: "token", method: "POST", outcome: "rejected", reason: "unsupported_grant_type", correlationId: cid });
    res.status(400).json({ error: "unsupported_grant_type" });
  });

  // ---- Revocation (RFC 7009) ---------------------------------------------------

  router.post("/oauth/revoke", urlencoded({ extended: false }), (req, res) => {
    const cid = correlationId();
    const body = req.body as { token?: string };
    const revoked = body.token ? deps.store.revokeToken(body.token) : false;
    log({ route: "revoke", method: "POST", outcome: revoked ? "accepted" : "rejected", reason: revoked ? undefined : "token_unknown", correlationId: cid });
    res.status(200).json({});
  });

  return router;
}
