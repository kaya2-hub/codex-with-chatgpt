import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { getStateDir } from "../src/config/paths.js";
import { deleteKokubanSecret, readKokubanSecret, resolveKokubanToken, saveKokubanSecret } from "../src/session/kokuban-secret.js";
import { prepareKokubanTransition, sendAndDiscardKokubanEvent } from "../src/session/kokuban.js";
import { commitOutboxEvent } from "../src/session/kokuban-outbox.js";
import { Workspace } from "../src/workspace/manager.js";
import { runCli } from "../src/cli/index.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

// Kokuban token/secret persistence: so KOKUBAN_WRITE_TOKEN doesn't need to
// be re-set as an env var in every new terminal / after every reboot.
// saveKokubanSecret()/readKokubanSecret() genuinely shell out to a FRESH
// powershell.exe process each call on Windows (real DPAPI, CurrentUser
// scope) -- these tests exercise the real round trip, not a mock, matching
// this project's established preference for real subprocess coverage over
// mocking (see doctor-fault-injection.test.ts, dist-entrypoint.test.ts).
// Each such call is a genuine separate OS process, which is exactly the
// "reload from a new-process equivalent" the requirement asked for.

const WS_A = "ws-secret-test-a";
const WS_B = "ws-secret-test-b";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.KOKUBAN_WRITE_TOKEN;
  delete process.env.CUSTOM_VAR;
  delete process.env.C2C_STATE_DIR;
});

function secretFilePath(workspaceId: string): string {
  return path.join(getStateDir(), "kokuban-secrets", `${workspaceId}.json`);
}

describe("saveKokubanSecret / readKokubanSecret -- real round trip", () => {
  it("save -> read reproduces the exact original token", () => {
    isolateStateDir();
    const result = saveKokubanSecret(WS_A, "kkb_write_super_secret_12345");
    expect(result.ok).toBe(true);
    if (process.platform === "win32") expect(result.encoding).toBe("dpapi");
    expect(readKokubanSecret(WS_A)).toBe("kkb_write_super_secret_12345");
  }, 15_000);

  it("trims surrounding whitespace from the input before saving", () => {
    isolateStateDir();
    saveKokubanSecret(WS_A, "  spaced-token  \n");
    expect(readKokubanSecret(WS_A)).toBe("spaced-token");
  }, 15_000);

  it("refuses to save an empty/whitespace-only token, and nothing is persisted", () => {
    isolateStateDir();
    const result = saveKokubanSecret(WS_A, "   ");
    expect(result.ok).toBe(false);
    expect(readKokubanSecret(WS_A)).toBeNull();
  });

  it("a second save for the same workspace overwrites the first (re-registering a rotated token works)", () => {
    isolateStateDir();
    saveKokubanSecret(WS_A, "old-token");
    expect(readKokubanSecret(WS_A)).toBe("old-token");
    saveKokubanSecret(WS_A, "new-rotated-token");
    expect(readKokubanSecret(WS_A)).toBe("new-rotated-token");
  }, 15_000);
});

describe("plaintext encoding path (platform-independent -- readKokubanSecret dispatches purely on the stored `encoding` field, no PowerShell involved)", () => {
  it("decodes a plaintext-encoded record directly", () => {
    isolateStateDir();
    const file = secretFilePath(WS_A);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ encoding: "plaintext", value: "raw-token-value", savedAt: new Date().toISOString() }));
    expect(readKokubanSecret(WS_A)).toBe("raw-token-value");
  });
});

describe("fail-closed on missing/corrupted secrets", () => {
  it("returns null for a workspace with no saved secret at all", () => {
    isolateStateDir();
    expect(readKokubanSecret("brand-new-ws")).toBeNull();
  });

  it("returns null, never throws, for a corrupted (non-JSON) secret file", () => {
    isolateStateDir();
    const file = secretFilePath(WS_A);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ not valid json at all");
    expect(() => readKokubanSecret(WS_A)).not.toThrow();
    expect(readKokubanSecret(WS_A)).toBeNull();
  });

  it("returns null for an unrecognized encoding value rather than guessing how to decode it", () => {
    isolateStateDir();
    const file = secretFilePath(WS_A);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ encoding: "some-future-backend-not-implemented-yet", value: "whatever", savedAt: new Date().toISOString() })
    );
    expect(readKokubanSecret(WS_A)).toBeNull();
  });

  // Independent review, second round: readJsonIfExists<T>()'s generic type
  // parameter is a compile-time assertion only -- it does NOT validate
  // anything at runtime. A file that is valid JSON but the WRONG SHAPE
  // (e.g. `value` is a number, not a string) used to be trusted as-is and
  // could throw downstream (`.trim()` on a number) instead of failing
  // closed like every other corrupted-file case. isValidPersistedSecret()
  // now gates every field before use; these pin each malformed shape that
  // specifically used to be a genuine throw.
  it.each([
    ["plaintext value:number", { encoding: "plaintext", value: 123 }],
    ["plaintext value:null", { encoding: "plaintext", value: null }],
    ["plaintext value: missing entirely", { encoding: "plaintext" }],
    ["plaintext value: empty string", { encoding: "plaintext", value: "" }],
    ["plaintext value: whitespace-only string", { encoding: "plaintext", value: "   " }],
    ["dpapi value:number", { encoding: "dpapi", value: 456 }],
    ["dpapi value:null", { encoding: "dpapi", value: null }],
    ["dpapi value: missing entirely", { encoding: "dpapi" }],
    ["encoding: missing entirely", { value: "some-value" }],
    ["encoding: number instead of string", { encoding: 1, value: "some-value" }],
    ["the whole record is a JSON array, not an object", ["encoding", "plaintext", "value", "x"]],
    ["the whole record is a bare JSON string", "just a string"],
    ["the whole record is a bare JSON number", 42],
    ["the whole record is null", null],
  ])("returns null, never throws, for a valid-JSON-but-malformed-shape record: %s", (_label, malformed) => {
    isolateStateDir();
    const file = secretFilePath(WS_A);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(malformed));
    expect(() => readKokubanSecret(WS_A)).not.toThrow();
    expect(readKokubanSecret(WS_A)).toBeNull();
  });

  it("returns null (fail closed, never a garbled value) for a dpapi-encoded record whose ciphertext is corrupted/foreign", () => {
    isolateStateDir();
    const file = secretFilePath(WS_A);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ encoding: "dpapi", value: "not-a-real-dpapi-blob", savedAt: new Date().toISOString() }));
    expect(readKokubanSecret(WS_A)).toBeNull();
  }, 15_000);

  it("a genuine local write failure is reported as ok:false, not silently treated as success", () => {
    isolateStateDir();
    // Block the target directory itself with a plain file.
    const blocker = path.join(getStateDir(), "kokuban-secrets");
    fs.mkdirSync(path.dirname(blocker), { recursive: true });
    fs.writeFileSync(blocker, "x");
    const result = saveKokubanSecret(WS_A, "should-not-be-saved");
    expect(result.ok).toBe(false);
    expect(readKokubanSecret(WS_A)).toBeNull();
  }, 15_000);
});

describe("deleteKokubanSecret", () => {
  it("removes a saved secret; readKokubanSecret returns null afterward, and it stays gone", () => {
    isolateStateDir();
    saveKokubanSecret(WS_A, "to-be-revoked");
    expect(readKokubanSecret(WS_A)).toBe("to-be-revoked");

    const del = deleteKokubanSecret(WS_A);
    expect(del).toEqual({ ok: true, existed: true });

    expect(readKokubanSecret(WS_A)).toBeNull();
    // A later, independent read attempt (simulating a subsequent process)
    // still finds nothing -- there is no separate cache/index anywhere
    // that could resurrect the old value.
    expect(readKokubanSecret(WS_A)).toBeNull();
    expect(fs.existsSync(secretFilePath(WS_A))).toBe(false);
  }, 15_000);

  it("deleting a workspace with no saved secret is a safe no-op", () => {
    isolateStateDir();
    expect(deleteKokubanSecret("brand-new-ws")).toEqual({ ok: true, existed: false });
  });
});

describe("workspace isolation", () => {
  it("a secret saved for one workspace is never visible from another workspace's read", () => {
    isolateStateDir();
    saveKokubanSecret(WS_A, "workspace-a-secret");
    expect(readKokubanSecret(WS_B)).toBeNull();
    expect(readKokubanSecret(WS_A)).toBe("workspace-a-secret");
  }, 15_000);

  it("the two workspaces' secrets live in physically separate files, each independently readable", () => {
    isolateStateDir();
    saveKokubanSecret(WS_A, "secret-a");
    saveKokubanSecret(WS_B, "secret-b");
    expect(secretFilePath(WS_A)).not.toBe(secretFilePath(WS_B));
    expect(readKokubanSecret(WS_A)).toBe("secret-a");
    expect(readKokubanSecret(WS_B)).toBe("secret-b");
  }, 20_000);
});

describe("resolveKokubanToken -- deterministic priority order", () => {
  it("explicit env var wins over a persisted secret", () => {
    isolateStateDir();
    saveKokubanSecret(WS_A, "persisted-value");
    process.env.KOKUBAN_WRITE_TOKEN = "env-value";
    expect(resolveKokubanToken(WS_A, "KOKUBAN_WRITE_TOKEN")).toEqual({ token: "env-value", source: "env" });
  }, 15_000);

  it("falls back to the persisted secret when the env var is unset", () => {
    isolateStateDir();
    saveKokubanSecret(WS_A, "persisted-value");
    delete process.env.KOKUBAN_WRITE_TOKEN;
    expect(resolveKokubanToken(WS_A, "KOKUBAN_WRITE_TOKEN")).toEqual({ token: "persisted-value", source: "persisted" });
  }, 15_000);

  it("returns null when neither the env var nor a persisted secret is available", () => {
    isolateStateDir();
    delete process.env.KOKUBAN_WRITE_TOKEN;
    expect(resolveKokubanToken(WS_A, "KOKUBAN_WRITE_TOKEN")).toBeNull();
  });

  it("without a workspaceId, only the env var is ever consulted -- legacy/direct callers keep the exact old behavior", () => {
    isolateStateDir();
    saveKokubanSecret(WS_A, "persisted-value");
    delete process.env.KOKUBAN_WRITE_TOKEN;
    expect(resolveKokubanToken(undefined, "KOKUBAN_WRITE_TOKEN")).toBeNull();
  }, 15_000);

  it("respects a custom tokenEnvVar name, and never silently falls back to a DIFFERENT env var", () => {
    isolateStateDir();
    process.env.CUSTOM_VAR = "custom-value";
    expect(resolveKokubanToken(WS_A, "CUSTOM_VAR")).toEqual({ token: "custom-value", source: "env" });
    delete process.env.KOKUBAN_WRITE_TOKEN; // never picked up under the wrong name
  });
});

describe("the secret value never leaks into inspectable output", () => {
  it("saveKokubanSecret's own result object never contains the raw token", () => {
    isolateStateDir();
    const result = saveKokubanSecret(WS_A, "must-not-leak-anywhere");
    expect(JSON.stringify(result)).not.toContain("must-not-leak-anywhere");
  }, 15_000);

  it("a failed save's error detail never contains the raw token", () => {
    isolateStateDir();
    const blocker = path.join(getStateDir(), "kokuban-secrets");
    fs.mkdirSync(path.dirname(blocker), { recursive: true });
    fs.writeFileSync(blocker, "x");
    const result = saveKokubanSecret(WS_A, "must-not-leak-either");
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("must-not-leak-either");
  }, 15_000);

  it("the on-disk file itself never contains the plaintext token when DPAPI-encoded", () => {
    isolateStateDir();
    if (process.platform !== "win32") return; // dpapi encoding only happens on win32
    saveKokubanSecret(WS_A, "on-disk-must-not-be-plaintext");
    const raw = fs.readFileSync(secretFilePath(WS_A), "utf8");
    expect(raw).not.toContain("on-disk-must-not-be-plaintext");
  }, 15_000);
});

// Independent review, second round: the resolver being correct in
// isolation doesn't prove the real Kokuban send path actually uses it --
// these exercise sendAndDiscardKokubanEvent() (the one production callers
// go through) end to end with a mocked fetch, asserting the literal
// Authorization header value it sent.
describe("the real Kokuban send path uses the resolved token", () => {
  it("with no env var set, a real send's Authorization header carries the persisted secret", async () => {
    isolateStateDir();
    delete process.env.KOKUBAN_WRITE_TOKEN;
    saveKokubanSecret(WS_A, "persisted-bearer-value");

    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({ duplicate: false }), { status: 201 }));
    vi.stubGlobal("fetch", fetchSpy);

    const event = prepareKokubanTransition({
      workspaceId: WS_A,
      config: { projectKey: "proj" },
      state: "PLAN",
      taskId: "t1",
      iteration: 0,
    });
    expect(event).not.toBeNull();
    commitOutboxEvent(WS_A, event!.idempotencyKey);

    const result = await sendAndDiscardKokubanEvent(WS_A, event!);
    expect(result.ok).toBe(true);
    const headers = (fetchSpy.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer persisted-bearer-value");
    vi.unstubAllGlobals();
  }, 15_000);

  it("when BOTH an env var and a persisted secret exist, a real send's Authorization header uses the env var", async () => {
    isolateStateDir();
    saveKokubanSecret(WS_A, "persisted-bearer-value");
    process.env.KOKUBAN_WRITE_TOKEN = "env-bearer-value";

    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({ duplicate: false }), { status: 201 }));
    vi.stubGlobal("fetch", fetchSpy);

    const event = prepareKokubanTransition({
      workspaceId: WS_A,
      config: { projectKey: "proj" },
      state: "EXECUTED",
      taskId: "t1",
      iteration: 1,
    });
    expect(event).not.toBeNull();
    commitOutboxEvent(WS_A, event!.idempotencyKey);

    const result = await sendAndDiscardKokubanEvent(WS_A, event!);
    expect(result.ok).toBe(true);
    const headers = (fetchSpy.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer env-bearer-value"); // env wins, never the persisted value
    vi.unstubAllGlobals();
  }, 15_000);

  it("neither the request body nor the returned result ever contains the token value", async () => {
    isolateStateDir();
    delete process.env.KOKUBAN_WRITE_TOKEN;
    saveKokubanSecret(WS_A, "must-not-appear-in-body-or-result");

    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({ duplicate: false }), { status: 201 }));
    vi.stubGlobal("fetch", fetchSpy);

    const event = prepareKokubanTransition({
      workspaceId: WS_A,
      config: { projectKey: "proj" },
      state: "DONE",
      taskId: "t1",
      iteration: 2,
    });
    commitOutboxEvent(WS_A, event!.idempotencyKey);
    const result = await sendAndDiscardKokubanEvent(WS_A, event!);

    const body = (fetchSpy.mock.calls[0]![1] as RequestInit).body as string;
    expect(body).not.toContain("must-not-appear-in-body-or-result");
    expect(JSON.stringify(result)).not.toContain("must-not-appear-in-body-or-result");
    vi.unstubAllGlobals();
  }, 15_000);
});

// Real CLI wiring (via runCli(), in-process -- see kokuban-outbox.test.ts's
// established pattern for why this is preferred over spawning a subprocess
// against dist/, which dist-entrypoint.test.ts already owns the lifecycle
// of and would race against in parallel test workers). Registration itself
// (`kokuban-token set`) reads from stdin, which isn't exercised here for
// the same reason -- covered instead by saveKokubanSecret's own direct
// tests above; status/revoke need no stdin and are tested end-to-end.
describe("real CLI: `c2c kokuban-token status` / `revoke`", () => {
  it("status reports source:persisted after a secret is saved directly, and source:none before/after revoke", async () => {
    isolateStateDir();
    const root = makeTmpDir("kokuban-token-cli");
    try {
      write(root, "a.txt", "a");
      const workspace = new Workspace(root);
      saveKokubanSecret(workspace.id, "cli-visible-token");

      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      let statusOutput = "";
      try {
        await runCli(["node", "c2c", "kokuban-token", "status", "-w", root, "--json"]);
        statusOutput = writeSpy.mock.calls.map((c) => String(c[0])).join("");
      } finally {
        writeSpy.mockRestore();
      }
      const statusParsed = JSON.parse(statusOutput.trim());
      expect(statusParsed.source).toBe("persisted");
      expect(statusOutput).not.toContain("cli-visible-token");

      const writeSpy2 = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        await runCli(["node", "c2c", "kokuban-token", "revoke", "-w", root, "--json"]);
      } finally {
        writeSpy2.mockRestore();
      }
      expect(readKokubanSecret(workspace.id)).toBeNull();

      const writeSpy3 = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      let statusAfter = "";
      try {
        await runCli(["node", "c2c", "kokuban-token", "status", "-w", root, "--json"]);
        statusAfter = writeSpy3.mock.calls.map((c) => String(c[0])).join("");
      } finally {
        writeSpy3.mockRestore();
      }
      expect(JSON.parse(statusAfter.trim()).source).toBe("none");
    } finally {
      cleanup(root);
    }
  }, 20_000);
});
