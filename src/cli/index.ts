import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startBridge } from "../bridge/server.js";
import { findBridgeObservation, findLiveBridge, type RuntimeState } from "../bridge/runtime.js";
import { adminFetch, ensureBridge, stopBridge } from "../process/daemon.js";
import { Workspace } from "../workspace/manager.js";
import { AuthStore } from "../auth/store.js";
import { detectTunnelBinaries } from "../tunnel/detect.js";
import {
  chooseQuickTunnel,
  hasCloudflaredCert,
  ProcessCloudflaredAccount,
  provisionNamedTunnel,
  type CloudflaredAccount,
} from "../tunnel/named-provision.js";
import { parseZoneInput, suggestedNamedHostname } from "../tunnel/hostname.js";
import {
  canUpgradeToNamed,
  isNamedTunnelReady,
  NAMED_LOGIN_PROMPT,
  NAMED_REPAIR_MESSAGE,
  needsTunnelChoice,
  readTunnelState,
  TUNNEL_CHOICE_PROMPT,
} from "../tunnel/state.js";
import { Logger } from "../logger/index.js";
import { getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import {
  ensureSandboxAllowlist,
  getCodexConfigPath,
  isStateDirAllowlisted,
  shouldAutoSandboxAllow,
  type CodingAgent,
} from "../config/sandbox-allow.js";
import { mergeUiPrefs, readUiPrefs, SETUP_MODES, type SetupMode } from "../config/ui-prefs.js";
import {
  CHATGPT_CREATE_CONNECTOR_URL,
  CHATGPT_DEVELOPER_MODE_URL,
  CHATGPT_PLUGINS_URL,
  connectorAction,
  connectorNameFor,
  mcpUrlFromPublic,
  normalizePublicUrl,
  readLastEndpoint,
  reclaimUserMessage,
  writeLastEndpoint,
  type LastEndpoint,
} from "../config/endpoint.js";
import { isConnectorRepairPending, readConnectorConfirmation } from "../config/connectorConfirmation.js";
import { PRODUCT_NAME, VERSION } from "../version.js";
import {
  clearChatPointer,
  mergeSession,
  readSession,
  resolveConversation,
  writeSession,
  PROTOCOL_STATES,
  WAITING_FOR,
  type ConversationMode,
  type ProtocolState,
  type WaitingFor,
} from "../session/state.js";
import { appendExecutionRecord } from "../execution/records.js";
import { saveExecutionOutput } from "../execution/output.js";

const program = new Command();

const say = (msg: string): void => {
  process.stdout.write(msg + "\n");
};
const check = (msg: string): void => say(`✓ ${msg}`);
const cross = (msg: string): void => say(`✗ ${msg}`);

function resolveWorkspace(option?: string): string {
  return path.resolve(option ?? process.cwd());
}

/** Local harness output only. Never pasted into ChatGPT. */
const MAX_RECORD_OUTPUT_READ = 256 * 1024;

function readCappedUtf8(filePath: string, maxBytes: number): string {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function persistWorkspaceEndpoint(opts: {
  workspaceId: string;
  workspaceName: string;
  port: number;
  publicUrl: string | null;
  mcpUrl: string;
  previous?: LastEndpoint | null;
}): string {
  const previous = opts.previous ?? readLastEndpoint(opts.workspaceId);
  const connectorName = connectorNameFor({
    workspaceName: opts.workspaceName,
    workspaceId: opts.workspaceId,
    previousName: previous?.connectorName,
    hadEndpointBefore: Boolean(previous),
  });
  writeLastEndpoint({
    workspaceId: opts.workspaceId,
    port: opts.port,
    publicUrl: opts.publicUrl,
    mcpUrl: opts.mcpUrl,
    connectorName,
  });
  return connectorName;
}

function tunnelChoicePayload(workspace: Workspace, zoneHint?: string): Record<string, unknown> {
  const state = readTunnelState(workspace.id);
  const zone = parseZoneInput(zoneHint ?? "") ?? state.zone ?? null;
  return {
    ok: true,
    needsChoice: needsTunnelChoice(state),
    preference: state.preference,
    loggedIn: hasCloudflaredCert(),
    namedReady: isNamedTunnelReady(state),
    zone,
    hostname: state.hostname ?? null,
    suggestedHostname: zone ? suggestedNamedHostname(zone, workspace.name, workspace.id) : null,
    userPrompt: needsTunnelChoice(state) ? TUNNEL_CHOICE_PROMPT : undefined,
    loginPrompt: NAMED_LOGIN_PROMPT,
    fallbackReason: state.fallbackReason,
  };
}

function parseAgent(value?: string): CodingAgent | undefined {
  if (!value) return undefined;
  if (value === "codex" || value === "claude-code") return value;
  throw new Error(`Invalid --agent value: ${value} (expected "codex" or "claude-code")`);
}

function trySandboxAllow(agent?: CodingAgent):
  | { ok: true; added: boolean; alreadyAllowed: boolean; stateDir: string; configPath: string; skipped?: boolean }
  | { ok: false; added: false; alreadyAllowed: false; error: string } {
  if (!shouldAutoSandboxAllow(agent)) {
    return { ok: true, added: false, alreadyAllowed: false, stateDir: getStateDir(), configPath: getCodexConfigPath(), skipped: true };
  }
  try {
    const result = ensureSandboxAllowlist();
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, added: false, alreadyAllowed: false, error: (error as Error).message };
  }
}

interface TunnelStartResponse {
  url?: string;
  error?: string;
  message?: string;
}

interface PairingResponse {
  code: string;
  expiresAt: number;
}

export interface AdminInfo {
  workspaceId: string;
  workspaceName: string;
  workspaceRoot: string;
  port: number;
  publicUrl: string | null;
  tunnel: { running: boolean; url: string | null; provider: string };
  tokenCount: number;
  hasUsableAuthorization: boolean;
  pairingActive: boolean;
  pid: number;
  startedAt: string;
}

async function ensureBridgeAndTunnel(
  workspaceRoot: string,
  opts: { tunnel: boolean }
): Promise<{ runtime: RuntimeState; info: AdminInfo; mcpUrl: string | null }> {
  const { runtime } = await ensureBridge(workspaceRoot);
  let info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
  let mcpUrl: string | null = info.publicUrl ? `${info.publicUrl}/mcp` : null;
  if (opts.tunnel && !info.publicUrl) {
    const binaries = detectTunnelBinaries();
    if (!binaries.cloudflared) {
      throw new Error(
        "NEED_CLOUDFLARED: cloudflared is not installed. Install it first (macOS: brew install cloudflared)."
      );
    }
    const result = await adminFetch<TunnelStartResponse>(runtime, "POST", "/admin/tunnel/start", 90_000);
    if (!result.url) throw new Error(result.message ?? "Tunnel start failed");
    info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
    mcpUrl = `${result.url}/mcp`;
  }
  return { runtime, info, mcpUrl };
}

program
  .name("c2c")
  .description(`${PRODUCT_NAME} — ChatGPT thinks. Codex / Claude Code works.`)
  .version(VERSION, "-v, --version")
  .configureHelp({ sortSubcommands: true });

// ---------------------------------------------------------------- serve (internal)

program
  .command("serve", { hidden: true })
  .description("Run the bridge in the foreground (internal)")
  .requiredOption("--workspace <path>")
  .option("--port <port>", "preferred port")
  .action(async (opts: { workspace: string; port?: string }) => {
    const logger = new Logger({ name: "bridge", console: true });
    const bridge = await startBridge({
      workspaceRoot: resolveWorkspace(opts.workspace),
      port: opts.port ? parseInt(opts.port, 10) : undefined,
      logger,
    });
    const shutdown = (): void => {
      void bridge.close().then(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    say(`bridge ready on ${bridge.localBaseUrl()} (workspace ${bridge.workspace.name})`);
  });

// ---------------------------------------------------------------- start

program
  .command("start")
  .description("Start (or reuse) the bridge for this workspace")
  .option("-w, --workspace <path>", "workspace root (defaults to current directory)")
  .option("--tunnel", "also establish the secure public connection", false)
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; tunnel: boolean; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    try {
      const { runtime, info, mcpUrl } = await ensureBridgeAndTunnel(root, { tunnel: opts.tunnel });
      const connectorName = mcpUrl
        ? persistWorkspaceEndpoint({
            workspaceId: info.workspaceId,
            workspaceName: info.workspaceName,
            port: runtime.port,
            publicUrl: info.publicUrl,
            mcpUrl,
          })
        : readLastEndpoint(info.workspaceId)?.connectorName;
      if (opts.json) {
        say(JSON.stringify({ ok: true, port: runtime.port, workspaceId: info.workspaceId, mcpUrl, connectorName }));
        return;
      }
      check(`当前项目已识别（${info.workspaceName}）`);
      check("Workspace Bridge 已启动");
      if (mcpUrl) check("安全连接已建立");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

// ---------------------------------------------------------------- setup

program
  .command("setup")
  .description("First-time setup: bridge + secure connection + pairing code")
  .option("-w, --workspace <path>")
  .option("--agent <agent>", "calling coding agent: codex | claude-code")
  .option("--no-tunnel", "local-only setup (development)")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; agent?: string; tunnel: boolean; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    try {
      const agent = parseAgent(opts.agent);
      if (!opts.json) {
        say(PRODUCT_NAME);
        say("");
        say("正在连接 ChatGPT…");
        say("");
      }
      const sandbox = trySandboxAllow(agent);
      const { runtime, info, mcpUrl } = await ensureBridgeAndTunnel(root, { tunnel: opts.tunnel });
      const connectorName = mcpUrl
        ? persistWorkspaceEndpoint({
            workspaceId: info.workspaceId,
            workspaceName: info.workspaceName,
            port: runtime.port,
            publicUrl: info.publicUrl,
            mcpUrl,
          })
        : connectorNameFor({
            workspaceName: info.workspaceName,
            workspaceId: info.workspaceId,
            previousName: readLastEndpoint(info.workspaceId)?.connectorName,
            hadEndpointBefore: Boolean(readLastEndpoint(info.workspaceId)),
          });
      const pairingResult = await adminFetch<PairingResponse>(runtime, "POST", "/admin/pairing");
      const tunnelState = readTunnelState(info.workspaceId);
      if (opts.json) {
        say(
          JSON.stringify({
            ok: true,
            workspaceId: info.workspaceId,
            workspaceName: info.workspaceName,
            connectorName,
            mcpUrl: mcpUrl ?? `http://127.0.0.1:${runtime.port}/mcp`,
            local: mcpUrl === null,
            pairingCode: pairingResult.code,
            pairingExpiresAt: pairingResult.expiresAt,
            sandbox,
            tunnel: {
              mode: isNamedTunnelReady(tunnelState) ? "named" : "quick",
              hostname: tunnelState.hostname ?? null,
              fallback: Boolean(tunnelState.fallbackReason),
            },
          })
        );
        return;
      }
      check(`当前项目已识别（${info.workspaceName}）`);
      check("Workspace Bridge 已启动");
      if (mcpUrl) check("安全连接已建立");
      say("");
      say(`连接地址：${mcpUrl ?? `http://127.0.0.1:${runtime.port}/mcp`}`);
      say(`配对码：${pairingResult.code}（${Math.round((pairingResult.expiresAt - Date.now()) / 60000)} 分钟内有效）`);
      say("");
      say("下一步：在 ChatGPT 的连接器设置中添加以上地址（OAuth），并在授权页输入配对码。");
      say("如果你在使用 Codex 或 Claude Code 的 Skill，这一步会自动完成。");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

// ---------------------------------------------------------------- stop / restart

program
  .command("stop")
  .description("Stop the bridge for this workspace")
  .option("-w, --workspace <path>")
  .action(async (opts: { workspace?: string }) => {
    const stopped = await stopBridge(resolveWorkspace(opts.workspace));
    if (stopped) check("Bridge 已停止");
    else say("没有正在运行的 Bridge。");
  });

program
  .command("restart")
  .description("Restart the bridge for this workspace")
  .option("-w, --workspace <path>")
  .option("--tunnel", "re-establish the secure public connection", false)
  .action(async (opts: { workspace?: string; tunnel: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    await stopBridge(root);
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      const { info, mcpUrl } = await ensureBridgeAndTunnel(root, { tunnel: opts.tunnel });
      check(`Bridge 已重启（${info.workspaceName}）`);
      if (mcpUrl) check(`安全连接已建立`);
    } catch (error) {
      handleCliError(error, false);
    }
  });

// ---------------------------------------------------------------- status

program
  .command("status")
  .description("Show bridge status for this workspace")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    const workspace = new Workspace(root);
    const observation = await findBridgeObservation(workspace.id);
    if (observation.state === "unknown") {
      if (opts.json) {
        say(JSON.stringify({ ok: false, running: null, state: "unknown", reason: observation.reason }));
      } else {
        cross(`Bridge 状态无法确认（${observation.reason}），未将其视为未运行。`);
      }
      return;
    }
    if (observation.state === "stopped") {
      if (opts.json) say(JSON.stringify({ ok: false, running: false }));
      else say("Bridge 未运行。使用 `c2c start` 启动。");
      return;
    }
    const runtime = observation.runtime;
    const info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
    if (opts.json) {
      say(JSON.stringify({ ok: true, running: true, ...info }));
      return;
    }
    say(PRODUCT_NAME);
    say("");
    check(`Workspace：${info.workspaceName}`);
    check(`Bridge：运行中（端口 ${info.port}）`);
    if (info.tunnel.running && info.tunnel.url) check(`安全连接：${info.tunnel.url}/mcp`);
    else say("· 安全连接：未启用（本地模式）");
    say(`· 已授权连接：${info.tokenCount > 0 ? "是" : "否"}`);
  });

// ---------------------------------------------------------------- doctor

program
  .command("doctor")
  .description("Diagnose and auto-repair the connection")
  .option("-w, --workspace <path>")
  .option("--agent <agent>", "calling coding agent: codex | claude-code")
  .option("--no-fix", "diagnose only, do not repair")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; agent?: string; fix: boolean; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    const agent = parseAgent(opts.agent);
    const report: Record<string, { ok: boolean; detail?: string }> = {};
    const results: string[] = [];

    // Node
    const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
    report.node = { ok: nodeMajor >= 20, detail: `v${process.versions.node}` };

    // Codex sandbox writable_roots (so later chats do not need elevation).
    // Claude Code has its own permission-prompt model and does not use this at all.
    if (!shouldAutoSandboxAllow(agent)) {
      report.sandbox = { ok: true, detail: "不适用（Claude Code 使用自身权限模型）" };
    } else if (opts.fix) {
      const sandbox = trySandboxAllow(agent);
      if (sandbox.ok) {
        report.sandbox = { ok: true, detail: sandbox.alreadyAllowed ? "已在白名单" : "已写入白名单" };
        if (sandbox.added) results.push("已将本地设置目录加入 Codex 沙箱白名单");
      } else {
        report.sandbox = { ok: false, detail: sandbox.error };
      }
    } else {
      try {
        const configPath = getCodexConfigPath();
        const allowed =
          fs.existsSync(configPath) && isStateDirAllowlisted(fs.readFileSync(configPath, "utf8"), getStateDir());
        report.sandbox = allowed ? { ok: true, detail: "已在白名单" } : { ok: false, detail: "未在白名单" };
      } catch (error) {
        report.sandbox = { ok: false, detail: (error as Error).message };
      }
    }

    // Workspace
    let workspace: Workspace | null = null;
    try {
      workspace = new Workspace(root);
      report.workspace = { ok: true, detail: workspace.name };
    } catch (error) {
      report.workspace = { ok: false, detail: (error as Error).message };
    }

    // Bridge
    let runtime: RuntimeState | null = null;
    let bridgeUnknown = false;
    if (workspace) {
      const observation = await findBridgeObservation(workspace.id);
      if (observation.state === "healthy") {
        runtime = observation.runtime;
      } else if (observation.state === "unknown") {
        bridgeUnknown = true;
        report.bridge = { ok: false, detail: `状态无法确认（${observation.reason}），未自动修复` };
      } else if (opts.fix) {
        try {
          runtime = (await ensureBridge(root)).runtime;
          results.push("已自动启动 Bridge");
        } catch (error) {
          report.bridge = { ok: false, detail: (error as Error).message };
        }
      }
      if (runtime) report.bridge = { ok: true, detail: `端口 ${runtime.port}` };
      else report.bridge = report.bridge ?? { ok: false, detail: "未运行" };
    }

    // MCP local reachability (401 without token means MCP + auth both work)
    if (runtime) {
      try {
        const response = await fetch(`http://127.0.0.1:${runtime.port}/mcp`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
        });
        report.mcp = { ok: response.status === 401, detail: `未授权请求返回 ${response.status}` };
        report.oauth = { ok: response.status === 401 };
      } catch (error) {
        report.mcp = { ok: false, detail: (error as Error).message };
      }
    }

    // Tunnel + remote reachability. If this workspace once had a public URL,
    // a full quit reclaims it — restore a tunnel and tell the Skill to update
    // the existing ChatGPT connector (never treat that as "local mode").
    const lastEndpoint = workspace ? readLastEndpoint(workspace.id) : null;
    const connectorName = workspace
      ? connectorNameFor({
          workspaceName: workspace.name,
          workspaceId: workspace.id,
          previousName: lastEndpoint?.connectorName,
          hadEndpointBefore: Boolean(lastEndpoint),
        })
      : "Codex with ChatGPT";
    const tunnelState = workspace ? readTunnelState(workspace.id) : null;
    const namedReady = tunnelState ? isNamedTunnelReady(tunnelState) : false;
    let namedRepair: { needed: boolean; userMessage?: string } = { needed: false };
    let chatgptRepair: {
      needed: boolean;
      reason?: string;
      connectorAction: "none" | "create" | "update";
      connectorName: string;
      userMessage?: string;
      mcpUrl: string | null;
      previousMcpUrl: string | null;
      pairingCode?: string;
      pairingExpiresAt?: number;
      /** Distinct from connectorAction/reason (both derived only from OUR
       *  OWN locally-persisted address bookkeeping): true when the URL we
       *  currently want ChatGPT to use has never been confirmed by an
       *  actual, successful OAuth round trip (see connectorConfirmation.ts).
       *  Writing local state is not proof ChatGPT's connector finished
       *  reconnecting — Delete+recreate+re-auth is a manual, human-driven
       *  step that can fail or be abandoned mid-way. */
      connectorRepairPending: boolean;
      desiredEndpoint: string | null;
      confirmedConnectorEndpoint: string | null;
      pages: {
        developerMode: string;
        plugins: string;
        createConnector: string;
      };
    } = {
      needed: false,
      connectorAction: "none",
      connectorName,
      mcpUrl: lastEndpoint?.mcpUrl ?? null,
      previousMcpUrl: lastEndpoint?.mcpUrl ?? null,
      connectorRepairPending: false,
      desiredEndpoint: lastEndpoint?.mcpUrl ?? null,
      confirmedConnectorEndpoint: workspace ? readConnectorConfirmation(workspace.id)?.confirmedMcpUrl ?? null : null,
      pages: {
        developerMode: CHATGPT_DEVELOPER_MODE_URL,
        plugins: CHATGPT_PLUGINS_URL,
        createConnector: CHATGPT_CREATE_CONNECTOR_URL,
      },
    };

    if (runtime) {
      let info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
      if (namedReady && opts.fix && info.tunnel.provider !== "cloudflare-named") {
        try {
          const repair = await attemptNamedFallbackRepair(root);
          runtime = repair.runtime;
          info = repair.info;
          results.push(repair.repaired ? "已切换到固定域名连接" : "尝试恢复固定域名连接，但目前仍在使用临时地址");
        } catch (error) {
          report.tunnel = { ok: false, detail: (error as Error).message };
        }
      }
      const expectedPublic = Boolean(lastEndpoint?.publicUrl) || namedReady;
      let currentUrl = info.publicUrl ?? info.tunnel.url;
      let healthy = false;
      if (currentUrl) {
        try {
          const response = await fetch(`${currentUrl}/health`, { signal: AbortSignal.timeout(8000) });
          healthy = response.ok;
        } catch {
          healthy = false;
        }
      }

      if ((!currentUrl || !healthy) && opts.fix && (expectedPublic || info.tunnel.running)) {
        try {
          const binaries = detectTunnelBinaries();
          if (!binaries.cloudflared) {
            report.tunnel = { ok: false, detail: "NEED_CLOUDFLARED" };
          } else {
            const started = await adminFetch<TunnelStartResponse>(runtime, "POST", "/admin/tunnel/start", 90_000);
            if (started.url) {
              const previousUrl = lastEndpoint?.publicUrl;
              currentUrl = started.url;
              healthy = true;
              info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
              const sameAddress =
                previousUrl && normalizePublicUrl(previousUrl) === normalizePublicUrl(started.url);
              results.push(sameAddress ? "已重新建立安全连接" : "已重新建立安全连接（地址已更换）");
            }
          }
        } catch (error) {
          report.tunnel = { ok: false, detail: (error as Error).message };
        }
      }

      if (currentUrl && healthy) {
        report.tunnel = { ok: true, detail: currentUrl };
        const nextMcp = mcpUrlFromPublic(currentUrl);
        const action = connectorAction(lastEndpoint?.mcpUrl, nextMcp);
        const boundName = nextMcp
          ? persistWorkspaceEndpoint({
              workspaceId: info.workspaceId,
              workspaceName: info.workspaceName,
              port: runtime.port,
              publicUrl: currentUrl,
              mcpUrl: nextMcp,
              previous: lastEndpoint,
            })
          : connectorName;
        // No backfill: a URL with a currently-valid token but no recorded
        // confirmation is NOT proof the token was ever exchanged against
        // THIS URL — it could equally be a leftover, still-unexpired token
        // from a PREVIOUS URL that this workspace's tunnel/connector has
        // since moved past (e.g. old URL -> tunnel changed -> doctor
        // persisted the new URL -> repair never actually completed -> old
        // token is still valid -> the new URL would get wrongly confirmed).
        // Unconfirmable connectors — including ones that predate this
        // tracking entirely — stay pending rather than being guessed into
        // "confirmed". They keep working; doctor just can't vouch for them
        // until a real authorization_code exchange is observed against the
        // exact current URL (see server.ts's onAuthorizationCodeExchanged).
        const repairPending = nextMcp ? isConnectorRepairPending(nextMcp, info.workspaceId) : false;
        chatgptRepair = {
          ...chatgptRepair,
          needed: action === "update" || repairPending,
          reason: action === "update" ? "address_reclaimed" : undefined,
          connectorAction: action,
          connectorName: boundName,
          userMessage: action === "update" ? reclaimUserMessage(boundName) : undefined,
          mcpUrl: nextMcp,
          previousMcpUrl: lastEndpoint?.mcpUrl ?? null,
          connectorRepairPending: repairPending,
          desiredEndpoint: nextMcp,
          confirmedConnectorEndpoint: readConnectorConfirmation(info.workspaceId)?.confirmedMcpUrl ?? null,
        };
        if (action === "update") {
          try {
            const pairing = await adminFetch<PairingResponse>(runtime, "POST", "/admin/pairing");
            chatgptRepair.pairingCode = pairing.code;
            chatgptRepair.pairingExpiresAt = pairing.expiresAt;
            results.push(`已生成新的配对码，需要更新「${boundName}」`);
          } catch (error) {
            report.oauth = { ok: false, detail: (error as Error).message };
          }
        }
      } else if (namedReady) {
        report.tunnel = report.tunnel ?? { ok: false, detail: "NAMED_TUNNEL_DOWN" };
        namedRepair = { needed: true, userMessage: NAMED_REPAIR_MESSAGE };
      } else if (expectedPublic) {
        report.tunnel = report.tunnel ?? { ok: false, detail: "安全连接未恢复" };
        chatgptRepair = {
          ...chatgptRepair,
          needed: true,
          reason: "address_reclaimed",
          connectorAction: "update",
          connectorName,
          userMessage: reclaimUserMessage(connectorName),
          mcpUrl: null,
        };
      } else if (!currentUrl) {
        report.tunnel = { ok: true, detail: "未启用（本地模式）" };
      } else {
        report.tunnel = { ok: false, detail: "公网地址无法访问" };
      }
    } else if (bridgeUnknown) {
      report.tunnel = report.tunnel ?? { ok: false, detail: "Bridge 状态无法确认，未执行连接器修复" };
    } else if (namedReady) {
      report.tunnel = { ok: false, detail: "NAMED_TUNNEL_DOWN" };
      namedRepair = { needed: true, userMessage: NAMED_REPAIR_MESSAGE };
    } else if (lastEndpoint?.publicUrl) {
      report.tunnel = { ok: false, detail: "安全连接未运行" };
      chatgptRepair = {
        ...chatgptRepair,
        needed: true,
        reason: "address_reclaimed",
        connectorAction: "update",
        connectorName,
        userMessage: reclaimUserMessage(connectorName),
      };
    }

    if (opts.json) {
      say(JSON.stringify({ report, repairs: results, chatgptRepair, namedRepair }));
      return;
    }
    say(`${PRODUCT_NAME} Doctor`);
    say("");
    const labels: Record<string, string> = {
      node: "Node.js",
      sandbox: "Sandbox",
      workspace: "Workspace",
      bridge: "Bridge",
      mcp: "MCP",
      oauth: "OAuth",
      tunnel: "Tunnel",
    };
    let allOk = true;
    for (const [key, value] of Object.entries(report)) {
      const label = labels[key] ?? key;
      if (value.ok) check(`${label}${value.detail ? `（${value.detail}）` : ""}`);
      else {
        cross(`${label}${value.detail ? `：${value.detail}` : ""}`);
        allOk = false;
      }
    }
    for (const repair of results) say(`· ${repair}`);
    say("");
    if (namedRepair.needed && namedRepair.userMessage) {
      say(namedRepair.userMessage);
      say("");
    }
    if (chatgptRepair.needed && chatgptRepair.userMessage) {
      say(chatgptRepair.userMessage);
      if (chatgptRepair.mcpUrl) say(`新的连接地址：${chatgptRepair.mcpUrl}`);
      if (chatgptRepair.pairingCode) say(`配对码：${chatgptRepair.pairingCode}`);
      say("");
    }
    say(
      allOk && !chatgptRepair.needed && !namedRepair.needed
        ? "Everything looks good."
        : chatgptRepair.needed
          ? "本地已就绪，还需要在 ChatGPT 删除并重新添加该连接。"
          : namedRepair.needed
            ? "固定域名还没连上，需要先登录 Cloudflare。"
            : "仍有问题未解决，可尝试 `c2c restart --tunnel`。"
    );
    if (!allOk || namedRepair.needed) process.exitCode = 1;
  });

// ---------------------------------------------------------------- pair / unpair

program
  .command("pair")
  .description("Generate a fresh pairing code")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; json: boolean }) => {
    try {
      const { runtime } = await ensureBridge(resolveWorkspace(opts.workspace));
      const pairing = await adminFetch<PairingResponse>(runtime, "POST", "/admin/pairing");
      if (opts.json) say(JSON.stringify({ ok: true, pairingCode: pairing.code, expiresAt: pairing.expiresAt }));
      else {
        say(`配对码：${pairing.code}`);
        say(`（${Math.round((pairing.expiresAt - Date.now()) / 60000)} 分钟内有效，仅可使用一次）`);
      }
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

program
  .command("unpair")
  .description("Revoke ChatGPT's access to this workspace immediately")
  .option("-w, --workspace <path>")
  .action(async (opts: { workspace?: string }) => {
    const root = resolveWorkspace(opts.workspace);
    const workspace = new Workspace(root);
    const runtime = await findLiveBridge(workspace.id);
    if (runtime) {
      await adminFetch(runtime, "POST", "/admin/revoke-all");
    } else {
      // bridge not running: revoke directly in the persisted store
      new AuthStore(workspace.id).revokeAll();
    }
    check("已断开 ChatGPT 对当前项目的访问（所有令牌已吊销）");
  });

// ---------------------------------------------------------------- logs / workspace / record

program
  .command("logs")
  .description("Show recent bridge logs")
  .option("-w, --workspace <path>")
  .option("-n, --lines <n>", "number of lines", "50")
  .option("--verbose", "include debug detail", false)
  .action((opts: { workspace?: string; lines: string; verbose: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const candidates = [
      path.join(getStateDir(), "logs", "bridge.log"),
      path.join(getStateDir(), "logs", `bridge-${workspace.id}.out.log`),
    ];
    let shown = false;
    for (const file of candidates) {
      if (!fs.existsSync(file)) continue;
      const lines = fs.readFileSync(file, "utf8").trim().split("\n");
      const filtered = opts.verbose ? lines : lines.filter((line) => !line.includes(" DEBUG "));
      say(filtered.slice(-parseInt(opts.lines, 10)).join("\n"));
      shown = true;
    }
    if (!shown) say("暂无日志。");
  });

program
  .command("workspace")
  .description("Show workspace identity and project info")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; json: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const project = workspace.detectProject();
    const data = { workspaceId: workspace.id, name: workspace.name, root: workspace.root, ...project };
    if (opts.json) say(JSON.stringify(data));
    else {
      say(`Workspace：${data.name}（${data.workspaceId}）`);
      say(`类型：${data.projectType}  语言：${data.languages.join(", ") || "-"}`);
      say(`路径：${data.root}`);
    }
  });

// ---------------------------------------------------------------- chatgpt-policy (shared ChatGPT-surface policy)

program
  .command("chatgpt-policy")
  .description(
    "Resolved ChatGPT-surface policy for this workspace (chatgptSurface / rejectWorkSuggestion). " +
      "Shared by every coding-agent Skill — see docs/chatgpt-interaction-policy.md."
  )
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; json: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const policy = workspace.chatgptPolicy;
    if (opts.json) {
      say(JSON.stringify({ ok: true, ...policy }));
      return;
    }
    say(`chatgptSurface: ${policy.chatgptSurface}`);
    say(`rejectWorkSuggestion: ${policy.rejectWorkSuggestion}`);
  });

// ---------------------------------------------------------------- sandbox-allow (Codex writable_roots, macOS + Windows)

program
  .command("sandbox-allow")
  .description("Add the local settings directory to the Codex sandbox allowlist")
  .option("--json", "machine-readable output", false)
  .action((opts: { json: boolean }) => {
    const result = trySandboxAllow();
    if (opts.json) {
      say(JSON.stringify(result));
      if (!result.ok) process.exitCode = 1;
      return;
    }
    if (!result.ok) {
      cross(`无法写入 Codex 沙箱白名单：${result.error}`);
      process.exitCode = 1;
      return;
    }
    if (result.alreadyAllowed) check("沙箱白名单已就绪，后续对话无需再提权");
    else check("已将本地设置目录加入 Codex 沙箱白名单（后续对话无需再提权）");
  });

// ---------------------------------------------------------------- update-check (once per local day)

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function runGit(args: string[]): { ok: boolean; stdout: string } {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 8000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return { ok: result.status === 0, stdout: (result.stdout ?? "").trim() };
}

program
  .command("update-check")
  .description("Check GitHub for a newer version (real check at most once per local day)")
  .option("--force", "check even if already checked today", false)
  .option("--json", "machine-readable output", false)
  .action((opts: { force: boolean; json: boolean }) => {
    const file = path.join(getStateDir(), "update-check.json");
    const today = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD in local tz
    let last: { date?: string; updateAvailable?: boolean } = {};
    try {
      last = JSON.parse(fs.readFileSync(file, "utf8")) as typeof last;
    } catch {
      /* first run */
    }

    const emit = (data: {
      checked: boolean;
      updateAvailable: boolean;
      localCommit?: string;
      remoteCommit?: string;
      note?: string;
    }): void => {
      if (opts.json) say(JSON.stringify({ ok: true, version: VERSION, ...data }));
      else if (data.updateAvailable) say(`发现新版本（本地 ${data.localCommit?.slice(0, 7)} → 远端 ${data.remoteCommit?.slice(0, 7)}）。`);
      else say(data.note ?? "已是最新版本。");
    };

    if (!opts.force && last.date === today) {
      emit({ checked: false, updateAvailable: last.updateAvailable ?? false, note: "今天已检查过更新。" });
      return;
    }

    const local = runGit(["rev-parse", "HEAD"]);
    const remote = runGit(["ls-remote", "origin", "HEAD"]);
    if (!local.ok || !remote.ok || !remote.stdout) {
      // Offline or not a git checkout: skip quietly and retry tomorrow-ish (do not
      // record the date so a transient failure does not suppress the daily check).
      emit({ checked: false, updateAvailable: false, note: "无法检查更新（离线或非 git 安装），已跳过。" });
      return;
    }
    const remoteCommit = remote.stdout.split(/\s/)[0];
    const updateAvailable = remoteCommit !== local.stdout;
    fs.mkdirSync(getStateDir(), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ date: today, updateAvailable, remoteCommit }), { mode: 0o600 });
    emit({ checked: true, updateAvailable, localCommit: local.stdout, remoteCommit });
  });

// ---------------------------------------------------------------- session (ChatGPT conversation / Project memory)

const session = program
  .command("session")
  .description("Remember the ChatGPT Project and conversation for this workspace");

session
  .command("get", { isDefault: true })
  .description("Show the saved ChatGPT conversation / Project for this workspace")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; json: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const saved = readSession(workspace.id);
    const conversation = resolveConversation(saved);
    if (opts.json) say(JSON.stringify({ ok: true, session: saved, conversation }));
    else if (!saved) {
      say("尚未记录 ChatGPT 会话。新仓库默认使用 Project 合集。");
    } else {
      say(`模式：${conversation.mode === "project" ? "Project 合集" : "长对话"}`);
      if (conversation.projectUrl) say(`合集：${conversation.projectUrl}`);
      if (saved.title) say(`会话：${saved.title}`);
      if (saved.url) say(`对话：${saved.url}`);
      if (saved.connectorName) say(`连接器：${saved.connectorName}`);
      if (saved.taskId) say(`任务：${saved.taskId}（第 ${saved.iteration ?? 0} 轮，${saved.lastState ?? "?"}）`);
      if (saved.checkpoint) {
        say(
          `存档：${saved.checkpoint.protocolState} / 等待 ${saved.checkpoint.waitingFor}（第 ${saved.checkpoint.iteration} 轮）`
        );
      }
    }
  });

session
  .command("set")
  .description("Save the ChatGPT Project and/or conversation for this workspace")
  .option("-w, --workspace <path>")
  .option("--url <url>", "ChatGPT conversation URL from the address bar")
  .option("--title <title>")
  .option("--task <id>")
  .option("--iteration <n>")
  .option("--state <state>", "last protocol state, e.g. EXECUTED")
  .option("--mode <mode>", "long-chat or project")
  .option("--project-url <url>", "ChatGPT Project collection URL (…/g/g-p-…/project)")
  .option("--connector-name <name>", "exact connector title for this workspace")
  .option("--protocol-state <state>", "checkpoint protocol state, e.g. EXECUTED_SENT")
  .option("--waiting-for <who>", "none | GPT_PLAN | GPT_REVIEW | USER")
  .option("--goal <text>", "original task goal for resume / HANDOFF")
  .option("--completed-subtasks <text>")
  .option("--known-issues <text>")
  .option("--next-step <text>")
  .option("--clear-checkpoint", "drop the active checkpoint (task DONE)", false)
  .action(
    (opts: {
      workspace?: string;
      url?: string;
      title?: string;
      task?: string;
      iteration?: string;
      state?: string;
      mode?: string;
      projectUrl?: string;
      connectorName?: string;
      protocolState?: string;
      waitingFor?: string;
      goal?: string;
      completedSubtasks?: string;
      knownIssues?: string;
      nextStep?: string;
      clearCheckpoint: boolean;
    }) => {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const modeRaw = opts.mode?.trim().toLowerCase();
      if (modeRaw && modeRaw !== "long-chat" && modeRaw !== "project") {
        throw new Error("mode must be long-chat or project");
      }
      const protocolRaw = opts.protocolState?.trim().toUpperCase();
      if (protocolRaw && !PROTOCOL_STATES.includes(protocolRaw as ProtocolState)) {
        throw new Error(`protocol-state must be one of ${PROTOCOL_STATES.join(", ")}`);
      }
      const waitingRaw = opts.waitingFor?.trim();
      const waitingNorm = waitingRaw
        ? waitingRaw.toLowerCase() === "none"
          ? "none"
          : waitingRaw.toUpperCase()
        : undefined;
      if (waitingNorm && !WAITING_FOR.includes(waitingNorm as WaitingFor)) {
        throw new Error(`waiting-for must be one of ${WAITING_FOR.join(", ")}`);
      }
      const saved = mergeSession(readSession(workspace.id), {
        url: opts.url,
        title: opts.title,
        taskId: opts.task,
        iteration: opts.iteration ? parseInt(opts.iteration, 10) : undefined,
        lastState: opts.state,
        conversationMode: modeRaw as ConversationMode | undefined,
        projectUrl: opts.projectUrl,
        connectorName: opts.connectorName,
        clearCheckpoint: opts.clearCheckpoint,
        checkpoint: protocolRaw
          ? {
              protocolState: protocolRaw as ProtocolState,
              waitingFor: (waitingNorm as WaitingFor | undefined) ?? undefined,
              originalGoal: opts.goal,
              completedSubtasks: opts.completedSubtasks,
              knownIssues: opts.knownIssues,
              nextExpectedStep: opts.nextStep,
            }
          : undefined,
      });
      writeSession(workspace.id, saved);
      if (saved.projectUrl && saved.conversationMode === "project") {
        check("已记录 ChatGPT 合集，后续从合集页新开或复用对话");
      } else {
        check("已记录 ChatGPT 会话，后续任务将复用");
      }
    }
  );

session
  .command("clear")
  .description("Forget the current ChatGPT chat (Project binding is kept)")
  .option("-w, --workspace <path>")
  .action((opts: { workspace?: string }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const result = clearChatPointer(workspace.id);
    if (!result.cleared) say("尚未记录 ChatGPT 会话。");
    else if (result.keptProject) check("已清除当前对话，合集绑定仍保留");
    else check("已清除会话记录，下次任务将新建 ChatGPT 会话");
  });

const prefsCmd = program
  .command("prefs")
  .description("Remember ChatGPT developer mode and setup choice for this machine");

prefsCmd
  .command("get", { isDefault: true })
  .description("Show remembered ChatGPT setup choices (not per workspace)")
  .option("--json", "machine-readable output", false)
  .action((opts: { json: boolean }) => {
    const prefs = readUiPrefs();
    if (opts.json) {
      say(JSON.stringify({ ok: true, ...prefs }));
      return;
    }
    say(prefs.developerModeEnabled ? "开发人员模式：已记住已开启" : "开发人员模式：尚未记住");
    if (prefs.setupMode === "auto") say("配置方式：AI 自动化配置（预览版）");
    else if (prefs.setupMode === "manual") say("配置方式：手动教学配置");
    else say("配置方式：尚未选择");
  });

prefsCmd
  .command("set")
  .description("Save a ChatGPT setup choice for this machine")
  .option("--developer-mode", "remember that ChatGPT developer mode is on", false)
  .option("--setup-mode <mode>", "auto (preview) or manual")
  .option("--json", "machine-readable output", false)
  .action((opts: { developerMode: boolean; setupMode?: string; json: boolean }) => {
    try {
      const modeRaw = opts.setupMode?.trim().toLowerCase();
      if (modeRaw && !SETUP_MODES.includes(modeRaw as SetupMode)) {
        throw new Error(`setup-mode must be one of ${SETUP_MODES.join(", ")}`);
      }
      if (!opts.developerMode && !modeRaw) {
        throw new Error("nothing to save: pass --developer-mode and/or --setup-mode");
      }
      const prefs = mergeUiPrefs({
        developerModeEnabled: opts.developerMode ? true : undefined,
        setupMode: modeRaw as SetupMode | undefined,
      });
      if (opts.json) {
        say(JSON.stringify({ ok: true, ...prefs }));
        return;
      }
      if (opts.developerMode) check("已记住开发人员模式已开启");
      if (modeRaw === "auto") check("已记住配置方式：AI 自动化配置（预览版）");
      if (modeRaw === "manual") check("已记住配置方式：手动教学配置");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

program
  .command("record", { hidden: true })
  .description("Record a coding-agent execution summary (used by the Codex / Claude Code Skill)")
  .option("-w, --workspace <path>")
  .requiredOption("--task <id>")
  .requiredOption("--iteration <n>")
  .option("--changed-files <filesOrCount>", "comma-separated files or a count", "0")
  .option("--tests <summary>", "e.g. '27 passed'")
  .option("--exit-status <status>", "ok | failed | blocked", "ok")
  .option("--notes <text>")
  .option("--command <text>", "command whose output may be offered to ChatGPT")
  .option("--output <text>", "command output (prefer --output-file for long logs)")
  .option("--output-file <path>", "read command output from a local file")
  .option("--exit-code <n>", "numeric exit code of that command")
  .action(
    (opts: {
      workspace?: string;
      task: string;
      iteration: string;
      changedFiles: string;
      tests?: string;
      exitStatus: string;
      notes?: string;
      command?: string;
      output?: string;
      outputFile?: string;
      exitCode?: string;
    }) => {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const changed = /^\d+$/.test(opts.changedFiles)
        ? parseInt(opts.changedFiles, 10)
        : opts.changedFiles.split(",").map((file) => file.trim()).filter(Boolean);
      let outputId: number | undefined;
      let outputAvailable = false;
      const rawOutput =
        opts.outputFile !== undefined
          ? readCappedUtf8(path.resolve(opts.outputFile), MAX_RECORD_OUTPUT_READ)
          : opts.output;
      if (opts.command && rawOutput !== undefined) {
        const savedOutput = saveExecutionOutput(workspace.id, {
          command: opts.command,
          raw: rawOutput,
          exitCode: opts.exitCode !== undefined ? parseInt(opts.exitCode, 10) : null,
          taskId: opts.task,
          iteration: parseInt(opts.iteration, 10),
        });
        outputId = savedOutput.id;
        outputAvailable = savedOutput.allowed;
      }
      appendExecutionRecord(workspace.id, {
        taskId: opts.task,
        iteration: parseInt(opts.iteration, 10),
        changedFiles: changed,
        tests: opts.tests ?? null,
        exitStatus: opts.exitStatus,
        timestamp: new Date().toISOString(),
        notes: opts.notes?.slice(0, 400),
        outputId,
        outputAvailable,
      });
      if (outputId !== undefined && !outputAvailable) check("已记录执行摘要（输出未对 ChatGPT 开放）");
      else if (outputId !== undefined) check("已记录执行摘要与输出");
      else check("已记录执行摘要");
    }
  );

const tunnelCmd = program.command("tunnel").description("Choose or inspect the public connection for this workspace");

tunnelCmd
  .command("status", { isDefault: true })
  .description("Show whether this workspace still needs a one-time connection choice")
  .option("-w, --workspace <path>")
  .option("--zone <domain>", "optional domain, used to preview the stable hostname")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; zone?: string; json: boolean }) => {
    try {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const payload = tunnelChoicePayload(workspace, opts.zone);
      if (opts.json) {
        say(JSON.stringify(payload));
        return;
      }
      if (payload.needsChoice) say(TUNNEL_CHOICE_PROMPT);
      else if (payload.namedReady) check(`固定域名：${payload.hostname}`);
      else say("当前使用临时地址。");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

tunnelCmd
  .command("choose")
  .description("Remember quick vs named, and provision a named hostname when asked")
  .requiredOption("--mode <mode>", "quick or named")
  .option("-w, --workspace <path>")
  .option("--zone <domain>", "Cloudflare domain for a named hostname")
  .option("--hostname <hostname>", "override the default c2c-<project>.<zone>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { mode: string; workspace?: string; zone?: string; hostname?: string; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    try {
      const workspace = new Workspace(root);
      const mode = opts.mode.trim().toLowerCase();
      const previous = readTunnelState(workspace.id);
      if (mode === "quick") {
        const state = chooseQuickTunnel(workspace.id);
        if (await findLiveBridge(workspace.id)) {
          if (previous.preference === "named") await stopBridge(root);
        }
        const payload = { ...tunnelChoicePayload(workspace), state };
        if (opts.json) say(JSON.stringify(payload));
        else check("已选用临时地址");
        return;
      }
      if (mode !== "named") {
        throw new Error("mode must be quick or named");
      }
      const zone = parseZoneInput(opts.zone ?? "");
      if (!zone) {
        const payload = {
          ok: false,
          need: "zone",
          userMessage: "请告诉我已经加在 Cloudflare 上的域名，例如 example.com",
          loginPrompt: NAMED_LOGIN_PROMPT,
        };
        if (opts.json) {
          say(JSON.stringify(payload));
          return;
        }
        say(payload.userMessage);
        return;
      }
      if (!opts.json) say(NAMED_LOGIN_PROMPT);
      const result = await provisionNamedTunnel({
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        zone,
        hostname: opts.hostname,
      });
      if (await findLiveBridge(workspace.id)) await stopBridge(root);
      const payload = {
        ...tunnelChoicePayload(workspace),
        ok: true,
        fallback: result.fallback,
        userMessage: result.userMessage,
        error: result.error,
        state: result.state,
      };
      if (opts.json) {
        say(JSON.stringify(payload));
        return;
      }
      if (result.fallback) say(result.userMessage ?? "");
      else check(`固定域名已就绪：${result.state.hostname}`);
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

tunnelCmd
  .command("login")
  .description("Open the Cloudflare login window used by a named hostname")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { json: boolean }) => {
    try {
      if (!opts.json) say(NAMED_LOGIN_PROMPT);
      const account = new ProcessCloudflaredAccount();
      await account.login();
      const payload = { ok: true, loggedIn: hasCloudflaredCert() };
      if (opts.json) say(JSON.stringify(payload));
      else check("Cloudflare 已登录");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

// ---------------------------------------------------------------- imonikai (芋煮会: shared zero-touch bootstrap)
//
// Common layer for the "芋煮会" trigger in both Skills. Neither Skill
// re-implements this decision tree in prose — both just call these two
// commands and follow the JSON. See docs/imonikai-bootstrap.md.
//
// Built entirely on the tunnel primitives above (readTunnelState,
// provisionNamedTunnel, chooseQuickTunnel) — no separate tunnel-state
// implementation, so there is only ever one source of truth for a
// workspace's Cloudflare tunnel.

function defaultZoneFile(): string {
  return path.join(getStateDir(), "imonikai", "default-zone.json");
}

function readDefaultZone(): string | null {
  return readJsonIfExists<{ zone: string }>(defaultZoneFile())?.zone ?? null;
}

function writeDefaultZone(zone: string): void {
  writeSecureJson(defaultZoneFile(), { zone, savedAt: new Date().toISOString() });
}

/** The actual logic `imonikai init` runs to decide/apply the tunnel choice
 *  or a later Quick->Named upgrade — extracted (not mirrored) so tests can
 *  exercise this exact application-level path, including the
 *  `canUpgradeToNamed` branch, without needing to spawn the CLI as a
 *  subprocess. Never guesses a zone by stripping labels off `hostname` — a
 *  multi-label hostname (e.g. imonikai.c2c.example.com) would silently
 *  derive a non-apex "zone" (c2c.example.com), which Cloudflare's default
 *  Universal SSL certificate does not cover: DNS routing succeeds but TLS
 *  then fails with a bare handshake error (confirmed live, 2026-09-02 —
 *  see docs/troubleshooting.md). A zone must come from an explicit `zone`
 *  or an already-saved default; if neither is known, Named provisioning is
 *  simply skipped this run (falls through to/stays on Quick). */
export async function applyTunnelChoiceOrUpgrade(opts: {
  workspaceId: string;
  workspaceName: string;
  workspaceRoot: string;
  hostname?: string;
  zone?: string;
  setDefaultZone: boolean;
  /** Suppress the Cloudflare-login prompt message (JSON-mode callers, tests). */
  quiet?: boolean;
  /** Injected Cloudflare account adapter — defaults to the real
   *  ProcessCloudflaredAccount; tests pass a fake so this exact application
   *  path (used verbatim by `imonikai init`) never needs a real
   *  cloudflared/Cloudflare account to be exercised. */
  account?: CloudflaredAccount;
}): Promise<{ messages: string[] }> {
  const messages: string[] = [];
  const tunnelState = readTunnelState(opts.workspaceId);
  const zoneCandidate = (): string | null => parseZoneInput(opts.zone ?? "") ?? readDefaultZone();
  const restartBridgeIfLive = async (): Promise<void> => {
    if (await findLiveBridge(opts.workspaceId)) {
      await stopBridge(opts.workspaceRoot);
      // stopBridge fires /admin/shutdown without waiting for the process
      // to actually exit — give it a moment so the next ensureBridge
      // spawns fresh and picks up the new tunnel state instead of racing
      // the still-dying old bridge.
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  };

  // Only make the one-time tunnel choice once per workspace, and only
  // decide "named" when we have (or can derive) a zone — never guess a
  // domain. provisionNamedTunnel never throws: on any failure it records
  // "quick" with a fallback reason, same as a real user choice.
  if (needsTunnelChoice(tunnelState)) {
    const zone = zoneCandidate();
    if (zone) {
      if (!hasCloudflaredCert() && !opts.quiet) say(NAMED_LOGIN_PROMPT);
      const result = await provisionNamedTunnel({
        workspaceId: opts.workspaceId,
        workspaceName: opts.workspaceName,
        zone,
        hostname: opts.hostname,
        account: opts.account,
      });
      if (result.fallback) {
        messages.push(`Named Tunnel 未就绪，继续使用 Quick Tunnel：${result.error ?? result.userMessage ?? ""}`);
      } else {
        messages.push(`已创建固定域名：https://${result.state.hostname}`);
        if (opts.setDefaultZone) writeDefaultZone(zone);
      }
    } else {
      chooseQuickTunnel(opts.workspaceId);
    }
    await restartBridgeIfLive();
  } else if (canUpgradeToNamed(tunnelState)) {
    // A one-time "quick" choice was already made earlier, but a zone is
    // now available (or was passed this run) — try a safe upgrade to
    // Named without re-asking. A quick user who never supplies a zone
    // stays silently on Quick Tunnel forever, same as before; a failed
    // upgrade attempt never disrupts the already-working Quick Tunnel
    // bridge (provisionNamedTunnel itself never throws).
    const zone = zoneCandidate();
    if (zone) {
      if (!hasCloudflaredCert() && !opts.quiet) say(NAMED_LOGIN_PROMPT);
      const result = await provisionNamedTunnel({
        workspaceId: opts.workspaceId,
        workspaceName: opts.workspaceName,
        zone,
        hostname: opts.hostname,
        account: opts.account,
      });
      if (!result.fallback) {
        messages.push(`已升级为固定域名：https://${result.state.hostname}`);
        if (opts.setDefaultZone) writeDefaultZone(zone);
        await restartBridgeIfLive();
      }
    }
  }
  return { messages };
}

async function defaultBridgeRestart(root: string): Promise<{ runtime: RuntimeState; info: AdminInfo }> {
  await stopBridge(root);
  // stopBridge fires /admin/shutdown without waiting for the process to
  // actually exit — give it a moment so the next ensureBridge spawns
  // fresh and picks up the tunnel state instead of racing the still-dying
  // old bridge.
  await new Promise((resolve) => setTimeout(resolve, 400));
  const runtime = (await ensureBridge(root)).runtime;
  // ensureBridge only brings the local HTTP server up — the actual tunnel
  // (Named or Quick) is never started until this explicit call (see
  // ensureBridgeAndTunnel above, which does the same thing for the same
  // reason). Skipping it would leave `info.tunnel.provider` reporting
  // whatever tunnelForWorkspace() statically constructed at process
  // startup (e.g. "cloudflare-named" for a workspace whose persisted
  // preference is "named") even though `.start()` was never called on
  // it — provider would already look "correct" while running/publicUrl
  // stayed false/null. If BOTH Named and its Quick fallback fail here,
  // this throws (matching /admin/tunnel/start's own 500 contract) and
  // propagates to the caller, same as any other repair failure.
  await adminFetch<TunnelStartResponse>(runtime, "POST", "/admin/tunnel/start", 90_000);
  const info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
  return { runtime, info };
}

/** Recovers a workspace whose Named Tunnel is configured but whose bridge
 *  is currently running degraded on Quick (P2-2's runtime fallback,
 *  surfaced as `ImonikaiStatus.tunnel.namedFallbackActive`). Restarting
 *  the bridge constructs a fresh CloudflaredNamedTunnel and gives it
 *  another chance to connect — the earlier failure is often transient
 *  (DNS/cert propagation, a cloudflared hiccup). This is the exact repair
 *  `c2c doctor --fix` performs when it finds this state; extracted (not
 *  mirrored — `doctor`'s action calls this directly) so `namedFallbackActive`
 *  has a real, independently-testable repair action to route to instead of
 *  the (no-op in this exact state) `imonikai init` / `applyTunnelChoiceOrUpgrade`
 *  path — see docs/imonikai-bootstrap.md § Recovering from a Named fallback.
 *
 *  `restart` is injectable so tests can simulate the outcome without
 *  spawning a real `c2c serve` subprocess or needing a real
 *  cloudflared/Cloudflare account; defaults to the real
 *  stop-then-restart-the-daemon-and-start-the-tunnel sequence.
 *
 *  `repaired` requires `tunnel.provider === "cloudflare-named"` AND
 *  `tunnel.running` AND a non-null `tunnel.url` — the provider name alone
 *  is set as soon as the bridge process constructs its tunnel object
 *  (tunnelForWorkspace(), at startup, before `.start()` is ever called),
 *  so checking only the name would report "repaired" for a Named
 *  provider that was constructed but never actually connected. */
export async function attemptNamedFallbackRepair(
  root: string,
  restart: (root: string) => Promise<{ runtime: RuntimeState; info: AdminInfo }> = defaultBridgeRestart
): Promise<{ repaired: boolean; runtime: RuntimeState; info: AdminInfo }> {
  const { runtime, info } = await restart(root);
  const repaired = info.tunnel.provider === "cloudflare-named" && info.tunnel.running && info.tunnel.url !== null;
  return { repaired, runtime, info };
}

export interface ImonikaiStatus {
  ok: true;
  workspaceId: string;
  workspaceName: string;
  isNewWorkspace: boolean;
  bridge: { running: boolean; port: number | null };
  tunnel: {
    mode: "named" | "quick" | "none";
    url: string | null;
    /** "configured" only — a hostname/tunnel name is on record. This does
     *  NOT mean it currently resolves, has a valid TLS cert, or answers
     *  requests (see `reachable`). Kept distinct on purpose: a broken
     *  hostname must not read as "ready" — see docs/troubleshooting.md's
     *  zone-apex warning for a real, confirmed way this goes wrong. */
    permanentUrlConfigured: boolean;
    hostname: string | null;
    /** null = not checked (no URL to check, or bridge unreachable so no
     *  check was attempted this call); true/false = the result of an
     *  actual `GET {url}/health` just now. */
    reachable: boolean | null;
    /** True when the persisted preference is Named (`permanentUrlConfigured`)
     *  but the tunnel actually running right now is Quick — the Named
     *  Tunnel failed to start and this run degraded to Quick (see
     *  server.ts's P2-2 runtime fallback). `mode` already reflects the
     *  live "quick" reality; this flag exists so a caller can specifically
     *  detect "configured Named is broken" rather than just "currently on
     *  Quick" (which is also the normal state for a workspace that simply
     *  never configured Named at all). Also forces `needsInit: true` below
     *  — a Skill must not treat this as a healthy, completed setup. */
    namedFallbackActive: boolean;
  };
  connector: { name: string | null; mcpUrl: string | null; authorized: boolean };
  aiContext: { exists: boolean; path: string };
  chatgptPolicy: { chatgptSurface: string; rejectWorkSuggestion: boolean };
  needsInit: boolean;
}

export async function imonikaiStatus(root: string): Promise<ImonikaiStatus> {
  const workspace = new Workspace(root);
  const lastEndpoint = readLastEndpoint(workspace.id);
  const tunnelState = readTunnelState(workspace.id);
  const namedReady = isNamedTunnelReady(tunnelState);
  const isNewWorkspace = !lastEndpoint && needsTunnelChoice(tunnelState) && !workspace.aiContextInfo().exists;

  const runtime = await findLiveBridge(workspace.id);
  let bridgeRunning = false;
  let port: number | null = null;
  let tunnelUrl: string | null = null;
  let mcpUrl: string | null = lastEndpoint?.mcpUrl ?? null;
  let authorized = false;
  // What actually answered `/admin/info` just now (info.tunnel.provider —
  // "cloudflare-named" / "cloudflare-quick"), when the bridge is reachable.
  // Distinct from `namedReady` (persisted preference): a Named Tunnel that
  // fails to start falls back to a live Quick Tunnel for that run (see
  // server.ts's P2-2 fallback) WITHOUT changing the persisted preference —
  // so `namedReady` alone cannot tell a real Named connection apart from
  // "configured Named, but actually running degraded on Quick right now".
  // Null only when there is no live answer to ask at all.
  let liveProvider: string | null = null;

  let reachable: boolean | null = null;
  if (runtime) {
    bridgeRunning = true;
    port = runtime.port;
    try {
      const info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
      tunnelUrl = info.publicUrl ?? info.tunnel.url ?? null;
      liveProvider = info.tunnel.provider;
      if (tunnelUrl) mcpUrl = mcpUrlFromPublic(tunnelUrl);
      // hasUsableAuthorization re-checks expiry live, unlike a raw token
      // count — a token can be valid at bridge start and silently expire
      // while the process keeps running (see AuthStore.hasUsableAuthorization).
      authorized = info.hasUsableAuthorization;
      if (tunnelUrl) {
        try {
          const response = await fetch(`${tunnelUrl}/health`, { signal: AbortSignal.timeout(8000) });
          reachable = response.ok;
        } catch {
          reachable = false;
        }
      }
    } catch {
      // Bridge process exists but did not answer in time — report what we
      // already know from disk rather than failing the whole status call.
    }
  }

  // Prefer the live answer whenever we have one — it reflects what is
  // ACTUALLY running right now, including a Named->Quick runtime fallback.
  // Only fall back to guessing from persisted state when the bridge itself
  // couldn't be reached at all (nothing live to ask).
  const mode: "named" | "quick" | "none" =
    liveProvider === "cloudflare-named"
      ? "named"
      : liveProvider === "cloudflare-quick"
        ? "quick"
        : namedReady
          ? "named"
          : tunnelUrl
            ? "quick"
            : "none";
  const namedFallbackActive = namedReady && liveProvider === "cloudflare-quick";

  return {
    ok: true,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    isNewWorkspace,
    bridge: { running: bridgeRunning, port },
    tunnel: {
      mode,
      url: tunnelUrl,
      permanentUrlConfigured: namedReady,
      hostname: tunnelState.hostname ?? null,
      reachable,
      namedFallbackActive,
    },
    connector: {
      name: lastEndpoint?.connectorName ?? null,
      mcpUrl,
      authorized,
    },
    aiContext: workspace.aiContextInfo(),
    chatgptPolicy: workspace.chatgptPolicy,
    needsInit: !authorized || namedFallbackActive,
  };
}

const imonikai = program.command("imonikai").description('Shared "芋煮会" auto-bootstrap — see docs/imonikai-bootstrap.md');

imonikai
  .command("status")
  .description("One consolidated check: is this workspace ready for 芋煮会, or does it need init?")
  .option("-w, --workspace <path>")
  .option("--agent <agent>", "calling coding agent: codex | claude-code (accepted for CLI-contract consistency with imonikai init; status itself is agent-agnostic)")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; agent?: string; json: boolean }) => {
    try {
      parseAgent(opts.agent);
      const status = await imonikaiStatus(resolveWorkspace(opts.workspace));
      if (opts.json) {
        say(JSON.stringify(status));
        return;
      }
      say(status.needsInit ? "需要执行 c2c imonikai init。" : "已就绪，可直接开始任务。");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

imonikai
  .command("init")
  .description("Zero-touch bootstrap: bridge + tunnel (named if a zone is known) + connector name + pairing code")
  .option("-w, --workspace <path>")
  .option("--agent <agent>", "calling coding agent: codex | claude-code")
  .option("--hostname <hostname>", "explicit full hostname for the named tunnel (agent-proposed, e.g. imonikai.c2c.example.com)")
  .option("--zone <domain>", "Cloudflare domain to derive <slug>.<zone> from, if --hostname is not given")
  .option("--set-default-zone", "remember --zone as the default for future new workspaces", false)
  .option("--json", "machine-readable output", false)
  .action(
    async (opts: {
      workspace?: string;
      agent?: string;
      hostname?: string;
      zone?: string;
      setDefaultZone: boolean;
      json: boolean;
    }) => {
      const root = resolveWorkspace(opts.workspace);
      const results: string[] = [];
      try {
        const agent = parseAgent(opts.agent);
        trySandboxAllow(agent);

        const workspace = new Workspace(root);
        const { messages: tunnelMessages } = await applyTunnelChoiceOrUpgrade({
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          workspaceRoot: root,
          hostname: opts.hostname,
          zone: opts.zone,
          setDefaultZone: opts.setDefaultZone,
          quiet: opts.json,
        });
        results.push(...tunnelMessages);

        const previous = readLastEndpoint(workspace.id);
        const { runtime, info, mcpUrl } = await ensureBridgeAndTunnel(root, { tunnel: true });
        const connectorName = mcpUrl
          ? persistWorkspaceEndpoint({
              workspaceId: info.workspaceId,
              workspaceName: info.workspaceName,
              port: runtime.port,
              publicUrl: info.publicUrl,
              mcpUrl,
              previous,
            })
          : connectorNameFor({
              workspaceName: info.workspaceName,
              workspaceId: info.workspaceId,
              previousName: previous?.connectorName,
              hadEndpointBefore: Boolean(previous),
            });

        const pairing = await adminFetch<PairingResponse>(runtime, "POST", "/admin/pairing");
        const status = await imonikaiStatus(root);

        if (opts.json) {
          say(
            JSON.stringify({
              ...status,
              connectorName,
              mcpUrl,
              permanentUrlConfigured: status.tunnel.permanentUrlConfigured,
              pairingCode: pairing.code,
              pairingExpiresAt: pairing.expiresAt,
              repairs: results,
            })
          );
          return;
        }
        for (const line of results) say(line);
        check(`连接器：${connectorName}`);
        check(`配对码：${pairing.code}`);
      } catch (error) {
        handleCliError(error, opts.json);
      }
    }
  );

function handleCliError(error: unknown, json: boolean): void {
  const message = error instanceof Error ? error.message : String(error);
  if (json) {
    say(JSON.stringify({ ok: false, error: message }));
  } else if (message.startsWith("NEED_CLOUDFLARED")) {
    say("需要你完成一步：");
    say("");
    say("尚未安装安全连接组件 cloudflared。");
    say("macOS 用户可运行：brew install cloudflared");
    say("完成后再试一次即可。");
  } else {
    cross(message);
  }
  process.exitCode = 1;
}

/** Actually runs the CLI (parses `argv` and dispatches to a command). This
 *  module itself has NO top-level auto-execution — importing it (as tests
 *  do, to call imonikaiStatus/applyTunnelChoiceOrUpgrade directly, the
 *  real functions the CLI actions use, not a mirror) never runs a real CLI
 *  parse of the caller's own argv. The one real entry point is
 *  `src/cli/run.ts`, which unconditionally calls this — see its own
 *  comment for why "is this the main module?" guessing was dropped
 *  instead of fixed: it silently broke the published dist/npm path.
 *  Uses `process.exitCode` rather than `process.exit()` so this stays
 *  safe to call from a long-lived process (a test runner) too. */
export async function runCli(argv: string[] = process.argv): Promise<void> {
  try {
    await program.parseAsync(argv);
  } catch (error) {
    cross((error as Error).message);
    process.exitCode = 1;
  }
}
