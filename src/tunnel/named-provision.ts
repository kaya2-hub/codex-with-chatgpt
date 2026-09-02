import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findBinary } from "./detect.js";
import { isHostnameDirectlyUnderZone, suggestedNamedHostname } from "./hostname.js";
import { normalizeNamedTunnelHostname } from "./cloudflared-named.js";
import {
  NAMED_FALLBACK_MESSAGE,
  readTunnelState,
  writeTunnelState,
  type TunnelState,
} from "./state.js";

const TUNNEL_ID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const COMMAND_TIMEOUT_MS = 45_000;

export interface ListedTunnel {
  id: string;
  name: string;
  /** True when `cloudflared tunnel list` reports at least one active edge
   *  connection for this tunnel right now — from any machine/process, not
   *  just this one. Undefined when the table-output fallback parser was
   *  used (it doesn't carry this column) — treat that as "unknown", not
   *  "definitely idle". */
  hasActiveConnections?: boolean;
  /** True when this result came from `ensureRunnable`'s self-heal path
   *  (old tunnel object deleted, a new one created under the same name) —
   *  the UUID changed, so any existing DNS route for this workspace's
   *  hostname now points at a dead tunnel and must be overwritten, not
   *  just treated as "already exists = fine". */
  recreated?: boolean;
}

export interface CloudflaredAccount {
  hasCert(): boolean;
  login(): Promise<void>;
  listTunnels(): Promise<ListedTunnel[]>;
  /** `knownTunnelId`: the tunnel id this workspace's own local state last
   *  recorded creating (from `TunnelState.tunnelId`), or null if none.
   *  Required for the self-heal path (see `decideTunnelReuse`) to tell a
   *  tunnel this machine genuinely made before from one that merely
   *  happens to share the same `c2c-<workspaceId>` name. */
  createTunnel(name: string, knownTunnelId: string | null): Promise<ListedTunnel>;
  deleteTunnel(nameOrId: string): Promise<void>;
  routeDns(tunnelName: string, hostname: string, opts?: { overwrite?: boolean }): Promise<void>;
}

export function cloudflaredCertPath(): string {
  const override = process.env.TUNNEL_ORIGIN_CERT?.trim();
  if (override) return override;
  return path.join(os.homedir(), ".cloudflared", "cert.pem");
}

export function hasCloudflaredCert(): boolean {
  try {
    return fs.statSync(cloudflaredCertPath()).isFile();
  } catch {
    return false;
  }
}

/** `cloudflared tunnel run <name>` looks up credentials at this default
 *  path — a tunnel object can exist on the Cloudflare account (found by
 *  `listTunnels`) without a matching file here, e.g. left over from a
 *  differently-configured tool version that stored credentials elsewhere.
 *  `createTunnel`'s reuse path checks this before trusting a match. */
export function defaultTunnelCredentialsPath(tunnelId: string): string {
  return path.join(os.homedir(), ".cloudflared", `${tunnelId}.json`);
}

export function hasLocalTunnelCredentials(tunnelId: string): boolean {
  try {
    return fs.statSync(defaultTunnelCredentialsPath(tunnelId)).isFile();
  } catch {
    return false;
  }
}

export function parseTunnelList(output: string): ListedTunnel[] {
  const trimmed = output.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const rows = Array.isArray(parsed) ? parsed : (parsed as { tunnels?: unknown }).tunnels;
      if (!Array.isArray(rows)) return [];
      return rows.flatMap((row) => {
        if (!row || typeof row !== "object") return [];
        const record = row as { id?: unknown; name?: unknown; connections?: unknown };
        if (typeof record.id !== "string" || typeof record.name !== "string") return [];
        return [
          {
            id: record.id,
            name: record.name,
            hasActiveConnections: Array.isArray(record.connections) && record.connections.length > 0,
          },
        ];
      });
    } catch {
      // fall through to the table parser
    }
  }
  const found: ListedTunnel[] = [];
  for (const line of output.split(/\r?\n/)) {
    const id = line.match(TUNNEL_ID_RE)?.[0];
    if (!id) continue;
    const after = line.slice(line.indexOf(id) + id.length).trim();
    const name = after.split(/\s+/)[0];
    if (name && name !== "NAME") found.push({ id, name });
  }
  return found;
}

export function parseCreatedTunnel(output: string, name: string): ListedTunnel | null {
  const id = output.match(TUNNEL_ID_RE)?.[0];
  return id ? { id, name } : null;
}

/** Cloudflared's `tunnel route dns` requires `--overwrite-dns` BEFORE the
 *  positional TUNNEL/HOSTNAME arguments — unlike e.g. `tunnel delete
 *  --force NAME`, which accepts the flag after. Verified empirically
 *  against a real `cloudflared version 2026.8.2` install on 2026-09-02:
 *  `tunnel route dns NAME HOST --overwrite-dns` is rejected ("This command
 *  expects the format \"cloudflared tunnel route dns <tunnel name/id>
 *  <hostname>\"", exit 127), while `tunnel route dns --overwrite-dns NAME
 *  HOST` succeeds. See tests/tunnel.test.ts for the regression test. */
export function buildRouteDnsArgs(tunnelName: string, hostname: string, overwrite: boolean): string[] {
  return overwrite
    ? ["tunnel", "route", "dns", "--overwrite-dns", tunnelName, hostname]
    : ["tunnel", "route", "dns", tunnelName, hostname];
}

export type TunnelReuseDecision =
  | { action: "reuse" }
  | { action: "recreate" }
  | { action: "refuse"; reason: string };

/** Pure decision logic for `ensureRunnable`'s self-heal: a tunnel found on
 *  the account may have no matching credentials file at `cloudflared`'s
 *  default lookup path (e.g. left behind by a differently configured
 *  previous run) — `tunnel run` would fail on it forever.
 *
 *  Never delete a tunnel with active edge connections: those can only
 *  exist if some process — possibly on a different machine, using
 *  credentials this machine doesn't have — is already running it right
 *  now. `hasActiveConnections === undefined` means "unknown" (the
 *  table-output fallback parser doesn't carry this column) and must be
 *  treated the same as `true` — only a confirmed `false` clears the way
 *  to recreate.
 *
 *  `depth` bounds retries when a concurrent process wins the create race
 *  right after we delete. At `depth > 0` we are looking at a tunnel a
 *  *different* process just created, not one we independently discovered
 *  stale: it having no local credentials on this machine is expected
 *  (it was freshly made elsewhere) and must NOT trigger another
 *  delete-and-recreate — that would steal the other process's brand-new
 *  tunnel right back before it even connects. Yield instead.
 *
 *  `knownTunnelId` is this workspace's own local ownership record (from
 *  `TunnelState.tunnelId`, if this machine's C2C ever created a tunnel for
 *  this workspace before). A confirmed-inactive, credential-less tunnel is
 *  only safe to delete-and-recreate when it matches that record — a
 *  same-named tunnel we have no record of creating could belong to a
 *  different machine's checkout of this same workspace path
 *  (`c2c-<workspaceId>` collides across machines by design, since
 *  workspaceId is a path hash, not a per-machine identifier) that simply
 *  isn't running right now. "Zero active connections" is not proof of
 *  ownership — only proof nothing is *currently* connected. */
export function decideTunnelReuse(
  tunnel: ListedTunnel,
  hasLocalCredentials: boolean,
  depth: number,
  knownTunnelId: string | null
): TunnelReuseDecision {
  if (hasLocalCredentials) return { action: "reuse" };
  if (depth > 0) {
    return {
      action: "refuse",
      reason:
        `Tunnel ${tunnel.name} was just created by a different process during a concurrent ` +
        `provisioning attempt. Yielding to it rather than deleting it back.`,
    };
  }
  if (tunnel.hasActiveConnections !== false) {
    const reason =
      tunnel.hasActiveConnections === true
        ? "is currently showing active connections on the Cloudflare account"
        : "connection status could not be determined";
    return {
      action: "refuse",
      reason:
        `Tunnel ${tunnel.name} has no local credentials on this machine, but ${reason} — ` +
        `it may already be running elsewhere (another process, possibly on a different ` +
        `machine). Refusing to delete it; if it's actually stale, remove it manually with ` +
        `\`cloudflared tunnel delete --force ${tunnel.name}\` first.`,
    };
  }
  if (knownTunnelId !== tunnel.id) {
    return {
      action: "refuse",
      reason:
        `Tunnel ${tunnel.name} exists on the Cloudflare account (id ${tunnel.id}), but this machine has ` +
        `no record of having created it${knownTunnelId ? ` (it last created id ${knownTunnelId} instead)` : ""} ` +
        `and no local credentials for it either — it may belong to a different machine's setup for this ` +
        `same workspace. Refusing to delete it automatically; if it's genuinely stale, remove it manually ` +
        `with \`cloudflared tunnel delete --force ${tunnel.name}\` first.`,
    };
  }
  return { action: "recreate" };
}

export class ProcessCloudflaredAccount implements CloudflaredAccount {
  constructor(private readonly binaryOverride?: string) {}

  private binary(): string {
    const bin = this.binaryOverride ?? findBinary("cloudflared");
    if (!bin) {
      throw new Error(
        "NEED_CLOUDFLARED: cloudflared is not installed. Install it first (macOS: brew install cloudflared)."
      );
    }
    return bin;
  }

  hasCert(): boolean {
    return hasCloudflaredCert();
  }

  async login(): Promise<void> {
    if (this.hasCert()) return;
    const bin = this.binary();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(bin, ["tunnel", "login"], { stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      const collect = (chunk: Buffer): void => {
        output += chunk.toString("utf8");
      };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("Cloudflare login timed out"));
      }, LOGIN_TIMEOUT_MS);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (this.hasCert()) {
          resolve();
          return;
        }
        reject(
          new Error(
            `Cloudflare login did not finish${code !== 0 ? ` (exit ${code})` : ""}${
              output.trim() ? `: ${output.trim().slice(0, 400)}` : ""
            }`
          )
        );
      });
    });
  }

  async listTunnels(): Promise<ListedTunnel[]> {
    const json = this.run(["tunnel", "list", "--output", "json"]);
    if (json.ok) {
      const parsed = parseTunnelList(json.stdout || json.stderr);
      if (parsed.length > 0 || (json.stdout || json.stderr).trim().startsWith("[")) return parsed;
    }
    const table = this.run(["tunnel", "list"]);
    if (!table.ok) throw new Error(table.stderr || table.stdout || "Unable to list Cloudflare tunnels");
    return parseTunnelList(`${table.stdout}\n${table.stderr}`);
  }

  async createTunnel(name: string, knownTunnelId: string | null): Promise<ListedTunnel> {
    return this.createTunnelAttempt(name, 0, knownTunnelId);
  }

  private async createTunnelAttempt(name: string, depth: number, knownTunnelId: string | null): Promise<ListedTunnel> {
    const existing = (await this.listTunnels()).find((tunnel) => tunnel.name === name);
    if (existing) return this.ensureRunnable(existing, depth, knownTunnelId);
    const result = this.run(["tunnel", "create", name]);
    const created = parseCreatedTunnel(`${result.stdout}\n${result.stderr}`, name);
    if (created) return created;
    if (/already exists/i.test(`${result.stdout}\n${result.stderr}`)) {
      const again = (await this.listTunnels()).find((tunnel) => tunnel.name === name);
      if (again) return this.ensureRunnable(again, depth, knownTunnelId);
    }
    throw new Error(result.stderr || result.stdout || `Unable to create tunnel ${name}`);
  }

  private async ensureRunnable(tunnel: ListedTunnel, depth: number, knownTunnelId: string | null): Promise<ListedTunnel> {
    const decision = decideTunnelReuse(tunnel, hasLocalTunnelCredentials(tunnel.id), depth, knownTunnelId);
    if (decision.action === "reuse") return tunnel;
    if (decision.action === "refuse") throw new Error(decision.reason);
    await this.deleteTunnel(tunnel.id);
    const result = this.run(["tunnel", "create", tunnel.name]);
    const created = parseCreatedTunnel(`${result.stdout}\n${result.stderr}`, tunnel.name);
    if (created) return { ...created, recreated: true };
    if (depth < 1 && /already exists/i.test(`${result.stdout}\n${result.stderr}`)) {
      // Another process recreated the same-named tunnel between our delete
      // and our create — re-resolve it and validate that one instead of
      // failing; it may already be runnable (that other process's own
      // `create` also writes credentials to the default path on ITS
      // machine, but on THIS machine we still need to check).
      return this.createTunnelAttempt(tunnel.name, depth + 1, knownTunnelId);
    }
    throw new Error(
      result.stderr ||
        result.stdout ||
        `Tunnel ${tunnel.name} existed without local credentials, and recreating it failed`
    );
  }

  async deleteTunnel(nameOrId: string): Promise<void> {
    const result = this.run(["tunnel", "delete", "--force", nameOrId]);
    if (!result.ok && !/not found|does not exist/i.test(`${result.stdout}\n${result.stderr}`)) {
      throw new Error(result.stderr || result.stdout || `Unable to delete tunnel ${nameOrId}`);
    }
  }

  async routeDns(tunnelName: string, hostname: string, opts?: { overwrite?: boolean }): Promise<void> {
    const result = this.run(buildRouteDnsArgs(tunnelName, hostname, opts?.overwrite === true));
    // Only cloudflared's own exit code decides success — it already does
    // its own idempotent target check (exit 0 + "already configured to
    // route to your tunnel" when the existing record already points at
    // this exact tunnel; a non-zero exit means a real, unverified
    // conflict). Never pattern-match "already exists"-style stderr text as
    // benign: that would accept an existing record pointing at something
    // else entirely as if it were success.
    if (result.ok) return;
    throw new Error(result.stderr || result.stdout || `Unable to route ${hostname}`);
  }

  private run(args: string[]): { ok: boolean; stdout: string; stderr: string } {
    const result = spawnSync(this.binary(), args, {
      encoding: "utf8",
      timeout: COMMAND_TIMEOUT_MS,
    });
    return {
      ok: result.status === 0,
      stdout: (result.stdout ?? "").trim(),
      stderr: (result.stderr ?? "").trim(),
    };
  }
}

export interface ProvisionNamedResult {
  ok: boolean;
  state: TunnelState;
  fallback: boolean;
  userMessage?: string;
  error?: string;
}

export async function provisionNamedTunnel(opts: {
  workspaceId: string;
  workspaceName: string;
  zone: string;
  hostname?: string;
  account?: CloudflaredAccount;
}): Promise<ProvisionNamedResult> {
  const account = opts.account ?? new ProcessCloudflaredAccount();
  let hostname: string;
  try {
    hostname = opts.hostname
      ? normalizeNamedTunnelHostname(opts.hostname)
      : suggestedNamedHostname(opts.zone, opts.workspaceName, opts.workspaceId);
  } catch (error) {
    return fallbackState(opts.workspaceId, "invalid_hostname", (error as Error).message);
  }

  // suggestedNamedHostname() always builds exactly one label under the
  // zone, so this only ever rejects an explicitly-given --hostname — the
  // one path that let an agent (or a user) hand-propose something like
  // imonikai.c2c.example.com under zone example.com, which is exactly the
  // shape confirmed to fail TLS silently (see isHostnameDirectlyUnderZone).
  if (opts.hostname && !isHostnameDirectlyUnderZone(hostname, opts.zone)) {
    return fallbackState(
      opts.workspaceId,
      "hostname_not_directly_under_zone",
      `Hostname ${hostname} is not exactly one label directly under zone ${opts.zone} — refusing. ` +
        `Cloudflare's default certificate for the zone would very likely not cover it, causing a silent ` +
        `TLS failure after DNS routing succeeds. Pass a hostname of the form <label>.${opts.zone}.`
    );
  }

  const tunnelName = `c2c-${opts.workspaceId}`;
  const knownTunnelId = readTunnelState(opts.workspaceId).tunnelId ?? null;
  try {
    if (!account.hasCert()) await account.login();
    const tunnel = await account.createTunnel(tunnelName, knownTunnelId);
    await account.routeDns(tunnel.name, hostname, { overwrite: tunnel.recreated === true });
    const state = writeTunnelState({
      workspaceId: opts.workspaceId,
      preference: "named",
      askedAt: new Date().toISOString(),
      provider: "cloudflare-named",
      tunnelName: tunnel.name,
      tunnelId: tunnel.id,
      hostname,
      zone: normalizeNamedTunnelHostname(opts.zone),
      configuredAt: new Date().toISOString(),
    });
    return { ok: true, state, fallback: false };
  } catch (error) {
    return fallbackState(opts.workspaceId, "provision_failed", (error as Error).message);
  }
}

export function chooseQuickTunnel(workspaceId: string, fallbackReason?: string): TunnelState {
  return writeTunnelState({
    workspaceId,
    preference: "quick",
    askedAt: new Date().toISOString(),
    provider: "cloudflare-quick",
    fallbackReason,
  });
}

function fallbackState(workspaceId: string, reason: string, error: string): ProvisionNamedResult {
  const state = chooseQuickTunnel(workspaceId, reason);
  return {
    ok: true,
    state,
    fallback: true,
    userMessage: NAMED_FALLBACK_MESSAGE,
    error,
  };
}
