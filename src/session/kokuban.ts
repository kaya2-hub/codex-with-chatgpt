import type { EffectiveKokubanConfig } from "./kokuban-config.js";
import type { TaskCheckpoint, WaitingFor } from "./state.js";
import { readSession } from "./state.js";
import { resolveKokubanToken } from "./kokuban-secret.js";
import {
  commitOutboxEvent,
  computeIdempotencyKey,
  discardOutboxEvent,
  listOutboxEntries,
  prepareOutboxEvent,
  readOutboxEvent,
  runUnderKokubanLock,
  type KokubanCanonicalEvent,
} from "./kokuban-outbox.js";

const DEFAULT_API_BASE_URL = "https://core.bluecabi.net";
export const DEFAULT_TOKEN_ENV_VAR = "KOKUBAN_WRITE_TOKEN";
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

/** Exported so the outbox/prepare path can gate on the exact same rule
 *  reportKokubanTransition itself enforces, without duplicating the set. */
export function isC2cWireState(state: string): boolean {
  return C2C_WIRE_STATES.has(state.trim().toUpperCase());
}

export interface KokubanReportInput {
  config: EffectiveKokubanConfig;
  state: string;
  taskId: string | undefined;
  iteration: number | undefined;
  /**
   * Enables the persisted-secret fallback (see resolveKokubanToken in
   * kokuban-secret.ts) when the token env var isn't set. Optional so
   * direct/legacy callers that don't pass one keep the exact old
   * "env var or nothing" behavior, unchanged.
   */
  workspaceId?: string;
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
  /**
   * Fixed once by the outbox at prepare() time and passed through unchanged
   * on every retry -- a retry of the SAME event must send byte-identical
   * `occurredAt`, never a freshly-generated one (connector reliability
   * hardening, Kokuban ITERATION 1). Omitted only by direct/legacy callers
   * that don't go through the outbox, in which case "now" is used, exactly
   * as before this parameter existed.
   */
  occurredAt?: string;
}

export interface KokubanReportResult {
  /** False for a `session set` call this feature simply doesn't apply to (not a wire state, or no taskId yet) -- not worth surfacing to the user. */
  attempted: boolean;
  ok: boolean;
  /** Never contains the bearer token or a raw response body -- safe to print. */
  detail: string;
}

interface BuildBodyInput {
  projectKey: string;
  actor: string;
  occurredAt: string;
  message: string;
  isBlocked: boolean;
  holderAfter?: string;
  stopReason?: string;
  summary?: string;
}

/** The exact JSON shape POSTed to Kokuban -- factored out so the immediate
 *  send path (reportKokubanTransition) and the outbox's stored requestBody
 *  (prepareKokubanTransition) can never drift apart into two different
 *  serializations of "the same" event (independent review). */
function buildKokubanRequestBody(input: BuildBodyInput): string {
  return JSON.stringify({
    projectKey: input.projectKey,
    actor: input.actor,
    occurredAt: input.occurredAt,
    message: input.message,
    // Kokuban itself rejects these for any non-BLOCKED state -- gating
    // here too means a caller passing them for the wrong state degrades
    // to "silently omitted" instead of "the whole report gets rejected".
    ...(input.isBlocked && input.holderAfter?.trim() ? { holderAfter: input.holderAfter.trim() } : {}),
    ...(input.isBlocked && input.stopReason?.trim() ? { stopReason: input.stopReason.trim() } : {}),
    ...(input.summary ? { summary: input.summary } : {}),
  });
}

async function postKokubanRequestBody(
  apiBaseUrl: string,
  tokenEnvVar: string,
  rawBody: string,
  workspaceId?: string
): Promise<KokubanReportResult> {
  const resolved = resolveKokubanToken(workspaceId, tokenEnvVar);
  if (!resolved) {
    return {
      attempted: true,
      ok: false,
      detail: workspaceId
        ? `${tokenEnvVar} is not set and no persisted Kokuban token found for this workspace`
        : `${tokenEnvVar} is not set`,
    };
  }
  const token = resolved.token;
  try {
    const res = await fetch(`${apiBaseUrl}/v1/kokuban/c2c-events`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: rawBody,
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

/**
 * Best-effort report of one confirmed C2C state transition to Kokuban
 * (Personal Core's Activity Event Log) -- the single hook point every
 * Kokuban-enabled workspace's `session set` goes through, so no
 * per-workspace producer gets invented. Never throws: `session set`'s real
 * job (recording the ChatGPT chat pointer) must succeed independently of
 * whether Kokuban is reachable. The bearer token comes from `resolveKokubanToken()`
 * (kokuban-secret.ts) -- the env var named by `config.tokenEnvVar`, or (only
 * when `input.workspaceId` is passed) the persisted per-workspace secret --
 * and its value is never included in the returned detail, logged, or sent
 * anywhere but the Authorization header of this one request.
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
  const apiBaseUrl = (config.apiBaseUrl?.trim() || DEFAULT_API_BASE_URL).replace(/\/+$/, "");
  const actor = config.actor?.trim() || DEFAULT_ACTOR;
  const message = `[C2C]\nSTATE: ${normalizedState}\nTASK_ID: ${taskId}\nITERATION: ${iteration}`;
  const isBlocked = normalizedState === "BLOCKED";

  const body = buildKokubanRequestBody({
    projectKey: config.projectKey,
    actor,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    message,
    isBlocked,
    holderAfter: input.holderAfter,
    stopReason: input.stopReason,
    summary: input.summary?.trim() || undefined,
  });
  return postKokubanRequestBody(apiBaseUrl, tokenEnvVar, body, input.workspaceId);
}

// ---------------------------------------------------------------------
// Write-ahead outbox orchestration (connector reliability hardening,
// Kokuban ITERATION 1). reportKokubanTransition() above is the low-level
// "attempt exactly one send" primitive (unchanged, still directly used by
// callers and tests that don't need durability); everything below wraps it
// with the prepare -> commit -> send -> discard sequence that survives a
// crash between C2C's own state commit and Kokuban's delivery, made
// crash-safe and cross-process-safe per independent review (2026-09-03,
// two rounds).
// ---------------------------------------------------------------------

export interface PrepareKokubanTransitionInput {
  workspaceId: string;
  config: EffectiveKokubanConfig;
  state: string;
  taskId: string | undefined;
  iteration: number | undefined;
  holderAfter?: string;
  stopReason?: string;
  summary?: string;
}

/**
 * Step 1-2 of the write-ahead sequence: fully determine the canonical event
 * -- idempotency key, occurredAt, message, the EXACT request body string --
 * and durably persist it as "prepared", exactly once. MUST be called BEFORE
 * the caller's own writeSession() for the same transition, from inside the
 * callback passed to runUnderKokubanLock() (see kokuban-outbox.ts) -- never
 * standalone.
 *
 * Returns null (nothing persisted) when this transition doesn't apply at
 * all -- not a C2C wire state, or no taskId/iteration yet -- the exact same
 * gate reportKokubanTransition itself enforces.
 *
 * THROWS if the local write-ahead write itself fails, OR if this is a
 * same-idempotency-key retry whose original entry cannot be read back as
 * valid (disk full, permissions, ENOTDIR on the state directory, or a
 * corrupt/foreign existing payload) -- see kokuban-outbox.ts's
 * prepareOutboxEvent doc comment for why this is deliberately NOT
 * fail-soft: a caller that swallowed this and proceeded to writeSession()
 * anyway would be committing C2C state with no valid local durability
 * record at all. Callers must stop before writeSession() on this throw.
 * Kokuban's own REMOTE/network failures remain fully fail-soft -- this
 * exception is scoped to the LOCAL write-ahead write only.
 */
export function prepareKokubanTransition(input: PrepareKokubanTransitionInput): KokubanCanonicalEvent | null {
  const normalizedState = input.state.trim().toUpperCase();
  if (!isC2cWireState(normalizedState)) return null;
  if (!input.taskId || input.iteration === undefined || !Number.isInteger(input.iteration) || input.iteration < 0) {
    return null;
  }
  const isBlocked = normalizedState === "BLOCKED";
  const actor = input.config.actor?.trim() || DEFAULT_ACTOR;
  const occurredAt = new Date().toISOString();
  const message = `[C2C]\nSTATE: ${normalizedState}\nTASK_ID: ${input.taskId}\nITERATION: ${input.iteration}`;
  const holderAfter = isBlocked ? input.holderAfter?.trim() || undefined : undefined;
  const stopReason = isBlocked ? input.stopReason?.trim() || undefined : undefined;
  const summary = input.summary?.trim() || undefined;
  const apiBaseUrl = (input.config.apiBaseUrl?.trim() || DEFAULT_API_BASE_URL).replace(/\/+$/, "");

  const event: Omit<KokubanCanonicalEvent, "sequence"> = {
    idempotencyKey: computeIdempotencyKey(input.config.projectKey, input.taskId, input.iteration, normalizedState),
    workspaceId: input.workspaceId,
    projectKey: input.config.projectKey,
    state: normalizedState,
    taskId: input.taskId,
    iteration: input.iteration,
    actor,
    apiBaseUrl,
    tokenEnvVar: input.config.tokenEnvVar?.trim() || DEFAULT_TOKEN_ENV_VAR,
    occurredAt,
    message,
    holderAfter,
    stopReason,
    summary,
    requestBody: buildKokubanRequestBody({ projectKey: input.config.projectKey, actor, occurredAt, message, isBlocked, holderAfter, stopReason, summary }),
    preparedAt: occurredAt,
  };
  // prepareOutboxEvent() itself returns the canonical event for this key --
  // `event` on a fresh write, or whatever was actually persisted first on a
  // same-key retry (see its doc comment). May throw -- see doc comment
  // above.
  return prepareOutboxEvent(event);
}

/**
 * Sends the event's own immutable, pre-computed requestBody verbatim --
 * never reconstructed -- so a retry (however much later, however far
 * session state has moved on) is byte-for-byte identical to the first
 * attempt. `workspaceId` is the caller's own known-good owning workspace --
 * used for the discard, never `event.workspaceId` (structural workspace
 * confinement: the value read back off disk is validated at read time, but
 * filesystem operations should still never depend on trusting disk content
 * over the caller's own argument).
 *
 * The network call itself is intentionally made with NO lock held (never
 * block another process's local mutation on a slow/hung Kokuban request).
 * But the discard on confirmed success DOES touch the same outbox
 * filesystem state a concurrent process's own reconciliation reads --
 * independent review (fifth round) found a real race there: without
 * synchronization, one process's post-send discard could interleave with
 * another process's own runUnderKokubanLock() reconciliation pass over the
 * SAME entry (e.g. that process reads the entry, this one discards it
 * mid-read, that process's subsequent commitOutboxEvent() then fails
 * because the payload is already gone -- a spurious local-durability
 * failure for an event that had, in fact, already been delivered). Fixed
 * by briefly re-acquiring this workspace's Kokuban lock for the discard
 * step ONLY (never across the network call) -- re-verifying it's still the
 * SAME canonical entry (by `sequence`) before removing it. If the lock
 * can't be acquired (contention), the entry is deliberately left in place
 * rather than discarded unprotected -- Kokuban's own server-side
 * idempotency makes a duplicate-safe retry on the next drain harmless
 * (`duplicate: true`), which is the safe default over racing a concurrent
 * reconciliation pass.
 */
export async function sendAndDiscardKokubanEvent(workspaceId: string, event: KokubanCanonicalEvent): Promise<KokubanReportResult> {
  const result = await postKokubanRequestBody(event.apiBaseUrl, event.tokenEnvVar, event.requestBody, workspaceId);
  if (result.ok) {
    await runUnderKokubanLock(workspaceId, () => {
      const current = readOutboxEvent(workspaceId, event.idempotencyKey);
      if (current && current.event.sequence === event.sequence) {
        discardOutboxEvent(workspaceId, event.idempotencyKey);
      }
    }).catch(() => {
      // Lock unavailable (or any other local hiccup) during the ACK step --
      // leave the entry in place for a later, duplicate-safe retry rather
      // than risk an unprotected discard. See doc comment above.
    });
  }
  return result;
}

/**
 * LOCAL-ONLY reconciliation: promotes confirmed "prepared" entries to
 * "committed" and discards disconfirmed ones, entirely through local
 * filesystem reads/writes -- no network call. Callers MUST call this only
 * from inside the callback passed to runUnderKokubanLock() (see
 * kokuban-outbox.ts) and must perform any resulting sends AFTER that lock
 * is released (never hold it across a network call).
 *
 *  - "prepared" entry: the corresponding writeSession() may or may not have
 *    completed before whatever interrupted that run. Reconciled against the
 *    CURRENT saved session: an exact match on taskId/iteration/state means
 *    the transition is confirmed to have committed (promote to
 *    "committed"); anything else means it never committed and the event is
 *    discarded, never sent -- fail-closed on the commit question itself,
 *    not just on the network question. (A previous revision skipped
 *    entries younger than a fixed grace period as defense-in-depth against
 *    a concurrent writer's own still-in-flight entry; that heuristic is
 *    gone now that runUnderKokubanLock() makes reconcile-then-mutate one
 *    genuinely atomic local critical section -- there is no longer a
 *    window for another process to observe a "prepared" entry that isn't
 *    actually resolvable yet.)
 *  - "committed" entry: already known-good from a previous run -- returned
 *    as-is for the caller to (re)send, no reconciliation needed or wanted
 *    (session state may have long since moved past this transition, which
 *    does not make the transition itself any less real).
 *
 * THROWS if a confirmed "prepared" entry's promotion to "committed" itself
 * fails (a local durability failure, same category as a prepare failure --
 * see commitOutboxEvent's doc comment): the caller's whole mutation must
 * stop rather than move session state past an event this reconciliation
 * pass could not durably resolve. Entries already resolved earlier in the
 * same pass stay resolved (each promote/discard is independently durable),
 * so a later retry only has to deal with what's left.
 */
export function reconcileKokubanOutboxLocally(workspaceId: string): { toSend: KokubanCanonicalEvent[]; discarded: number } {
  const toSend: KokubanCanonicalEvent[] = [];
  let discarded = 0;
  const entries = listOutboxEntries(workspaceId);
  if (entries.length === 0) return { toSend, discarded };

  const saved = readSession(workspaceId);
  for (const entry of entries) {
    const { event } = entry;
    if (entry.status === "prepared") {
      const confirmed =
        saved?.taskId === event.taskId &&
        saved?.iteration === event.iteration &&
        (saved?.lastState ?? "").trim().toUpperCase() === event.state;
      if (!confirmed) {
        discardOutboxEvent(workspaceId, event.idempotencyKey);
        discarded++;
        continue;
      }
      if (!commitOutboxEvent(workspaceId, event.idempotencyKey)) {
        throw new Error(
          `kokuban outbox: confirmed transition ${event.idempotencyKey} could not be marked committed locally`
        );
      }
    }
    toSend.push(event);
  }
  return { toSend, discarded };
}

/**
 * Delivers `events` strictly in the given order (see listOutboxEntries's
 * `sequence`-based ordering), stopping at the first unconfirmed/failed
 * send instead of skipping ahead to a later one (independent review,
 * fourth round: an earlier drain that kept attempting newer events after
 * an older one's delivery failed could let a newer event reach Kokuban
 * before an older one whose delivery was still unconfirmed, inverting
 * event order at the remote log). Never throws -- sendAndDiscardKokubanEvent
 * itself is already fully fail-soft on network errors. Whatever wasn't
 * sent (the failed one and everything after it) is simply left in the
 * outbox, in its original order, for the next drain to retry from there.
 */
export async function sendKokubanEventsInOrder(
  workspaceId: string,
  events: KokubanCanonicalEvent[]
): Promise<{ sentCount: number; lastAttempted: KokubanReportResult | null }> {
  let sentCount = 0;
  let lastAttempted: KokubanReportResult | null = null;
  for (const event of events) {
    const result = await sendAndDiscardKokubanEvent(workspaceId, event);
    lastAttempted = result;
    if (!result.ok) break;
    sentCount++;
  }
  return { sentCount, lastAttempted };
}

/**
 * Standalone drain: reconciles this workspace's leftover outbox entries
 * (inside runUnderKokubanLock -- fails closed on lock contention, same as
 * every other Kokuban-enabled mutation) and sends every confirmed event
 * over the network afterward, unlocked, strictly in outbox order (see
 * sendKokubanEventsInOrder). For use outside a `session set`/`session
 * clear` invocation (e.g. an explicit "flush the outbox" call) -- those
 * commands run reconciliation as part of their own single critical section
 * via runUnderKokubanLock() directly, not through this function. Never
 * touches any workspace's outbox but its own (listOutboxEntries validates
 * this).
 */
export async function drainKokubanOutbox(workspaceId: string): Promise<{ sent: number; discarded: number }> {
  const { toSend, discarded } = await runUnderKokubanLock(workspaceId, () => reconcileKokubanOutboxLocally(workspaceId));
  const { sentCount } = await sendKokubanEventsInOrder(workspaceId, toSend);
  return { sent: sentCount, discarded };
}
