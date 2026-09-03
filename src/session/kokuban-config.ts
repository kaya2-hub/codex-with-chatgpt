import path from "node:path";
import type { KokubanConfig } from "../workspace/manager.js";
import type { Workspace } from "../workspace/manager.js";

/**
 * The Kokuban config a call actually operates with, after resolving the
 * raw (possibly sparse, possibly absent) `.c2c.json` block against the
 * default-ON / auto-derived-projectKey rules below. Unlike the raw
 * KokubanConfig, `projectKey` here is always a concrete string -- every
 * consumer of Kokuban (kokuban.ts, kokuban-outbox.ts) takes THIS type, not
 * the raw one, so there is exactly one place (resolveEffectiveKokubanConfig
 * below) where "is Kokuban on for this workspace, and what's its
 * projectKey" gets decided.
 */
export interface EffectiveKokubanConfig {
  projectKey: string;
  apiBaseUrl?: string;
  tokenEnvVar?: string;
  actor?: string;
}

/**
 * Turns a workspace's own name (already `.c2c.json`'s `name` field, or the
 * directory basename -- see Workspace's constructor) into Kokuban's
 * project_key vocabulary: lowercase, `[a-z0-9-]` only, single hyphens as
 * separators, no leading/trailing hyphen. Purely mechanical -- no
 * transliteration, no natural-language inference, no external lookup --
 * so a name that sanitizes to nothing (all-symbol, all non-ASCII, empty)
 * is simply reported as such (empty string); callers fall back to a
 * different deterministic identity signal rather than trying to guess a
 * "nicer" key (see deriveProjectKey below).
 */
export function sanitizeProjectKey(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Mechanically derives a projectKey from workspace identity alone -- no
 * natural-language inference, no external inquiry (network, git remote,
 * etc.), and deterministic: the SAME workspace root always produces the
 * SAME value, run after run. Prefers the sanitized basename of the
 * workspace's own ROOT directory -- NOT `workspace.name` (independent
 * review, second pass on ITERATION 4: `workspace.name` defaults to that
 * same basename, but can be overridden by `.c2c.json`'s own `name` field,
 * which is a user-editable DISPLAY label with no stability guarantee at
 * all; deriving from it would mean editing `name` alone -- with the
 * workspace root untouched -- silently splits that workspace's Kokuban
 * history across two different projectKeys). `workspace.root` itself is
 * never influenced by `.c2c.json` content, so its basename moves in lockstep
 * with `workspace.id` (already a hash of this same root) -- both change
 * only if the directory itself is renamed/moved, never from a config edit.
 * If the basename sanitizes to nothing (e.g. an all-non-ASCII directory
 * name), falls back to `workspace.id` itself -- still fully deterministic,
 * never random, never inferred.
 *
 * Independent review (2026-09-03, Kokuban ITERATION 4): two workspaces
 * whose root basenames sanitize to the SAME projectKey are a real possible
 * collision this function does NOT try to resolve or hide -- it never
 * synthesizes an alternate name (e.g. appending a random/hash suffix) to
 * make a collision disappear, since that would make the projectKey
 * unpredictable and hide the underlying collision from whoever set the two
 * workspaces up. If that collision matters, the fix is an explicit
 * `projectKey` override in `.c2c.json` for one of them -- the same
 * "surface it, don't auto-fix it" policy already used for duplicate Git
 * checkouts (see src/workspace/identity.ts).
 */
export function deriveProjectKey(workspace: Workspace): string {
  return sanitizeProjectKey(path.basename(workspace.root)) || workspace.id;
}

/**
 * THE single place that resolves a workspace's raw, possibly-sparse (or
 * entirely absent) `.c2c.json` `kokuban` block into a concrete decision:
 * participate with THIS projectKey, or not participate at all (`null`).
 * Every caller -- `session set`, `session clear`, anything else Kokuban-
 * related -- MUST go through this function rather than re-deriving the
 * same enabled/projectKey logic itself.
 *
 * Rules (Kokuban ITERATION 4, independent review 2026-09-03):
 *  - No `kokuban` block at all (including no `.c2c.json` at all): default
 *    ON, projectKey mechanically derived (see deriveProjectKey).
 *  - `kokuban.enabled === false`: explicit opt-out -- returns null. This is
 *    the ONLY way to opt out; a missing block is never treated as opting
 *    out (that would contradict default-ON).
 *  - `kokuban.projectKey` explicitly set (non-blank): ALWAYS used, whether
 *    or not `enabled` is also present -- an explicit override is never
 *    silently replaced by the derived value. This is also what makes
 *    existing `{ kokuban: { projectKey: "..." } }` workspaces (predating
 *    ITERATION 4) behave identically to before: the same explicit
 *    projectKey they already had, still used, unconditionally.
 *  - `apiBaseUrl`/`tokenEnvVar`/`actor` pass through unchanged (already
 *    optional, already defaulted downstream in kokuban.ts).
 */
export function resolveEffectiveKokubanConfig(workspace: Workspace): EffectiveKokubanConfig | null {
  const raw: KokubanConfig | undefined = workspace.projectConfig.kokuban;
  if (raw?.enabled === false) return null;
  const projectKey = raw?.projectKey?.trim() || deriveProjectKey(workspace);
  return {
    projectKey,
    apiBaseUrl: raw?.apiBaseUrl,
    tokenEnvVar: raw?.tokenEnvVar,
    actor: raw?.actor,
  };
}
