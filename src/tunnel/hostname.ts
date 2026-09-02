import { normalizeNamedTunnelHostname } from "./cloudflared-named.js";

/** DNS-safe label from a workspace name. Non-ASCII names fall back to the id. */
export function hostnameSlug(workspaceName: string, workspaceId: string): string {
  const ascii = workspaceName
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
  const label = ascii || `ws-${workspaceId.slice(0, 8)}`;
  return `c2c-${label}`;
}

export function suggestedNamedHostname(
  zone: string,
  workspaceName: string,
  workspaceId: string
): string {
  const zoneHost = normalizeNamedTunnelHostname(zone);
  return `${hostnameSlug(workspaceName, workspaceId)}.${zoneHost}`;
}

/** True only when `hostname` is exactly ONE label directly under `zone`
 *  (e.g. `imonikai.example.com` under zone `example.com`) — never the zone
 *  apex itself, never anything deeper. Cloudflare's default Universal SSL
 *  certificate for a zone normally covers just the apex and its immediate
 *  wildcard; a hostname one level deeper than that (whose "zone" would
 *  itself be a non-apex subdomain) routes DNS successfully but then fails
 *  TLS with a bare handshake error and no certificate offered — confirmed
 *  live against a real Cloudflare zone, 2026-09-02 (see
 *  docs/troubleshooting.md). This is a deliberately strict, mechanical
 *  check — it does not call the Cloudflare API to look up the real zone,
 *  it only rejects the specific shape that is known to fail. */
export function isHostnameDirectlyUnderZone(hostname: string, zone: string): boolean {
  let h: string;
  let z: string;
  try {
    h = normalizeNamedTunnelHostname(hostname);
    z = normalizeNamedTunnelHostname(zone);
  } catch {
    return false;
  }
  if (h === z || !h.endsWith(`.${z}`)) return false;
  const label = h.slice(0, -(z.length + 1));
  return label.length > 0 && !label.includes(".");
}

export function parseZoneInput(input: string): string | null {
  const trimmed = input.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "").replace(/\.$/, "");
  if (!trimmed) return null;
  try {
    return normalizeNamedTunnelHostname(trimmed);
  } catch {
    return null;
  }
}
