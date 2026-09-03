import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { AuthStore } from "../src/auth/store.js";
import { makeTmpDir } from "./helpers.js";

// P0-3 (connector reliability hardening): AuthStore.issueSelfTestToken lets
// `doctor` exercise the real bearerAuth ACCEPT path end to end, without ever
// being confused for a real ChatGPT-issued credential. These are the
// properties that make that safe: least privilege, short TTL, and total
// exclusion from the two signals ("has ChatGPT authorized this workspace")
// that the rest of the system actually relies on.

function freshStore(): AuthStore {
  return new AuthStore("self-test-ws", { file: path.join(makeTmpDir("self-test-auth"), "store.json") });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("AuthStore.issueSelfTestToken", () => {
  it("issues a token that verifies as a valid bearer credential", () => {
    const store = freshStore();
    const { token } = store.issueSelfTestToken();
    const verdict = store.verifyAccessToken(token);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.record.kind).toBe("self_test");
      expect(verdict.record.clientId).toBe("c2c-doctor-self-test");
    }
  });

  it("defaults to least-privilege scope (workspace.read only)", () => {
    const store = freshStore();
    const { token } = store.issueSelfTestToken();
    const verdict = store.verifyAccessToken(token);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.record.scopes).toEqual(["workspace.read"]);
  });

  it("never counts toward tokenCount() or hasUsableAuthorization()", () => {
    const store = freshStore();
    expect(store.tokenCount()).toBe(0);
    expect(store.hasUsableAuthorization()).toBe(false);
    store.issueSelfTestToken();
    // The token itself verifies fine (see above) -- but the two signals that
    // answer "has ChatGPT's own connector authorized against this workspace"
    // must stay exactly as if nothing happened.
    expect(store.tokenCount()).toBe(0);
    expect(store.hasUsableAuthorization()).toBe(false);
  });

  it("does not affect tokenCount()/hasUsableAuthorization() even alongside a real token", () => {
    const store = freshStore();
    store.issueTokens({ clientId: "real-chatgpt-client", scopes: ["workspace.read"] });
    expect(store.tokenCount()).toBe(1);
    expect(store.hasUsableAuthorization()).toBe(true);
    store.issueSelfTestToken();
    expect(store.tokenCount()).toBe(1);
    expect(store.hasUsableAuthorization()).toBe(true);
  });

  it("becomes unusable once explicitly revoked", () => {
    const store = freshStore();
    const { token } = store.issueSelfTestToken();
    expect(store.verifyAccessToken(token).ok).toBe(true);
    expect(store.revokeToken(token)).toBe(true);
    expect(store.verifyAccessToken(token).ok).toBe(false);
  });

  it("expires after its short TTL (60s), well before a real access token would (1h)", () => {
    vi.useFakeTimers();
    const store = freshStore();
    const { token, expiresAt } = store.issueSelfTestToken();
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(60_000);
    vi.advanceTimersByTime(61_000);
    const verdict = store.verifyAccessToken(token);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("expired");
  });
});

// Independent review (ChatGPT, via the real C2C connector, 2026-09-03) found
// that AuthStore.save()/load() did not exclude kind "self_test" -- a
// self-test token still "live" (unrevoked, unexpired) when ANY other
// operation on the same AuthStore instance triggered a save() (a real OAuth
// issuance, a client registration, another token's revoke, or a concurrent
// doctor invocation's own self-test revoke) would be written to disk, and
// load() would happily restore it after a restart. These tests pin the fix:
// self_test must never appear on disk, and must never come back from disk,
// unconditionally -- not just when its own TTL/revoked state say so.
describe("AuthStore self_test tokens: never persisted, never restored (regression)", () => {
  it("never appears on disk, even when another operation on the same store triggers save()", () => {
    const file = path.join(makeTmpDir("self-test-persist"), "store.json");
    const store = new AuthStore("self-test-ws", { file });
    store.issueSelfTestToken();
    // issueTokens() persists internally -- while the self-test token above
    // is still live in memory, unrevoked.
    store.issueTokens({ clientId: "real-client", scopes: ["workspace.read"] });

    const onDisk = JSON.parse(fs.readFileSync(file, "utf8")) as { tokens: { kind: string }[] };
    expect(onDisk.tokens.some((t) => t.kind === "self_test")).toBe(false);
    expect(onDisk.tokens).toHaveLength(1);
    expect(onDisk.tokens[0].kind).toBe("access");
  });

  it("ignores a self_test token found in an on-disk fixture, as if written by an older/buggy build, even though it would otherwise still be valid", () => {
    const file = path.join(makeTmpDir("self-test-fixture"), "store.json");
    const legacyToken = "c2c_st_legacy-fixture-token";
    const hash = createHash("sha256").update(legacyToken).digest("hex");
    fs.writeFileSync(
      file,
      JSON.stringify({
        clients: [],
        tokens: [
          {
            hash,
            kind: "self_test",
            clientId: "c2c-doctor-self-test",
            workspaceId: "self-test-ws",
            scopes: ["workspace.read"],
            issuedAt: Date.now(),
            expiresAt: Date.now() + 60_000, // unexpired -- would otherwise still verify fine
            revoked: false,
          },
        ],
      }),
      "utf8"
    );

    const store = new AuthStore("self-test-ws", { file });
    expect(store.verifyAccessToken(legacyToken).ok).toBe(false);
    expect(store.tokenCount()).toBe(0);
    expect(store.hasUsableAuthorization()).toBe(false);
  });

  it("does not survive a simulated crash-and-restart even when never explicitly revoked (e.g. doctor killed mid-flight)", () => {
    const file = path.join(makeTmpDir("self-test-crash"), "store.json");
    const store = new AuthStore("self-test-ws", { file });
    const { token } = store.issueSelfTestToken();
    // Stands in for whatever real activity coincides with a doctor run that
    // never reaches its own revoke() -- e.g. the process is killed between
    // issuing and revoking the self-test token.
    store.issueTokens({ clientId: "real-client", scopes: ["workspace.read"] });

    // Simulated restart: a fresh AuthStore reloading the SAME file.
    const restarted = new AuthStore("self-test-ws", { file });
    expect(restarted.verifyAccessToken(token).ok).toBe(false);
  });

  it("does not change save/load behavior for real access and refresh tokens", () => {
    const file = path.join(makeTmpDir("self-test-normal"), "store.json");
    const store = new AuthStore("self-test-ws", { file });
    const issued = store.issueTokens({ clientId: "real-client", scopes: ["workspace.read", "offline_access"] });
    store.issueSelfTestToken();

    const restarted = new AuthStore("self-test-ws", { file });
    const accessVerdict = restarted.verifyAccessToken(issued.accessToken);
    expect(accessVerdict.ok).toBe(true);
    if (accessVerdict.ok) expect(accessVerdict.record.kind).toBe("access");
    // offline_access issues both an access AND a refresh token record --
    // tokenCount() counts both (pre-existing behavior, unrelated to this
    // fix); the point of this assertion is that it is unaffected by the
    // self_test token issued alongside them, not any particular number.
    expect(restarted.tokenCount()).toBe(2);
    expect(restarted.hasUsableAuthorization()).toBe(true);

    expect(issued.refreshToken).not.toBeNull();
    const refreshResult = restarted.refresh(issued.refreshToken as string, "real-client");
    expect(refreshResult.ok).toBe(true);
  });
});
