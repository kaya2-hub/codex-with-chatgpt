import express, { type Request, type Response, type NextFunction } from "express";
import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import { Workspace } from "../workspace/manager.js";
import { AuthStore } from "../auth/store.js";
import { createOAuthRouter } from "../auth/oauth.js";
import { bearerAuth } from "../auth/middleware.js";
import { PairingManager } from "../pairing/manager.js";
import { createMcpServer } from "../mcp/server.js";
import { createMcpHttpHandler } from "../mcp/http.js";
import { CloudflaredQuickTunnel } from "../tunnel/cloudflared.js";
import { CloudflaredNamedTunnel } from "../tunnel/cloudflared-named.js";
import type { TunnelProvider } from "../tunnel/provider.js";
import { namedTunnelBinding, readTunnelState } from "../tunnel/state.js";
import { Logger, nullLogger } from "../logger/index.js";
import { DEFAULT_HOST, DEFAULT_PORT } from "../config/paths.js";
import { SERVICE_NAME, VERSION } from "../version.js";
import { writeRuntimeState, clearRuntimeState, type RuntimeState } from "./runtime.js";
import { recordConnectorConfirmation } from "../config/connectorConfirmation.js";
import { normalizePublicUrl } from "../config/endpoint.js";

function tunnelForWorkspace(workspaceId: string, logger: Logger): TunnelProvider {
  const binding = namedTunnelBinding(readTunnelState(workspaceId));
  if (binding) {
    return new CloudflaredNamedTunnel({
      tunnelName: binding.tunnelName,
      hostname: binding.hostname,
      logger,
    });
  }
  return new CloudflaredQuickTunnel(logger);
}

export interface BridgeOptions {
  workspaceRoot: string;
  port?: number;
  host?: string;
  logger?: Logger;
  tunnelProvider?: TunnelProvider;
  /** Constructs the Quick Tunnel fallback used when a Named Tunnel fails to
   *  start (see /admin/tunnel/start). Defaults to a real
   *  `CloudflaredQuickTunnel`; tests inject a fake so the fallback path is
   *  exercised without spawning a real cloudflared process. */
  quickFallbackProvider?: (logger: Logger) => TunnelProvider;
  /** Persist runtime state file (disable in tests). */
  persistRuntime?: boolean;
  authStoreFile?: string;
  pairingTtlMs?: number;
  accessTokenTtlMs?: number;
}

export interface Bridge {
  workspace: Workspace;
  port: number;
  host: string;
  adminToken: string;
  authStore: AuthStore;
  pairing: PairingManager;
  tunnel: TunnelProvider;
  getPublicBaseUrl(): string | null;
  localBaseUrl(): string;
  close(): Promise<void>;
}

/**
 * Listen on the preferred port; on EADDRINUSE fall back to an ephemeral port.
 */
function listen(app: express.Express, host: string, preferredPort: number): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const tryListen = (port: number, allowFallback: boolean): void => {
      const server = app.listen(port, host);
      server.once("listening", () => {
        const address = server.address();
        const actual = typeof address === "object" && address ? address.port : port;
        resolve({ server, port: actual });
      });
      server.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE" && allowFallback) {
          tryListen(0, false);
        } else {
          reject(error);
        }
      });
    };
    tryListen(preferredPort, preferredPort !== 0);
  });
}

export async function startBridge(opts: BridgeOptions): Promise<Bridge> {
  const logger = opts.logger ?? nullLogger;
  const workspace = new Workspace(opts.workspaceRoot);
  const host = opts.host ?? DEFAULT_HOST;
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error("The bridge only binds to loopback addresses. Public exposure goes through the tunnel.");
  }

  const authStore = new AuthStore(workspace.id, { file: opts.authStoreFile });
  const pairing = new PairingManager(workspace.id, { ttlMs: opts.pairingTtlMs });
  // Mutable: a Named Tunnel that fails to start falls back to a Quick
  // Tunnel for this run (see /admin/tunnel/start) without losing the
  // workspace's persisted `named` preference.
  let activeTunnel = opts.tunnelProvider ?? tunnelForWorkspace(workspace.id, logger);
  const adminToken = `c2c_admin_${randomBytes(24).toString("base64url")}`;
  // Fresh per process start, never reused -- see RuntimeState.generation's
  // doc comment for what this is (and isn't) for.
  const generation = randomBytes(9).toString("base64url");

  let publicBaseUrl: string | null = null;

  const app = express();
  app.set("trust proxy", true);
  app.disable("x-powered-by");

  const getBaseUrl = (req: Request): string => {
    if (publicBaseUrl) return publicBaseUrl;
    const proto = req.protocol;
    const hostHeader = req.get("host") ?? `${host}:${port}`;
    return `${proto}://${hostHeader}`;
  };

  // ---- Health (public but minimal) ---------------------------------------

  app.get("/health", (_req, res) => {
    res.json({ service: SERVICE_NAME, version: VERSION, workspaceId: workspace.id, status: "ok", generation });
  });

  // ---- OAuth + discovery ---------------------------------------------------

  app.use(
    createOAuthRouter({
      store: authStore,
      pairing,
      workspaceName: workspace.name,
      getBaseUrl,
      logger,
      onAuthorizationCodeExchanged: (requestOrigin: string) => {
        // Only record a confirmation when the token request's OWN observed
        // origin matches what we currently believe the public URL to be —
        // never just because a public URL happens to be configured. A
        // request that arrived over loopback (local admin/CLI calls,
        // tests hitting bridge.localBaseUrl()) must not be able to confirm
        // the public tunnel URL; that was the exact bug this fixes (an
        // old, unrelated token/URL combination getting silently treated
        // as proof the CURRENT desired URL is reachable).
        if (publicBaseUrl && normalizePublicUrl(requestOrigin) === normalizePublicUrl(publicBaseUrl)) {
          recordConnectorConfirmation(workspace.id, `${publicBaseUrl}/mcp`);
        }
      },
    })
  );

  // ---- MCP endpoint (bearer-protected) --------------------------------------

  const mcpHandler = createMcpHttpHandler(() => createMcpServer({ workspace, logger }), logger);
  app.all(
    "/mcp",
    express.json({ limit: "8mb" }),
    bearerAuth({ store: authStore, workspaceId: workspace.id, getBaseUrl, logger }),
    (req: Request, res: Response) => {
      void mcpHandler(req, res);
    }
  );

  // ---- Admin API (loopback + admin token only; used by the CLI/Skill) --------

  const adminGuard = (req: Request, res: Response, next: NextFunction): void => {
    // Defense in depth: reject anything that arrived through a proxy/tunnel.
    const remote = req.socket.remoteAddress ?? "";
    const isLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    const viaProxy = Boolean(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"]);
    const header = req.headers.authorization ?? "";
    const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    if (!isLoopback || viaProxy || token !== adminToken) {
      res.status(404).end(); // do not advertise the admin surface
      return;
    }
    next();
  };

  app.post("/admin/pairing", adminGuard, (_req, res) => {
    const session = pairing.create();
    logger.info("Created pairing session");
    res.json({ code: session.code, expiresAt: session.expiresAt });
  });

  // ---- Self-test token (doctor's real bearerAuth + /mcp round trip, P0-3) ----
  // Loopback + admin token only, same as every other /admin/* route -- never
  // reachable through the tunnel. Least privilege (workspace.read only) and
  // 60s TTL are enforced inside AuthStore.issueSelfTestToken, not here.

  app.post("/admin/self-test-token", adminGuard, (_req, res) => {
    const { token, expiresAt } = authStore.issueSelfTestToken();
    res.json({ token, expiresAt });
  });

  app.post("/admin/self-test-token/revoke", adminGuard, express.json(), (req: Request, res: Response) => {
    const token = typeof req.body?.token === "string" ? req.body.token : "";
    const revoked = token !== "" && authStore.revokeToken(token);
    res.json({ revoked });
  });

  app.get("/admin/info", adminGuard, (_req, res) => {
    res.json({
      service: SERVICE_NAME,
      version: VERSION,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspaceRoot: workspace.root,
      port,
      publicUrl: publicBaseUrl,
      tunnel: activeTunnel.status(),
      tokenCount: authStore.tokenCount(),
      hasUsableAuthorization: authStore.hasUsableAuthorization(),
      pairingActive: pairing.hasActiveSession(),
      pid: process.pid,
      startedAt,
    });
  });

  app.post("/admin/tunnel/start", adminGuard, (_req, res) => {
    const startedProvider = activeTunnel;
    startedProvider
      .start(port)
      .then((url) => {
        publicBaseUrl = url;
        persistRuntime();
        res.json({ url });
      })
      .catch((error: Error) => {
        logger.error(`Tunnel start failed: ${error.message}`);
        // The doc/Skill promise is: 芋煮会 always gets at least a working
        // Quick Tunnel. A Named Tunnel that fails to start (dead
        // credentials, DNS not yet propagated, cloudflared edge hiccup —
        // see docs/troubleshooting.md) must not leave the workspace with no
        // usable connection at all. Only this one run falls back; the
        // workspace's persisted `named` preference is untouched, so the
        // next start attempt (or `c2c doctor --fix`) tries Named again.
        if (startedProvider.name !== "cloudflare-named") {
          res.status(500).json({ error: "tunnel_failed", message: error.message });
          return;
        }
        logger.warn("Named tunnel failed to start; falling back to a Quick Tunnel for this run.");
        const quick = (opts.quickFallbackProvider ?? ((l: Logger) => new CloudflaredQuickTunnel(l)))(logger);
        quick
          .start(port)
          .then((url) => {
            activeTunnel = quick;
            publicBaseUrl = url;
            persistRuntime();
            res.json({ url, fallback: true, namedError: error.message });
          })
          .catch((fallbackError: Error) => {
            logger.error(`Quick Tunnel fallback also failed: ${fallbackError.message}`);
            res.status(500).json({ error: "tunnel_failed", message: error.message });
          });
      });
  });

  app.post("/admin/tunnel/stop", adminGuard, (_req, res) => {
    void activeTunnel.stop().then(() => {
      publicBaseUrl = null;
      persistRuntime();
      res.json({ stopped: true });
    });
  });

  app.post("/admin/revoke-all", adminGuard, (_req, res) => {
    const count = authStore.revokeAll();
    pairing.invalidateAll();
    logger.info(`Revoked all tokens (${count})`);
    res.json({ revoked: count });
  });

  app.post("/admin/shutdown", adminGuard, (_req, res) => {
    res.json({ shuttingDown: true });
    setTimeout(() => {
      void shutdown().then(() => process.exit(0));
    }, 100);
  });

  const { server, port } = await listen(app, host, opts.port ?? DEFAULT_PORT);
  const startedAt = new Date().toISOString();
  logger.info(`Bridge listening on ${host}:${port} for workspace ${workspace.name} (${workspace.id})`);

  const persistRuntime = (): void => {
    if (opts.persistRuntime === false) return;
    const state: RuntimeState = {
      service: SERVICE_NAME,
      version: VERSION,
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      pid: process.pid,
      port,
      adminToken,
      publicUrl: publicBaseUrl,
      startedAt,
      generation,
    };
    writeRuntimeState(state);
  };
  persistRuntime();

  let closed = false;
  const shutdown = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await activeTunnel.stop().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (opts.persistRuntime !== false) clearRuntimeState(workspace.id);
    logger.info("Bridge stopped");
  };

  return {
    workspace,
    port,
    host,
    adminToken,
    authStore,
    pairing,
    get tunnel() {
      return activeTunnel;
    },
    getPublicBaseUrl: () => publicBaseUrl,
    localBaseUrl: () => `http://${host}:${port}`,
    close: shutdown,
  };
}
