import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";

/**
 * Persisted Kokuban write-token storage, so the user doesn't have to set
 * KOKUBAN_WRITE_TOKEN as an environment variable in every new terminal/after
 * every reboot for Kokuban to work. One file per workspace, under the same
 * OS-convention state directory (`getStateDir()`) every other piece of C2C
 * local state already lives in -- never `.c2c.json`, never a Git-tracked
 * file, never printed to stdout/logs/doctor JSON/execution records.
 *
 * There is no existing "store an actual replayable secret" mechanism in
 * this codebase to reuse: `src/auth/store.ts` only ever persists a SHA-256
 * HASH of its own tokens (verify-by-rehash, never reconstitutes the
 * plaintext) -- that pattern doesn't apply here, since this token has to be
 * replayed verbatim in an `Authorization: Bearer` header to an external
 * service, not merely verified.
 *
 * Platform scope (deliberately minimal, per project decision): real OS-level
 * protection via Windows DPAPI (`ConvertTo-SecureString`/
 * `ConvertFrom-SecureString`, CurrentUser scope -- decryptable only by the
 * same Windows user account on the same machine) is implemented for win32,
 * since that's the platform this feature needs to work reliably on right
 * now. Every other platform falls back to a plain `0o600`-protected file
 * (the same protection level every other local secret-adjacent file in this
 * codebase already relies on) -- weaker, but explicit and logged as a
 * one-time warning by the CLI command that saves it, never silent. A real
 * macOS Keychain / Linux libsecret backend is a natural future addition;
 * the `encoding` field on the persisted record is exactly the extension
 * point for it, deliberately kept open rather than hard-coded to two cases
 * inline everywhere.
 */

export type KokubanSecretEncoding = "dpapi" | "plaintext";

interface PersistedKokubanSecret {
  encoding: KokubanSecretEncoding;
  /** Opaque: DPAPI ciphertext (base16, CurrentUser-scoped) for "dpapi", the
   *  raw token itself for "plaintext". Never logged, never returned from
   *  any function in this module except readKokubanSecret's own return
   *  value. */
  value: string;
  savedAt: string;
}

function secretFile(workspaceId: string): string {
  return path.join(getStateDir(), "kokuban-secrets", `${workspaceId}.json`);
}

/** Never argv (would show up in process-listing tools), never logged --
 *  passed to the PowerShell child solely via its own environment. */
const SECRET_ENV_VAR = "C2C_KOKUBAN_SECRET_INPUT";
const POWERSHELL_TIMEOUT_MS = 10_000;

type PowerShellSecretResult = { ok: true; value: string } | { ok: false; detail: string };

/** Runs a fixed PowerShell script that reads `SECRET_ENV_VAR` and writes
 *  exactly one line of transformed output to stdout -- shared by encrypt and
 *  decrypt below. Array args, no `shell:true`, matching every other
 *  subprocess call in this codebase (see src/tunnel/*.ts). `detail` on
 *  failure is built ONLY from the exit code / spawn error message / a
 *  short, fixed-length stderr snippet -- NEVER from stdout, which is
 *  exactly where the secret value flows on success, so a failure detail
 *  can never accidentally echo it. */
function runPowerShellSecretScript(script: string, envValue: string): PowerShellSecretResult {
  let result;
  try {
    result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      timeout: POWERSHELL_TIMEOUT_MS,
      env: { ...process.env, [SECRET_ENV_VAR]: envValue },
    });
  } catch (error) {
    return { ok: false, detail: `spawn failed: ${error instanceof Error ? error.message : "unknown error"}` };
  }
  if (result.error) return { ok: false, detail: `spawn failed: ${result.error.message}` };
  if (result.status !== 0) {
    const stderrSnippet = (result.stderr ?? "").slice(0, 200);
    return { ok: false, detail: `powershell exited ${result.status}${stderrSnippet ? `: ${stderrSnippet}` : ""}` };
  }
  const value = (result.stdout ?? "").replace(/\r?\n$/, "");
  if (!value) return { ok: false, detail: "powershell produced no output" };
  return { ok: true, value };
}

function dpapiEncrypt(plaintext: string): PowerShellSecretResult | { ok: false; unsupported: true } {
  if (process.platform !== "win32") return { ok: false, unsupported: true };
  return runPowerShellSecretScript(
    `$s = ConvertTo-SecureString -String $env:${SECRET_ENV_VAR} -AsPlainText -Force; ConvertFrom-SecureString $s`,
    plaintext
  );
}

function dpapiDecrypt(ciphertext: string): string | null {
  if (process.platform !== "win32") return null; // can't decrypt a DPAPI blob off Windows
  const result = runPowerShellSecretScript(
    `$s = ConvertTo-SecureString -String $env:${SECRET_ENV_VAR}; ` +
      `$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); ` +
      `[Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)`,
    ciphertext
  );
  return result.ok ? result.value : null; // fail closed: any decrypt failure (wrong user, corrupted blob, powershell unavailable) reads as "no secret", never a partial/garbled value
}

export interface SaveKokubanSecretResult {
  ok: boolean;
  encoding?: KokubanSecretEncoding;
  error?: string;
}

/**
 * Persists `token` for `workspaceId`, encrypted with DPAPI on Windows.
 * Fail-closed (independent review requirement): if this is Windows and DPAPI
 * genuinely fails (PowerShell missing, exit code, etc.), this returns
 * `ok:false` rather than silently downgrading to plaintext on the one
 * platform this feature is meant to protect properly -- the caller must not
 * report success. On a non-Windows platform, DPAPI is simply "unsupported"
 * (not a failure), and this falls back to the same `0o600`-file protection
 * every other local secret-adjacent file in this codebase already uses;
 * callers should warn the user this is weaker, once.
 */
export function saveKokubanSecret(workspaceId: string, token: string): SaveKokubanSecretResult {
  const trimmed = token.trim();
  if (!trimmed) return { ok: false, error: "token is empty" };

  let record: PersistedKokubanSecret;
  const encrypted = dpapiEncrypt(trimmed);
  if ("unsupported" in encrypted) {
    record = { encoding: "plaintext", value: trimmed, savedAt: new Date().toISOString() };
  } else if (encrypted.ok) {
    record = { encoding: "dpapi", value: encrypted.value, savedAt: new Date().toISOString() };
  } else {
    return { ok: false, error: `DPAPI encryption failed (${encrypted.detail})` };
  }

  try {
    writeSecureJson(secretFile(workspaceId), record);
    return { ok: true, encoding: record.encoding };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "unknown error" };
  }
}

/**
 * Validates the on-disk shape before anything in this module trusts it as a
 * `PersistedKokubanSecret`. Independent review (2026-09-03) found that
 * `readJsonIfExists<T>()`'s generic type parameter is a compile-time
 * assertion only -- it does NOT check anything at runtime, so a
 * valid-JSON-but-wrong-shape file (e.g. `{"encoding":"plaintext",
 * "value":123}`) was silently trusted as `PersistedKokubanSecret` and could
 * throw downstream (`record.value?.trim()` on a number has no `.trim`
 * method) instead of failing closed to null like every other corrupted-file
 * case. No coercion, no guessing a "probably meant" value -- anything that
 * doesn't match exactly is treated as absent.
 */
function isValidPersistedSecret(value: unknown): value is PersistedKokubanSecret {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.encoding !== "dpapi" && record.encoding !== "plaintext") return false;
  return typeof record.value === "string" && record.value.trim().length > 0;
}

/**
 * Reads back the persisted token for `workspaceId`, or null if there isn't
 * one, it can't be parsed, its shape is invalid (see isValidPersistedSecret
 * above), or (for a "dpapi" record) it can't be decrypted -- every one of
 * those cases is treated identically: fail closed to "no persisted secret
 * available", never a partial/garbled value, and never a thrown exception a
 * caller might forget to catch. Confinement is structural, not
 * content-based: this file's path is already namespaced by `workspaceId`
 * (`<stateDir>/kokuban-secrets/<workspaceId>.json`), so there's no
 * embedded-workspaceId field to validate the way the Kokuban outbox has to
 * -- a call for workspace A can only ever open A's own file.
 */
export function readKokubanSecret(workspaceId: string): string | null {
  const raw = readJsonIfExists<unknown>(secretFile(workspaceId));
  if (!isValidPersistedSecret(raw)) return null;
  if (raw.encoding === "plaintext") return raw.value.trim();
  return dpapiDecrypt(raw.value); // encoding === "dpapi" (the only other case isValidPersistedSecret allows)
}

export interface DeleteKokubanSecretResult {
  ok: boolean;
  existed: boolean;
  error?: string;
}

/** Removes the persisted token for `workspaceId`. After this returns
 *  `ok:true`, readKokubanSecret() for the same workspace returns null --
 *  there is no separate cache or index anywhere else that could resurrect
 *  the old value (nothing in this module keeps any in-memory or on-disk
 *  copy beyond this one file). A genuine deletion failure (not "the file
 *  never existed") is reported as `ok:false` rather than silently treated
 *  as a successful revoke. */
export function deleteKokubanSecret(workspaceId: string): DeleteKokubanSecretResult {
  const file = secretFile(workspaceId);
  if (!fs.existsSync(file)) return { ok: true, existed: false };
  try {
    fs.unlinkSync(file);
    return { ok: true, existed: true };
  } catch (error) {
    return { ok: false, existed: true, error: error instanceof Error ? error.message : "unknown error" };
  }
}

export type KokubanTokenSource = "env" | "persisted" | "none";

/**
 * The single place that decides which token value (if any) a Kokuban send
 * actually uses. Deterministic priority, exactly as specified:
 *   1. explicit env var (`tokenEnvVar`, default KOKUBAN_WRITE_TOKEN) --
 *      unchanged from before this feature existed, so nothing already
 *      relying on the env var changes behavior.
 *   2. the persisted per-workspace secret (only consulted when a
 *      `workspaceId` is available -- direct/legacy callers that don't pass
 *      one keep the exact old "env var or nothing" behavior).
 *   3. unavailable.
 * Never falls back to another workspace's secret or a different env var --
 * the only inputs are this exact `tokenEnvVar` name and this exact
 * `workspaceId`.
 */
export function resolveKokubanToken(workspaceId: string | undefined, tokenEnvVar: string): { token: string; source: KokubanTokenSource } | null {
  const envValue = process.env[tokenEnvVar];
  if (envValue && envValue.trim()) return { token: envValue, source: "env" };
  if (!workspaceId) return null;
  const persisted = readKokubanSecret(workspaceId);
  return persisted ? { token: persisted, source: "persisted" } : null;
}
