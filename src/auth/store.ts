import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureDir, getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";

export const SUPPORTED_SCOPES = [
  "workspace.read",
  "workspace.search",
  "git.read",
  "execution.read",
  "offline_access",
] as const;

export type Scope = (typeof SUPPORTED_SCOPES)[number];

export interface ClientRegistration {
  clientId: string;
  clientName?: string;
  redirectUris: string[];
  createdAt: string;
}

/** On-disk shape: the authorization code itself is never persisted, only a
 *  SHA-256 hash of it (same pattern as TokenRecord) -- a one-time-use OAuth
 *  authorization code is a bearer credential exactly like an access token,
 *  so it gets the same "never store the plaintext" treatment. */
interface PersistedAuthorizationCode {
  hash: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  workspaceId: string;
  pairingSessionId: string;
  resource?: string;
  expiresAt: number;
}

export interface AuthorizationCodeRecord {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  workspaceId: string;
  pairingSessionId: string;
  resource?: string;
  expiresAt: number;
}

export type PendingAuthRequestStatus = "pending" | "consumed";

/**
 * Durable record of one `GET /oauth/authorize` request, from creation
 * through pairing verification and any safe retries -- independent review
 * (2026-09-03, OAuth connector reliability): this used to be a plain
 * in-memory Map local to the OAuth router's closure, wiped on every bridge
 * restart, which is exactly what turned a routine restart mid-pairing into
 * "This authorization request has expired." Contains no secret: `id` is a
 * capability the user's own browser already holds (it's sent to them in
 * the pairing page's hidden form field); `codeChallenge` is PKCE's public
 * half by design; nothing else here is credential-shaped at all.
 */
export interface PendingAuthRequestRecord {
  id: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state?: string;
  codeChallenge: string;
  resource?: string;
  createdAt: number;
  expiresAt: number;
  status: PendingAuthRequestStatus;
  /** Bumped each time an already-"consumed" request is safely re-issued a
   *  fresh authorization code (browser double-submit, retry after a
   *  downstream redirect/exchange failure) -- capped by the caller
   *  (MAX_PENDING_AUTH_RETRIES in oauth.ts) so a stuck client can't mint
   *  unlimited codes forever. */
  retryCount: number;
}

export interface TokenRecord {
  hash: string;
  /** "self_test" is a doctor-only, least-privilege token used to exercise the
   *  real bearerAuth + /mcp code path end to end (see AuthStore.issueSelfTestToken).
   *  It is a valid bearer credential for /mcp, but is deliberately excluded from
   *  tokenCount()/hasUsableAuthorization() — those two exist specifically to answer
   *  "has ChatGPT's own connector authorized against this workspace", and a
   *  self-test token issued and revoked within a single `doctor` run must never
   *  contaminate that signal. */
  kind: "access" | "refresh" | "self_test";
  clientId: string;
  workspaceId: string;
  scopes: string[];
  issuedAt: number;
  expiresAt: number;
  revoked: boolean;
}

interface PersistedAuthState {
  clients: ClientRegistration[];
  tokens: TokenRecord[];
  pendingAuthRequests?: PendingAuthRequestRecord[];
  authorizationCodes?: PersistedAuthorizationCode[];
}

export type VerifyTokenResult =
  | { ok: true; record: TokenRecord }
  | { ok: false; reason: "unknown" | "expired" | "revoked" | "wrong_kind" };

const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
/** Short by design: a self-test token only needs to live for one `doctor`
 *  round trip (issue -> call /mcp -> revoke), never for a real client session. */
const SELF_TEST_TOKEN_TTL_MS = 60 * 1000;
const SELF_TEST_CLIENT_ID = "c2c-doctor-self-test";
/** Fixed, not caller-supplied -- least privilege must hold by construction,
 *  not by every caller happening to ask for the minimal set. */
const SELF_TEST_SCOPES: readonly Scope[] = ["workspace.read"];

function sha256hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function newToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

export function base64UrlSha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

/** Constant-time string comparison for equal-length inputs. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export class AuthStore {
  private clients = new Map<string, ClientRegistration>();
  private tokens = new Map<string, TokenRecord>();
  private authCodes = new Map<string, PersistedAuthorizationCode>();
  private pendingAuthRequests = new Map<string, PendingAuthRequestRecord>();
  private readonly file: string;

  constructor(
    readonly workspaceId: string,
    opts: { file?: string } = {}
  ) {
    this.file =
      opts.file ?? path.join(ensureDir(path.join(getStateDir(), "auth")), `${workspaceId}.json`);
    this.load();
  }

  private load(): void {
    const data = readJsonIfExists<PersistedAuthState>(this.file);
    if (!data) return;
    const now = Date.now();
    for (const client of data.clients ?? []) this.clients.set(client.clientId, client);
    for (const token of data.tokens ?? []) {
      // self_test must never be reconstituted from disk -- unconditional,
      // regardless of revoked/expiresAt, so even a token an older or buggy
      // build once wrote to this exact file can never come back to life on
      // restart. See issueSelfTestToken(); reviewed 2026-09-03.
      if (token.kind === "self_test") continue;
      if (!token.revoked && token.expiresAt > now) this.tokens.set(token.hash, token);
    }
    for (const code of data.authorizationCodes ?? []) {
      if (code.expiresAt > now) this.authCodes.set(code.hash, code);
    }
    for (const request of data.pendingAuthRequests ?? []) {
      if (request.expiresAt > now) this.pendingAuthRequests.set(request.id, request);
    }
  }

  private save(): void {
    const now = Date.now();
    const state: PersistedAuthState = {
      clients: [...this.clients.values()],
      // self_test is excluded unconditionally (not just when expired/revoked)
      // -- it must never touch disk, no matter what other operation on this
      // same AuthStore instance happens to trigger a save() while one is
      // still live in memory (a concurrent real OAuth issuance, a client
      // registration, another token's revoke, or another concurrent
      // doctor invocation's own self-test token). See issueSelfTestToken().
      tokens: [...this.tokens.values()].filter((t) => t.kind !== "self_test" && !t.revoked && t.expiresAt > now),
      authorizationCodes: [...this.authCodes.values()].filter((c) => c.expiresAt > now),
      pendingAuthRequests: [...this.pendingAuthRequests.values()].filter((r) => r.expiresAt > now),
    };
    writeSecureJson(this.file, state);
  }

  // ---- Dynamic Client Registration -------------------------------------

  registerClient(input: { clientName?: string; redirectUris: string[] }): ClientRegistration {
    const client: ClientRegistration = {
      clientId: `c2c_client_${randomBytes(12).toString("base64url")}`,
      clientName: input.clientName,
      redirectUris: input.redirectUris,
      createdAt: new Date().toISOString(),
    };
    this.clients.set(client.clientId, client);
    this.save();
    return client;
  }

  getClient(clientId: string): ClientRegistration | undefined {
    return this.clients.get(clientId);
  }

  /** Removes a client registration -- currently only used to keep the store
   *  clean after `doctor`'s own OAuth self-test client (see
   *  src/auth/oauth-self-test.ts), never for a real ChatGPT/Codex client:
   *  "recreate the client" must never be the answer to a real connector
   *  problem (independent review, 2026-09-03). Also revokes any tokens
   *  still issued to it, so a removed client can't keep authenticating on
   *  credentials issued before removal. */
  unregisterClient(clientId: string): boolean {
    const existed = this.clients.delete(clientId);
    if (!existed) return false;
    for (const [hash, token] of this.tokens) {
      if (token.clientId === clientId) this.tokens.delete(hash);
    }
    for (const [hash, code] of this.authCodes) {
      if (code.clientId === clientId) this.authCodes.delete(hash);
    }
    this.save();
    return true;
  }

  // ---- Authorization codes ----------------------------------------------

  createAuthorizationCode(input: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    scopes: string[];
    pairingSessionId: string;
    resource?: string;
  }): string {
    const code = newToken("c2c_ac");
    this.authCodes.set(sha256hex(code), {
      hash: sha256hex(code),
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      scopes: input.scopes,
      workspaceId: this.workspaceId,
      pairingSessionId: input.pairingSessionId,
      resource: input.resource,
      expiresAt: Date.now() + AUTH_CODE_TTL_MS,
    });
    this.save();
    return code;
  }

  /** One-time consumption of an authorization code -- durable across a
   *  bridge restart (independent review, 2026-09-03: this used to be a
   *  plain in-memory Map, wiped on restart, the same class of bug as the
   *  pending-authorize-request map below). Only the code's SHA-256 hash is
   *  ever persisted, matching TokenRecord's own "never store the plaintext
   *  bearer credential" convention. */
  consumeAuthorizationCode(code: string): AuthorizationCodeRecord | null {
    const hash = sha256hex(code);
    const record = this.authCodes.get(hash);
    if (!record) return null;
    this.authCodes.delete(hash);
    this.save();
    if (Date.now() > record.expiresAt) return null;
    const { hash: _hash, ...rest } = record;
    return rest;
  }

  // ---- Pending OAuth authorize requests (durable across restart) ---------

  /** Step 1 of the authorize flow: durably persist a fresh pending request
   *  -- MUST be called from `GET /oauth/authorize` before the pairing page
   *  is shown, so a bridge restart between "page shown" and "pairing code
   *  submitted" doesn't silently drop it (see PendingAuthRequestRecord's
   *  doc comment). */
  createPendingAuthRequest(input: {
    clientId: string;
    redirectUri: string;
    scopes: string[];
    state?: string;
    codeChallenge: string;
    resource?: string;
    ttlMs: number;
  }): PendingAuthRequestRecord {
    this.prunePendingAuthRequests();
    const record: PendingAuthRequestRecord = {
      id: randomBytes(16).toString("hex"),
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      scopes: input.scopes,
      state: input.state,
      codeChallenge: input.codeChallenge,
      resource: input.resource,
      createdAt: Date.now(),
      expiresAt: Date.now() + input.ttlMs,
      status: "pending",
      retryCount: 0,
    };
    this.pendingAuthRequests.set(record.id, record);
    this.save();
    return record;
  }

  /** Read-only lookup, pruning expired entries opportunistically first. */
  getPendingAuthRequest(id: string): PendingAuthRequestRecord | undefined {
    this.prunePendingAuthRequests();
    return this.pendingAuthRequests.get(id);
  }

  /** Marks a pending request "consumed" the FIRST time its pairing code is
   *  verified -- deliberately does NOT delete it (independent review,
   *  2026-09-03: the previous design deleted the pending request the
   *  instant the pairing code checked out, BEFORE anything confirmed the
   *  subsequent redirect + ChatGPT's own token exchange actually
   *  succeeded -- a browser double-submit or a downstream hiccup then hit
   *  an ambiguous "expired" error on what was, from the user's
   *  perspective, still their first legitimate attempt). Once "consumed",
   *  see incrementPendingAuthRequestRetry() for the safe-retry path. */
  markPendingAuthRequestConsumed(id: string): void {
    const record = this.pendingAuthRequests.get(id);
    if (!record) return;
    record.status = "consumed";
    this.save();
  }

  /** Bumps and returns the retry counter for an idempotent re-issue of an
   *  already-"consumed" pending request (see oauth.ts's POST handler,
   *  which caps this at MAX_PENDING_AUTH_RETRIES). */
  incrementPendingAuthRequestRetry(id: string): number {
    const record = this.pendingAuthRequests.get(id);
    if (!record) return 0;
    record.retryCount++;
    this.save();
    return record.retryCount;
  }

  /** TTL-based cleanup -- called opportunistically by create/get above, so
   *  no separate timer/process is needed. Never removes anything still
   *  within its original 10-minute window, whether "pending" or
   *  "consumed". */
  private prunePendingAuthRequests(): void {
    const now = Date.now();
    let changed = false;
    for (const [id, record] of this.pendingAuthRequests) {
      if (now > record.expiresAt) {
        this.pendingAuthRequests.delete(id);
        changed = true;
      }
    }
    if (changed) this.save();
  }

  // ---- Tokens -------------------------------------------------------------

  issueTokens(input: {
    clientId: string;
    scopes: string[];
    workspaceId?: string;
    accessTtlMs?: number;
  }): { accessToken: string; refreshToken: string | null; expiresIn: number; scopes: string[] } {
    const now = Date.now();
    const workspaceId = input.workspaceId ?? this.workspaceId;
    const accessTtl = input.accessTtlMs ?? ACCESS_TOKEN_TTL_MS;

    const accessToken = newToken("c2c_at");
    this.tokens.set(sha256hex(accessToken), {
      hash: sha256hex(accessToken),
      kind: "access",
      clientId: input.clientId,
      workspaceId,
      scopes: input.scopes,
      issuedAt: now,
      expiresAt: now + accessTtl,
      revoked: false,
    });

    let refreshToken: string | null = null;
    if (input.scopes.includes("offline_access")) {
      refreshToken = newToken("c2c_rt");
      this.tokens.set(sha256hex(refreshToken), {
        hash: sha256hex(refreshToken),
        kind: "refresh",
        clientId: input.clientId,
        workspaceId,
        scopes: input.scopes,
        issuedAt: now,
        expiresAt: now + REFRESH_TOKEN_TTL_MS,
        revoked: false,
      });
    }
    this.save();
    return {
      accessToken,
      refreshToken,
      expiresIn: Math.floor(accessTtl / 1000),
      scopes: input.scopes,
    };
  }

  verifyAccessToken(token: string): VerifyTokenResult {
    const record = this.tokens.get(sha256hex(token));
    if (!record) return { ok: false, reason: "unknown" };
    // A self-test token is a valid bearer credential for /mcp -- it exercises the
    // exact same bearerAuth code path a real access token does (see issueSelfTestToken).
    if (record.kind !== "access" && record.kind !== "self_test") return { ok: false, reason: "wrong_kind" };
    if (record.revoked) return { ok: false, reason: "revoked" };
    if (Date.now() > record.expiresAt) return { ok: false, reason: "expired" };
    return { ok: true, record };
  }

  /**
   * Issue a least-privilege, short-lived token for `doctor`'s own real
   * bearerAuth + /mcp round trip (P0-3, connector reliability hardening).
   * Deliberately NOT `issueTokens()`: that path is for real OAuth clients and
   * its output feeds `tokenCount()`/`hasUsableAuthorization()`, which exist
   * specifically to answer "has ChatGPT's own connector authorized against
   * this workspace" -- a self-test token issued by the local CLI itself must
   * never be able to make that answer "yes" on its own. Not persisted to
   * disk: it only ever needs to be verified within this same running bridge
   * process, by the same `doctor` invocation that requested it, before its
   * caller explicitly revokes it (or its 60s TTL elapses).
   */
  issueSelfTestToken(): { token: string; expiresAt: number } {
    const now = Date.now();
    const token = newToken("c2c_st");
    const expiresAt = now + SELF_TEST_TOKEN_TTL_MS;
    this.tokens.set(sha256hex(token), {
      hash: sha256hex(token),
      kind: "self_test",
      clientId: SELF_TEST_CLIENT_ID,
      workspaceId: this.workspaceId,
      scopes: [...SELF_TEST_SCOPES],
      issuedAt: now,
      expiresAt,
      revoked: false,
    });
    return { token, expiresAt };
  }

  /** Refresh-token rotation: old refresh token is revoked, a new pair is issued. */
  refresh(
    refreshToken: string,
    clientId: string
  ): { ok: true; tokens: ReturnType<AuthStore["issueTokens"]> } | { ok: false; reason: string } {
    const record = this.tokens.get(sha256hex(refreshToken));
    if (!record || record.kind !== "refresh") return { ok: false, reason: "invalid_grant" };
    if (record.revoked) return { ok: false, reason: "invalid_grant" };
    if (Date.now() > record.expiresAt) return { ok: false, reason: "invalid_grant" };
    if (record.clientId !== clientId) return { ok: false, reason: "invalid_client" };
    record.revoked = true;
    this.tokens.delete(record.hash);
    const tokens = this.issueTokens({
      clientId,
      scopes: record.scopes,
      workspaceId: record.workspaceId,
    });
    return { ok: true, tokens };
  }

  revokeToken(token: string): boolean {
    const record = this.tokens.get(sha256hex(token));
    if (!record) return false;
    record.revoked = true;
    this.tokens.delete(record.hash);
    this.save();
    return true;
  }

  /** Used by `c2c unpair`: revoke everything for this workspace. */
  revokeAll(): number {
    const count = this.tokens.size;
    this.tokens.clear();
    this.authCodes.clear();
    this.pendingAuthRequests.clear();
    this.save();
    return count;
  }

  /** Excludes self_test tokens -- see TokenRecord.kind. */
  tokenCount(): number {
    let count = 0;
    for (const token of this.tokens.values()) {
      if (token.kind !== "self_test") count++;
    }
    return count;
  }

  /** Unlike `tokenCount()`, this re-checks expiry live rather than trusting
   *  the in-memory map's size — a token can be valid at server start and
   *  silently expire while the process keeps running, since only `load()`
   *  and `save()` prune expired entries. "authorized" must mean "there is
   *  at least one token usable right now", not "a token object still
   *  exists in memory". Does not by itself prove ChatGPT is using the
   *  current public URL — only that this workspace's auth store has live
   *  credentials. */
  hasUsableAuthorization(): boolean {
    const now = Date.now();
    for (const token of this.tokens.values()) {
      // A self-test token proves the local MCP round trip works, not that
      // ChatGPT's own connector holds a credential -- must never count here.
      if (token.kind === "self_test") continue;
      if (!token.revoked && token.expiresAt > now) return true;
    }
    return false;
  }

  static deleteStateFile(workspaceId: string): void {
    const file = path.join(getStateDir(), "auth", `${workspaceId}.json`);
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // ignore
    }
  }
}

/** No `scope` param at all means "the client didn't ask" — default to the
 *  full supported set, per usual OAuth practice. An explicit `scope` that
 *  names only unrecognized values must NOT silently widen to everything —
 *  that would let a typo or an unrelated client request escalate to full
 *  access. Callers must treat an empty result as `invalid_scope`, not as
 *  "fall back to default". */
export function filterScopes(requested: string | undefined): string[] {
  if (!requested || requested.trim() === "") return [...SUPPORTED_SCOPES];
  const asked = requested.split(/[\s+]+/).filter(Boolean);
  return asked.filter((scope) => (SUPPORTED_SCOPES as readonly string[]).includes(scope));
}
