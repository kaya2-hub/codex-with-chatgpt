import type { KokubanConfig } from "../workspace/manager.js";

const DEFAULT_API_BASE_URL = "https://core.bluecabi.net";
const DEFAULT_TOKEN_ENV_VAR = "KOKUBAN_WRITE_TOKEN";
const DEFAULT_ACTOR = "coding_agent";

/** The 5 wire-protocol states Kokuban's C2C adapter accepts -- c2c-dev's own richer local ProtocolState (INIT/PLAN_RECEIVED/EXECUTING/...) is a different, unrelated enum. */
const C2C_WIRE_STATES = new Set(["INIT", "PLAN", "EXECUTED", "DONE", "BLOCKED"]);

export interface KokubanReportInput {
  config: KokubanConfig;
  state: string;
  taskId: string | undefined;
  iteration: number | undefined;
}

export interface KokubanReportResult {
  /** False for a `session set` call this feature simply doesn't apply to (not a wire state, or no taskId yet) -- not worth surfacing to the user. */
  attempted: boolean;
  ok: boolean;
  /** Never contains the bearer token or a raw response body -- safe to print. */
  detail: string;
}

/**
 * Best-effort report of one confirmed C2C state transition to Kokuban
 * (Personal Core's Activity Event Log) -- the single hook point every
 * Kokuban-enabled workspace's `session set` goes through, so no
 * per-workspace producer gets invented. Never throws: `session set`'s real
 * job (recording the ChatGPT chat pointer) must succeed independently of
 * whether Kokuban is reachable. The bearer token is read from an env var by
 * name only -- its value is never included in the returned detail, logged,
 * or sent anywhere but the Authorization header of this one request.
 */
export async function reportKokubanTransition(input: KokubanReportInput): Promise<KokubanReportResult> {
  const { config, state, taskId, iteration } = input;
  const normalizedState = state.trim().toUpperCase();
  if (!C2C_WIRE_STATES.has(normalizedState)) {
    return { attempted: false, ok: false, detail: `"${state}" is not a C2C wire state` };
  }
  if (!taskId || iteration === undefined || !Number.isInteger(iteration) || iteration < 0) {
    return { attempted: true, ok: false, detail: "task id / iteration not set on this session" };
  }

  const tokenEnvVar = config.tokenEnvVar?.trim() || DEFAULT_TOKEN_ENV_VAR;
  const token = process.env[tokenEnvVar];
  if (!token) {
    return { attempted: true, ok: false, detail: `${tokenEnvVar} is not set` };
  }

  const apiBaseUrl = (config.apiBaseUrl?.trim() || DEFAULT_API_BASE_URL).replace(/\/+$/, "");
  const actor = config.actor?.trim() || DEFAULT_ACTOR;
  const message = `[C2C]\nSTATE: ${normalizedState}\nTASK_ID: ${taskId}\nITERATION: ${iteration}`;

  try {
    const res = await fetch(`${apiBaseUrl}/v1/kokuban/c2c-events`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        projectKey: config.projectKey,
        actor,
        occurredAt: new Date().toISOString(),
        message,
      }),
      redirect: "error",
    });
    if (!res.ok) {
      return { attempted: true, ok: false, detail: `HTTP ${res.status}` };
    }
    const body = (await res.json().catch(() => null)) as { duplicate?: boolean } | null;
    return { attempted: true, ok: true, detail: body?.duplicate ? "already recorded (duplicate)" : "recorded" };
  } catch (error) {
    return { attempted: true, ok: false, detail: error instanceof Error ? error.message : "network error" };
  }
}
