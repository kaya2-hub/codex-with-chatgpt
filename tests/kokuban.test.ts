import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveKokubanExtras, reportKokubanTransition } from "../src/session/kokuban.js";
import type { KokubanConfig } from "../src/workspace/manager.js";
import type { TaskCheckpoint } from "../src/session/state.js";

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

  it("includes holderAfter/stopReason in the body for a BLOCKED report", async () => {
    process.env.KOKUBAN_WRITE_TOKEN = "t";
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({ duplicate: false }), { status: 201 }));
    vi.stubGlobal("fetch", fetchSpy);

    await reportKokubanTransition({
      config: BASE_CONFIG,
      state: "BLOCKED",
      taskId: "c2c_x",
      iteration: 0,
      holderAfter: "human",
      stopReason: "awaiting review",
    });

    const [, requestInit] = fetchSpy.mock.calls[0]!;
    const body = JSON.parse(requestInit.body as string);
    expect(body.holderAfter).toBe("human");
    expect(body.stopReason).toBe("awaiting review");
  });

  it("drops holderAfter/stopReason for a non-BLOCKED report instead of sending a request Kokuban would reject", async () => {
    process.env.KOKUBAN_WRITE_TOKEN = "t";
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({ duplicate: false }), { status: 201 }));
    vi.stubGlobal("fetch", fetchSpy);

    // Simulates a stale/leftover checkpoint value from a prior BLOCKED
    // iteration still being derived while this report is actually PLAN.
    await reportKokubanTransition({
      config: BASE_CONFIG,
      state: "PLAN",
      taskId: "c2c_x",
      iteration: 0,
      holderAfter: "human",
      stopReason: "awaiting review",
    });

    const [, requestInit] = fetchSpy.mock.calls[0]!;
    const body = JSON.parse(requestInit.body as string);
    expect(body.holderAfter).toBeUndefined();
    expect(body.stopReason).toBeUndefined();
  });

  it("includes summary for any state, including non-BLOCKED", async () => {
    process.env.KOKUBAN_WRITE_TOKEN = "t";
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({ duplicate: false }), { status: 201 }));
    vi.stubGlobal("fetch", fetchSpy);

    await reportKokubanTransition({ config: BASE_CONFIG, state: "EXECUTED", taskId: "c2c_x", iteration: 0, summary: "Migration done.\nNext: deploy." });

    const [, requestInit] = fetchSpy.mock.calls[0]!;
    const body = JSON.parse(requestInit.body as string);
    expect(body.summary).toBe("Migration done.\nNext: deploy.");
  });

  it("omits summary from the body when blank/absent", async () => {
    process.env.KOKUBAN_WRITE_TOKEN = "t";
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({ duplicate: false }), { status: 201 }));
    vi.stubGlobal("fetch", fetchSpy);

    await reportKokubanTransition({ config: BASE_CONFIG, state: "EXECUTED", taskId: "c2c_x", iteration: 0, summary: "   " });

    const [, requestInit] = fetchSpy.mock.calls[0]!;
    const body = JSON.parse(requestInit.body as string);
    expect(body.summary).toBeUndefined();
  });
});

function checkpoint(overrides: Partial<TaskCheckpoint>): TaskCheckpoint {
  return { taskId: "c2c_x", iteration: 0, protocolState: "BLOCKED", waitingFor: "none", updatedAt: new Date().toISOString(), ...overrides };
}

describe("deriveKokubanExtras", () => {
  it("returns nothing when there is no checkpoint yet", () => {
    expect(deriveKokubanExtras(undefined)).toEqual({});
  });

  it("maps waitingFor=USER to holderAfter=human", () => {
    expect(deriveKokubanExtras(checkpoint({ waitingFor: "USER" })).holderAfter).toBe("human");
  });

  it("maps waitingFor=GPT_PLAN and GPT_REVIEW to holderAfter=chatgpt", () => {
    expect(deriveKokubanExtras(checkpoint({ waitingFor: "GPT_PLAN" })).holderAfter).toBe("chatgpt");
    expect(deriveKokubanExtras(checkpoint({ waitingFor: "GPT_REVIEW" })).holderAfter).toBe("chatgpt");
  });

  it("maps waitingFor=CONDITION and EXTERNAL to their own holderAfter values", () => {
    expect(deriveKokubanExtras(checkpoint({ waitingFor: "CONDITION" })).holderAfter).toBe("condition");
    expect(deriveKokubanExtras(checkpoint({ waitingFor: "EXTERNAL" })).holderAfter).toBe("external");
  });

  it("leaves holderAfter undefined for waitingFor=none", () => {
    expect(deriveKokubanExtras(checkpoint({ waitingFor: "none" })).holderAfter).toBeUndefined();
  });

  it("maps knownIssues to stopReason verbatim", () => {
    expect(deriveKokubanExtras(checkpoint({ knownIssues: "flaky test on CI" })).stopReason).toBe("flaky test on CI");
  });

  it("builds summary by mechanically joining completedSubtasks, nextExpectedStep, and knownIssues in that order", () => {
    const extras = deriveKokubanExtras(checkpoint({ completedSubtasks: "did A", nextExpectedStep: "do B", knownIssues: "watch out for C" }));
    expect(extras.summary).toBe("did A\ndo B\nwatch out for C");
  });

  it("skips missing fields rather than leaving blank lines in the summary", () => {
    const extras = deriveKokubanExtras(checkpoint({ completedSubtasks: "did A" }));
    expect(extras.summary).toBe("did A");
  });

  it("skips a whitespace-only field too, not just missing/empty ones", () => {
    const extras = deriveKokubanExtras(
      checkpoint({ completedSubtasks: "did A", nextExpectedStep: "   ", knownIssues: "issue C" }),
    );
    expect(extras.summary).toBe("did A\nissue C");
  });

  it("leaves summary undefined when the checkpoint has none of the three fields", () => {
    expect(deriveKokubanExtras(checkpoint({})).summary).toBeUndefined();
  });
});
