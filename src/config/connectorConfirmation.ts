import path from "node:path";
import { getStateDir, readJsonIfExists, writeSecureJson } from "./paths.js";

/**
 * Tracks the MCP URL ChatGPT has actually, provably connected to — distinct
 * from `LastEndpoint.mcpUrl` (endpoint.ts), which only records what we last
 * *told* ChatGPT to use. Writing the desired URL locally does not mean
 * ChatGPT's connector has finished reconnecting to it (Delete+recreate and
 * OAuth re-authorization are manual, human-driven steps that can fail or be
 * abandoned mid-way). Only a successful `POST /oauth/token`
 * authorization_code exchange proves an external client completed a live
 * round trip against a given URL — that's the one moment this gets updated.
 */
export interface ConnectorConfirmation {
  workspaceId: string;
  confirmedMcpUrl: string;
  confirmedAt: string;
}

function confirmationFile(workspaceId: string): string {
  return path.join(getStateDir(), "connector-confirmations", `${workspaceId}.json`);
}

export function readConnectorConfirmation(workspaceId: string): ConnectorConfirmation | null {
  return readJsonIfExists<ConnectorConfirmation>(confirmationFile(workspaceId));
}

export function recordConnectorConfirmation(workspaceId: string, mcpUrl: string): ConnectorConfirmation {
  const confirmation: ConnectorConfirmation = {
    workspaceId,
    confirmedMcpUrl: mcpUrl,
    confirmedAt: new Date().toISOString(),
  };
  writeSecureJson(confirmationFile(workspaceId), confirmation);
  return confirmation;
}

/** True when we have a URL we currently want ChatGPT to be using, and no
 *  confirmed OAuth round trip has ever completed against that exact URL —
 *  i.e. a repair (Delete+recreate+re-auth) is still outstanding. A `null`
 *  desiredMcpUrl (no tunnel/URL at all yet) is not a repair-pending state —
 *  there's nothing to reconnect to. */
export function isConnectorRepairPending(desiredMcpUrl: string | null, workspaceId: string): boolean {
  if (!desiredMcpUrl) return false;
  const confirmation = readConnectorConfirmation(workspaceId);
  return confirmation?.confirmedMcpUrl !== desiredMcpUrl;
}
