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

export interface AuthorizationCodeRecord {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  workspaceId: string;
  pairingSessionId: string;
  resource?: string;
  expiresAt: number;
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
  private authCodes = new Map<string, AuthorizationCodeRecord>();
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
    this.authCodes.set(code, {
      code,
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      scopes: input.scopes,
      workspaceId: this.workspaceId,
      pairingSessionId: input.pairingSessionId,
      resource: input.resource,
      expiresAt: Date.now() + AUTH_CODE_TTL_MS,
    });
    return code;
  }

  /** One-time consumption of an authorization code. */
  consumeAuthorizationCode(code: string): AuthorizationCodeRecord | null {
    const record = this.authCodes.get(code);
    if (!record) return null;
    this.authCodes.delete(code);
    if (Date.now() > record.expiresAt) return null;
    return record;
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
