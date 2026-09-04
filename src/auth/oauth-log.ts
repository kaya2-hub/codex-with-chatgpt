import type { Logger } from "../logger/index.js";

/**
 * Structured, secret-free logging for every OAuth route -- independent
 * review (2026-09-03, OAuth connector reliability): before this, only
 * SUCCESS paths were logged at all (`Registered OAuth client ...`,
 * `Pairing verified ...`, `Issued access token ...`); every rejection
 * branch (bad redirect_uri, unknown client, expired/consumed pending
 * request, PKCE mismatch, unknown token) returned an HTTP error with zero
 * log output. That made "the request never reached the bridge" and "it
 * reached the bridge and was silently rejected" look identical from local
 * logs -- exactly the ambiguity that made a real connector failure
 * impossible to diagnose without guessing.
 *
 * The `reason` field is always one of a small set of FIXED category
 * strings (see the call sites in oauth.ts/middleware.ts) -- never raw
 * user input, a token, a pairing code, an authorization code, or a
 * client_secret (which doesn't exist here; every client uses
 * token_endpoint_auth_method=none). `clientId` and `requestId` are public/
 * capability identifiers already visible to whoever is driving the flow
 * (client_id is meant to be public; requestId is already sent to the
 * user's own browser in the pairing page's hidden form field) -- logging
 * them server-side, where only the workspace owner can read logs, does
 * not expose anything to a party who doesn't already effectively have it.
 */
export interface OAuthLogEvent {
  route: "register" | "authorize" | "token" | "revoke";
  method: "GET" | "POST";
  outcome: "accepted" | "rejected";
  /** Fixed category string identifying WHY -- never free text. */
  reason?: string;
  clientId?: string;
  requestId?: string;
  /** This bridge process's own generation id (server.ts) -- lets a later
   *  reader tell whether a request pair (e.g. GET then POST) was handled
   *  by the same running process or straddled a restart. */
  generation?: string;
  /** Short id minted per HTTP request, for finding "this exact log line"
   *  quickly among concurrent requests -- not tied to any OAuth semantics. */
  correlationId: string;
}

export function logOAuthEvent(logger: Logger, event: OAuthLogEvent): void {
  const parts = [
    `[oauth] route=${event.route}`,
    `method=${event.method}`,
    `outcome=${event.outcome}`,
    event.reason ? `reason=${event.reason}` : undefined,
    event.clientId ? `client_id=${event.clientId}` : undefined,
    event.requestId ? `request_id=${event.requestId}` : undefined,
    event.generation ? `generation=${event.generation}` : undefined,
    `correlation_id=${event.correlationId}`,
  ].filter((part): part is string => Boolean(part));
  const line = parts.join(" ");
  if (event.outcome === "rejected") logger.warn(line);
  else logger.info(line);
}
