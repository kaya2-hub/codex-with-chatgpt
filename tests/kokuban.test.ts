import { afterEach, describe, expect, it, vi } from "vitest";
import { reportKokubanTransition } from "../src/session/kokuban.js";
import type { KokubanConfig } from "../src/workspace/manager.js";

const BASE_CONFIG: KokubanConfig = { projectKey: "bluecabi-personal-core" };

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.KOKUBAN_WRITE_TOKEN;
  delete process.env.CUSTOM_TOKEN_VAR;
});

describe("reportKokubanTransition", () => {
  it("skips silently (attempted:false) for a state that isn't a C2C wire state", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await reportKokubanTransition({ config: BASE_CONFIG, state: "EXECUTED_SENT", taskId: "c2c_x", iteration: 0 });
    expect(result.attempted).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports attempted:true but ok:false when taskId is missing, without calling fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await reportKokubanTransition({ config: BASE_CONFIG, state: "PLAN", taskId: undefined, iteration: 0 });
    expect(result.attempted).toBe(true);
    expect(result.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports attempted:true but ok:false when the token env var isn't set, without calling fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await reportKokubanTransition({ config: BASE_CONFIG, state: "PLAN", taskId: "c2c_x", iteration: 0 });
    expect(result.attempted).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("KOKUBAN_WRITE_TOKEN");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("honors a custom tokenEnvVar name instead of the default", async () => {
    process.env.CUSTOM_TOKEN_VAR = "shh";
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({ duplicate: false }), { status: 201 }));
    vi.stubGlobal("fetch", fetchSpy);
    const result = await reportKokubanTransition({
      config: { ...BASE_CONFIG, tokenEnvVar: "CUSTOM_TOKEN_VAR" },
      state: "PLAN",
      taskId: "c2c_x",
      iteration: 0,
    });
    expect(result.ok).toBe(true);
    const [, requestInit] = fetchSpy.mock.calls[0]!;
    expect((requestInit.headers as Record<string, string>).Authorization).toBe("Bearer shh");
  });

  it("posts the expected C2C envelope to the default API base URL, never exposing the token in the result", async () => {
    process.env.KOKUBAN_WRITE_TOKEN = "super-secret-token";
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({ duplicate: false }), { status: 201 }));
    vi.stubGlobal("fetch", fetchSpy);

    const result = await reportKokubanTransition({ config: BASE_CONFIG, state: "executed", taskId: "c2c_x", iteration: 2 });

    expect(result).toEqual({ attempted: true, ok: true, detail: "recorded" });
    expect(JSON.stringify(result)).not.toContain("super-secret-token");

    const [url, requestInit] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://core.bluecabi.net/v1/kokuban/c2c-events");
    expect(requestInit.method).toBe("POST");
    expect((requestInit.headers as Record<string, string>).Authorization).toBe("Bearer super-secret-token");
    const body = JSON.parse(requestInit.body as string);
    expect(body.projectKey).toBe("bluecabi-personal-core");
    expect(body.actor).toBe("coding_agent");
    expect(body.message).toBe("[C2C]\nSTATE: EXECUTED\nTASK_ID: c2c_x\nITERATION: 2");
    expect(typeof body.occurredAt).toBe("string");
  });

  it("uses a custom apiBaseUrl and actor from config when provided", async () => {
    process.env.KOKUBAN_WRITE_TOKEN = "t";
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({ duplicate: false }), { status: 201 }));
    vi.stubGlobal("fetch", fetchSpy);

    await reportKokubanTransition({
      config: { ...BASE_CONFIG, apiBaseUrl: "https://staging.example.com/", actor: "codex" },
      state: "INIT",
      taskId: "c2c_x",
      iteration: 0,
    });

    const [url, requestInit] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://staging.example.com/v1/kokuban/c2c-events");
    const body = JSON.parse(requestInit.body as string);
    expect(body.actor).toBe("codex");
  });

  it("reports a resend as a duplicate rather than a plain success", async () => {
    process.env.KOKUBAN_WRITE_TOKEN = "t";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ duplicate: true }), { status: 200 })));
    const result = await reportKokubanTransition({ config: BASE_CONFIG, state: "DONE", taskId: "c2c_x", iteration: 3 });
    expect(result).toEqual({ attempted: true, ok: true, detail: "already recorded (duplicate)" });
  });

  it("surfaces a non-2xx response as a failure carrying the status code, not a thrown error", async () => {
    process.env.KOKUBAN_WRITE_TOKEN = "t";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "conflict" }), { status: 409 })));
    const result = await reportKokubanTransition({ config: BASE_CONFIG, state: "BLOCKED", taskId: "c2c_x", iteration: 1 });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("409");
  });

  it("never throws when fetch itself rejects (network failure)", async () => {
    process.env.KOKUBAN_WRITE_TOKEN = "t";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("getaddrinfo ENOTFOUND")));
    const result = await reportKokubanTransition({ config: BASE_CONFIG, state: "PLAN", taskId: "c2c_x", iteration: 0 });
    expect(result.attempted).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("ENOTFOUND");
  });
});
