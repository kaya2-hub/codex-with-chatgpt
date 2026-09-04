import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readJsonIfExists, writeSecureJson } from "../config/paths.js";

/**
 * PairingCode: a short-lived, one-time, local verification credential shown
 * on the authorization page. This is NOT an OAuth Authorization Code.
 */
export interface PairingSession {
  id: string;
  codeHash: Buffer;
  workspaceId: string;
  createdAt: number;
  expiresAt: number;
  attemptsLeft: number;
  used: boolean;
}

/** On-disk shape: `codeHash` (a Buffer) is stored as hex, never the raw
 *  pairing code itself -- same "hash only" convention as every other
 *  bearer-credential-shaped value this codebase persists. */
interface PersistedPairingSession {
  id: string;
  codeHash: string;
  workspaceId: string;
  createdAt: number;
  expiresAt: number;
  attemptsLeft: number;
  used: boolean;
}

export interface PairingVerifyOk {
  ok: true;
  sessionId: string;
}

export interface PairingVerifyFail {
  ok: false;
  reason: "invalid" | "expired" | "too_many_attempts" | "rate_limited" | "no_active_session";
  attemptsLeft?: number;
}

export type PairingVerifyResult = PairingVerifyOk | PairingVerifyFail;

// No ambiguous characters (I, L, O, 0, 1).
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function generateCode(length = 8): string {
  const chars: string[] = [];
  while (chars.length < length) {
    const bytes = randomBytes(length * 2);
    for (const byte of bytes) {
      // rejection sampling for uniformity
      if (byte < Math.floor(256 / ALPHABET.length) * ALPHABET.length) {
        chars.push(ALPHABET[byte % ALPHABET.length]);
        if (chars.length === length) break;
      }
    }
  }
  return chars.join("");
}

function hashCode(code: string): Buffer {
  return createHash("sha256").update(code).digest();
}

export function formatPairingCode(raw: string): string {
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
}

export function normalizePairingCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z2-9]/g, "");
}

export interface PairingManagerOptions {
  ttlMs?: number;
  maxAttempts?: number;
  ipRateLimit?: number;
  ipRateWindowMs?: number;
  /**
   * When provided, the current session persists to this file and survives
   * a process restart -- independent review (2026-09-03, OAuth connector
   * reliability): without this, a bridge restart between "pairing code
   * shown to the user" and "user types it in" orphans the code exactly
   * like the OAuth pending-authorize-request map did before it was made
   * durable (see AuthStore.createPendingAuthRequest). Only ever stores a
   * SHA-256 hash of the code, never the code itself -- same convention as
   * every other bearer-credential-shaped value this codebase persists.
   * `ipHits` (rate-limit counters) are deliberately NOT persisted -- losing
   * them on restart only ever makes the rate limit momentarily more
   * lenient, never less safe.
   */
  file?: string;
}

export class PairingManager {
  private sessions = new Map<string, PairingSession>();
  private ipHits = new Map<string, { count: number; resetAt: number }>();
  private readonly ttlMs: number;
  private readonly maxAttempts: number;
  private readonly ipRateLimit: number;
  private readonly ipRateWindowMs: number;
  private readonly file?: string;

  constructor(
    private readonly workspaceId: string,
    opts: PairingManagerOptions = {}
  ) {
    this.ttlMs = opts.ttlMs ?? 5 * 60_000;
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.ipRateLimit = opts.ipRateLimit ?? 10;
    this.ipRateWindowMs = opts.ipRateWindowMs ?? 60_000;
    this.file = opts.file;
    this.load();
  }

  private load(): void {
    if (!this.file) return;
    const data = readJsonIfExists<PersistedPairingSession[]>(this.file);
    if (!data) return;
    const now = Date.now();
    for (const persisted of data) {
      if (persisted.used || now > persisted.expiresAt) continue; // never reconstitute a dead session
      this.sessions.set(persisted.id, {
        id: persisted.id,
        codeHash: Buffer.from(persisted.codeHash, "hex"),
        workspaceId: persisted.workspaceId,
        createdAt: persisted.createdAt,
        expiresAt: persisted.expiresAt,
        attemptsLeft: persisted.attemptsLeft,
        used: persisted.used,
      });
    }
  }

  private save(): void {
    if (!this.file) return;
    const now = Date.now();
    const state: PersistedPairingSession[] = [...this.sessions.values()]
      .filter((s) => !s.used && now <= s.expiresAt)
      .map((s) => ({
        id: s.id,
        codeHash: s.codeHash.toString("hex"),
        workspaceId: s.workspaceId,
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
        attemptsLeft: s.attemptsLeft,
        used: s.used,
      }));
    writeSecureJson(this.file, state);
  }

  /**
   * Create a new session ONLY if none is currently active -- returns `null`
   * without touching anything if one already is. Synchronous and therefore
   * atomic with respect to every other request this process handles (no
   * `await` between the check and the mutation, so nothing can interleave
   * within this process). Exists so a caller that must never clobber a
   * real, in-progress pairing (doctor's OAuth self-test) can safely attempt
   * pairing without the TOCTOU an earlier "check pairingActive once, then
   * later call the unconditional create()" sequence had -- a real
   * `c2c pair` landing in that gap would have been silently destroyed by
   * the self-test's own subsequent create() (independent review,
   * 2026-09-04). `create()` itself stays unconditional -- a real
   * `c2c pair` must still be able to invalidate a stale prior session on
   * purpose.
   */
  createIfNoneActive(): { sessionId: string; code: string; expiresAt: number } | null {
    if (this.hasActiveSession()) return null;
    return this.create();
  }

  /** Create a new pairing session. Invalidates previous sessions (one active at a time). */
  create(): { sessionId: string; code: string; expiresAt: number } {
    this.sessions.clear();
    const raw = generateCode();
    const session: PairingSession = {
      id: randomBytes(16).toString("hex"),
      codeHash: hashCode(raw),
      workspaceId: this.workspaceId,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.ttlMs,
      attemptsLeft: this.maxAttempts,
      used: false,
    };
    this.sessions.set(session.id, session);
    this.save();
    return { sessionId: session.id, code: formatPairingCode(raw), expiresAt: session.expiresAt };
  }

  private checkIpRate(ip: string | undefined): boolean {
    if (!ip) return true;
    const now = Date.now();
    const entry = this.ipHits.get(ip);
    if (!entry || now > entry.resetAt) {
      this.ipHits.set(ip, { count: 1, resetAt: now + this.ipRateWindowMs });
      return true;
    }
    entry.count++;
    return entry.count <= this.ipRateLimit;
  }

  verify(codeInput: string, ip?: string): PairingVerifyResult {
    if (!this.checkIpRate(ip)) {
      return { ok: false, reason: "rate_limited" };
    }
    const normalized = normalizePairingCode(codeInput);
    const inputHash = hashCode(normalized);
    const now = Date.now();

    const active = [...this.sessions.values()].filter((s) => !s.used);
    if (active.length === 0) return { ok: false, reason: "no_active_session" };

    for (const session of active) {
      if (now > session.expiresAt) {
        this.sessions.delete(session.id);
        this.save();
        return { ok: false, reason: "expired" };
      }
      if (session.attemptsLeft <= 0) {
        this.sessions.delete(session.id);
        this.save();
        return { ok: false, reason: "too_many_attempts" };
      }
      const match = timingSafeEqual(inputHash, session.codeHash);
      if (match) {
        // one-time use: destroy immediately
        session.used = true;
        this.sessions.delete(session.id);
        this.save();
        return { ok: true, sessionId: session.id };
      }
      session.attemptsLeft--;
      if (session.attemptsLeft <= 0) {
        this.sessions.delete(session.id);
        this.save();
        return { ok: false, reason: "too_many_attempts" };
      }
      this.save();
      return { ok: false, reason: "invalid", attemptsLeft: session.attemptsLeft };
    }
    return { ok: false, reason: "no_active_session" };
  }

  hasActiveSession(): boolean {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (!session.used && now <= session.expiresAt) return true;
    }
    return false;
  }

  invalidateAll(): void {
    this.sessions.clear();
    this.save();
  }
}
