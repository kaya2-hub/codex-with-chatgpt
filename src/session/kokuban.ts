import type { KokubanConfig } from "../workspace/manager.js";
import type { TaskCheckpoint, WaitingFor } from "./state.js";

const DEFAULT_API_BASE_URL = "https://core.bluecabi.net";
const DEFAULT_TOKEN_ENV_VAR = "KOKUBAN_WRITE_TOKEN";
const DEFAULT_ACTOR = "coding_agent";

/** waitingFor -> Kokuban holderAfter, for BLOCKED reports only. Deliberately a fixed table, not inference. */
const HOLDER_AFTER_BY_WAITING_FOR: Partial<Record<WaitingFor, string>> = {
  USER: "human",
  GPT_PLAN: "chatgpt",
  GPT_REVIEW: "chatgpt",
  CONDITION: "condition",
  EXTERNAL: "external",
};

export interface KokubanExtras {
  holderAfter?: string;
  stopReason?: string;
  summary?: string;
}

/**
 * Turns a session's existing, already-explicit checkpoint fields into the
 * extra Kokuban fields for one report -- never natural-language inference,
 * just a fixed table (waitingFor -> holderAfter) plus mechanical
 * concatenation of fields the user already typed into --known-issues/
 * --next-step (and --completed-subtasks, tracked separately from --goal).
 * Safe to call for any state: reportKokubanTransition itself gates
 * holderAfter/stopReason to BLOCKED-only, so passing them through
 * unconditionally here for a non-BLOCKED report is a no-op, not a rejection.
 */
export function deriveKokubanExtras(checkpoint: TaskCheckpoint | undefined): KokubanExtras {
  if (!checkpoint) return {};
  const isBlank = (value: string | undefined): value is undefined => !value || !value.trim();
  return {
    holderAfter: checkpoint.waitingFor ? HOLDER_AFTER_BY_WAITING_FOR[checkpoint.waitingFor] : undefined,
    stopReason: checkpoint.knownIssues,
    summary:
      [checkpoint.completedSubtasks, checkpoint.nextExpectedStep, checkpoint.knownIssues]
        .filter((value): value is string => !isBlank(value))
        .join("\n") || undefined,
  };
}

/** The 5 wire-protocol states Kokuban's C2C adapter accepts -- c2c-dev's own richer local ProtocolState (INIT/PLAN_RECEIVED/EXECUTING/...) is a different, unrelated enum. */
const C2C_WIRE_STATES = new Set(["INIT", "PLAN", "EXECUTED", "DONE", "BLOCKED"]);

export interface KokubanReportInput {
  config: KokubanConfig;
  state: string;
  taskId: string | undefined;
  iteration: number | undefined;
  /**
   * Only ever forwarded when state is BLOCKED (see the gate below) --
   * Kokuban's own C2C adapter rejects holderAfter/stopReason outright for
   * every other state, and this function enforces the same rule locally so
   * a caller mistake here can never produce a rejected POST for a routine
   * INIT/PLAN/EXECUTED/DONE report.
   */
  holderAfter?: string;
  stopReason?: string;
  /** Sent for any state when present -- mechanically built from explicit checkpoint fields by the caller, never inferred here. */
  summary?: string;
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
  const isBlocked = normalizedState === "BLOCKED";
  const summary = input.summary?.trim() || undefined;

  try {
    const res = await fetch(`${apiBaseUrl}/v1/kokuban/c2c-events`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        projectKey: config.projectKey,
        actor,
        occurredAt: new Date().toISOString(),
        message,
        // Kokuban itself rejects these for any non-BLOCKED state -- gating
        // here too means a caller passing them for the wrong state degrades
        // to "silently omitted" instead of "the whole report gets rejected".
        ...(isBlocked && input.holderAfter?.trim() ? { holderAfter: input.holderAfter.trim() } : {}),
        ...(isBlocked && input.stopReason?.trim() ? { stopReason: input.stopReason.trim() } : {}),
        ...(summary ? { summary } : {}),
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
