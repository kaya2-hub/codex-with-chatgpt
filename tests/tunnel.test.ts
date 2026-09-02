import { describe, it, expect, afterEach } from "vitest";
import { parseQuickTunnelUrl } from "../src/tunnel/cloudflared.js";
import { normalizeNamedTunnelHostname } from "../src/tunnel/cloudflared-named.js";
import { hostnameSlug, parseZoneInput, suggestedNamedHostname } from "../src/tunnel/hostname.js";
import {
  buildRouteDnsArgs,
  chooseQuickTunnel,
  decideTunnelReuse,
  parseCreatedTunnel,
  parseTunnelList,
  provisionNamedTunnel,
  type CloudflaredAccount,
  type ListedTunnel,
} from "../src/tunnel/named-provision.js";
import { canUpgradeToNamed, isNamedTunnelReady, needsTunnelChoice, readTunnelState } from "../src/tunnel/state.js";
import { applyTunnelChoiceOrUpgrade } from "../src/cli/index.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

const stateDirs: string[] = [];
const workspaceDirs: string[] = [];
const previousStateDir = process.env.C2C_STATE_DIR;

afterEach(() => {
  while (stateDirs.length) cleanup(stateDirs.pop()!);
  while (workspaceDirs.length) cleanup(workspaceDirs.pop()!);
  if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = previousStateDir;
});

describe("parseQuickTunnelUrl", () => {
  it("extracts the URL from cloudflared banner output", () => {
    const line =
      "2026-08-28T10:00:00Z INF |  https://random-words-here-1234.trycloudflare.com                              |";
    expect(parseQuickTunnelUrl(line)).toBe("https://random-words-here-1234.trycloudflare.com");
  });

  it("ignores unrelated lines", () => {
    expect(parseQuickTunnelUrl("INF Starting tunnel connection")).toBeNull();
    expect(parseQuickTunnelUrl("visit https://www.cloudflare.com for docs")).toBeNull();
  });

  it("does not match non-trycloudflare hosts", () => {
    expect(parseQuickTunnelUrl("https://evil.example.com/trycloudflare.com")).toBeNull();
  });
});

describe("normalizeNamedTunnelHostname", () => {
  it("normalizes a valid hostname", () => {
    expect(normalizeNamedTunnelHostname("Dev.GetRemi.xyz.")).toBe("dev.getremi.xyz");
  });

  it("rejects URLs and invalid hostnames", () => {
    expect(() => normalizeNamedTunnelHostname("https://dev.getremi.xyz")).toThrow(/invalid/i);
    expect(() => normalizeNamedTunnelHostname("localhost")).toThrow(/invalid/i);
  });
});

describe("named hostname helpers", () => {
  it("builds a stable c2c-<project>.<zone> hostname", () => {
    expect(suggestedNamedHostname("Example.COM", "My App", "abcdef123456")).toBe("c2c-my-app.example.com");
  });

  it("falls back to the workspace id when the name is not ASCII", () => {
    expect(hostnameSlug("回声", "abcdef123456")).toBe("c2c-ws-abcdef12");
  });

  it("parses a typed domain", () => {
    expect(parseZoneInput("https://Example.com/")).toBe("example.com");
    expect(parseZoneInput("not a domain")).toBeNull();
  });
});

describe("cloudflared output parsers", () => {
  it("reads a tunnel list table", () => {
    const output = `
ID                                   NAME          CREATED
11111111-1111-1111-1111-111111111111 c2c-abc123    2026-08-30
`;
    expect(parseTunnelList(output)).toEqual([
      { id: "11111111-1111-1111-1111-111111111111", name: "c2c-abc123" },
    ]);
  });

  it("reads created-tunnel output", () => {
    expect(
      parseCreatedTunnel(
        "Created tunnel c2c-abc with id 22222222-2222-2222-2222-222222222222",
        "c2c-abc"
      )
    ).toEqual({ id: "22222222-2222-2222-2222-222222222222", name: "c2c-abc" });
  });

  it("flags a tunnel with active edge connections from the JSON list output", () => {
    const output = JSON.stringify([
      {
        id: "11111111-1111-1111-1111-111111111111",
        name: "c2c-abc123",
        connections: [{ colo_name: "kix03", id: "conn-1" }],
      },
      {
        id: "22222222-2222-2222-2222-222222222222",
        name: "c2c-def456",
        connections: [],
      },
    ]);
    expect(parseTunnelList(output)).toEqual([
      { id: "11111111-1111-1111-1111-111111111111", name: "c2c-abc123", hasActiveConnections: true },
      { id: "22222222-2222-2222-2222-222222222222", name: "c2c-def456", hasActiveConnections: false },
    ]);
  });
});

describe("buildRouteDnsArgs", () => {
  it("places --overwrite-dns BEFORE the positional tunnel/hostname args", () => {
    // cloudflared 2026.8.2 rejects the flag placed after positionals for
    // this specific subcommand (verified live — see the doc comment on
    // buildRouteDnsArgs). Regression test for that exact bug.
    expect(buildRouteDnsArgs("c2c-abc", "host.example.com", true)).toEqual([
      "tunnel",
      "route",
      "dns",
      "--overwrite-dns",
      "c2c-abc",
      "host.example.com",
    ]);
  });

  it("omits the flag entirely when not overwriting", () => {
    expect(buildRouteDnsArgs("c2c-abc", "host.example.com", false)).toEqual([
      "tunnel",
      "route",
      "dns",
      "c2c-abc",
      "host.example.com",
    ]);
  });
});

describe("local tunnel credentials", () => {
  it("reports no credentials for an id that has none on this machine", async () => {
    const { hasLocalTunnelCredentials } = await import("../src/tunnel/named-provision.js");
    expect(hasLocalTunnelCredentials("99999999-9999-9999-9999-999999999999")).toBe(false);
  });
});

describe("decideTunnelReuse", () => {
  const tunnel: ListedTunnel = { id: "11111111-1111-1111-1111-111111111111", name: "c2c-abc123" };

  it("reuses a tunnel that already has local credentials, regardless of connection state, depth, or ownership record", () => {
    expect(decideTunnelReuse({ ...tunnel, hasActiveConnections: true }, true, 0, null)).toEqual({ action: "reuse" });
    expect(decideTunnelReuse({ ...tunnel, hasActiveConnections: false }, true, 1, "some-other-id")).toEqual({
      action: "reuse",
    });
  });

  it("recreates a tunnel with no local credentials that is confirmed inactive AND matches this machine's ownership record", () => {
    expect(decideTunnelReuse({ ...tunnel, hasActiveConnections: false }, false, 0, tunnel.id)).toEqual({
      action: "recreate",
    });
  });

  it("refuses to delete a tunnel with confirmed active connections", () => {
    const decision = decideTunnelReuse({ ...tunnel, hasActiveConnections: true }, false, 0, tunnel.id);
    expect(decision.action).toBe("refuse");
    if (decision.action === "refuse") expect(decision.reason).toMatch(/active connections/i);
  });

  it("refuses to delete a tunnel whose connection state is unknown (table-fallback parser)", () => {
    const decision = decideTunnelReuse({ ...tunnel, hasActiveConnections: undefined }, false, 0, tunnel.id);
    expect(decision.action).toBe("refuse");
    if (decision.action === "refuse") expect(decision.reason).toMatch(/could not be determined/i);
  });

  it("refuses to steal back a tunnel a concurrent process just created, even if confirmed inactive", () => {
    const decision = decideTunnelReuse({ ...tunnel, hasActiveConnections: false }, false, 1, tunnel.id);
    expect(decision.action).toBe("refuse");
    if (decision.action === "refuse") expect(decision.reason).toMatch(/different process/i);
  });

  it("refuses to delete an inactive, credential-less tunnel this machine has no ownership record of at all", () => {
    const decision = decideTunnelReuse({ ...tunnel, hasActiveConnections: false }, false, 0, null);
    expect(decision.action).toBe("refuse");
    if (decision.action === "refuse") expect(decision.reason).toMatch(/no record of having created it/i);
  });

  it("refuses to delete an inactive, credential-less tunnel whose id doesn't match this machine's last-known id", () => {
    // Same NAME (c2c-<workspaceId> collides across machines by design —
    // workspaceId is a path hash, not a per-machine id) but a different
    // tunnel object than the one this machine remembers creating.
    const decision = decideTunnelReuse(
      { ...tunnel, hasActiveConnections: false },
      false,
      0,
      "99999999-9999-9999-9999-999999999999"
    );
    expect(decision.action).toBe("refuse");
    if (decision.action === "refuse") expect(decision.reason).toMatch(/no record of having created it/i);
  });
});

describe("tunnel preference state", () => {
  it("asks once, then remembers a quick choice", () => {
    stateDirs.push(isolateStateDir());
    const unset = readTunnelState("ws1");
    expect(needsTunnelChoice(unset)).toBe(true);
    const saved = chooseQuickTunnel("ws1");
    expect(saved.preference).toBe("quick");
    expect(needsTunnelChoice(readTunnelState("ws1"))).toBe(false);
    expect(isNamedTunnelReady(saved)).toBe(false);
  });

  it("provisions a named hostname through the account adapter and stores it outside the project", () => {
    stateDirs.push(isolateStateDir());
    const account: CloudflaredAccount = {
      hasCert: () => true,
      login: async () => undefined,
      listTunnels: async () => [],
      createTunnel: async (name) => ({ id: "33333333-3333-3333-3333-333333333333", name }),
      deleteTunnel: async () => undefined,
      routeDns: async () => undefined,
    };
    return provisionNamedTunnel({
      workspaceId: "abcdef123456",
      workspaceName: "Demo",
      zone: "example.com",
      account,
    }).then((result) => {
      expect(result.fallback).toBe(false);
      expect(result.state.preference).toBe("named");
      expect(result.state.hostname).toBe("c2c-demo.example.com");
      expect(result.state.tunnelName).toBe("c2c-abcdef123456");
      expect(isNamedTunnelReady(readTunnelState("abcdef123456"))).toBe(true);
    });
  });

  it("falls back to a temporary address when named provisioning fails", () => {
    stateDirs.push(isolateStateDir());
    const account: CloudflaredAccount = {
      hasCert: () => true,
      login: async () => undefined,
      listTunnels: async () => [],
      createTunnel: async () => {
        throw new Error("no zone");
      },
      deleteTunnel: async () => undefined,
      routeDns: async () => undefined,
    };
    return provisionNamedTunnel({
      workspaceId: "ws2",
      workspaceName: "Demo",
      zone: "example.com",
      account,
    }).then((result) => {
      expect(result.fallback).toBe(true);
      expect(result.state.preference).toBe("quick");
      expect(result.userMessage).toMatch(/临时地址/);
    });
  });

  it("refuses an explicit --hostname that is not exactly one label under --zone, even though a zone WAS given", () => {
    // isHostnameDirectlyUnderZone is the safety net for the case ChatGPT's
    // review flagged: an agent (or user) can still pass --hostname AND
    // --zone explicitly together, e.g. --hostname imonikai.c2c.example.com
    // --zone example.com — the zone itself isn't guessed here, but the
    // hostname is still the confirmed-failing shape and must be refused.
    stateDirs.push(isolateStateDir());
    let createTunnelCalled = false;
    const account: CloudflaredAccount = {
      hasCert: () => true,
      login: async () => undefined,
      listTunnels: async () => [],
      createTunnel: async (name) => {
        createTunnelCalled = true;
        return { id: "88888888-8888-8888-8888-888888888888", name };
      },
      deleteTunnel: async () => undefined,
      routeDns: async () => undefined,
    };
    return provisionNamedTunnel({
      workspaceId: "ws-deep-hostname",
      workspaceName: "Demo",
      zone: "example.com",
      hostname: "imonikai.c2c.example.com",
      account,
    }).then((result) => {
      expect(result.fallback).toBe(true);
      expect(result.state.preference).toBe("quick");
      expect(result.error).toMatch(/not exactly one label/i);
      // Must refuse before ever touching the Cloudflare account — this is
      // a design-time validation, not a failed API call.
      expect(createTunnelCalled).toBe(false);
    });
  });

  it("accepts an explicit --hostname that IS exactly one label under --zone", () => {
    stateDirs.push(isolateStateDir());
    const account: CloudflaredAccount = {
      hasCert: () => true,
      login: async () => undefined,
      listTunnels: async () => [],
      createTunnel: async (name) => ({ id: "99999999-8888-8888-8888-888888888888", name }),
      deleteTunnel: async () => undefined,
      routeDns: async () => undefined,
    };
    return provisionNamedTunnel({
      workspaceId: "ws-ok-hostname",
      workspaceName: "Demo",
      zone: "example.com",
      hostname: "imonikai.example.com",
      account,
    }).then((result) => {
      expect(result.fallback).toBe(false);
      expect(result.state.hostname).toBe("imonikai.example.com");
    });
  });

  it("overwrites the DNS route only when the tunnel it points at was just recreated", () => {
    stateDirs.push(isolateStateDir());
    const routeDnsCalls: Array<{ tunnelName: string; hostname: string; overwrite?: boolean }> = [];
    const account: CloudflaredAccount = {
      hasCert: () => true,
      login: async () => undefined,
      listTunnels: async () => [],
      // Simulate ensureRunnable's self-heal path: an existing tunnel with
      // no local credentials gets deleted and recreated under a new UUID.
      createTunnel: async (name) => ({
        id: "44444444-4444-4444-4444-444444444444",
        name,
        recreated: true,
      }),
      deleteTunnel: async () => undefined,
      routeDns: async (tunnelName, hostname, opts) => {
        routeDnsCalls.push({ tunnelName, hostname, overwrite: opts?.overwrite });
      },
    };
    return provisionNamedTunnel({
      workspaceId: "ws3",
      workspaceName: "Demo",
      zone: "example.com",
      account,
    }).then((result) => {
      expect(result.fallback).toBe(false);
      expect(routeDnsCalls).toEqual([
        { tunnelName: "c2c-ws3", hostname: "c2c-demo.example.com", overwrite: true },
      ]);
    });
  });

  it("never overwrites the DNS route for a tunnel that was reused as-is", () => {
    stateDirs.push(isolateStateDir());
    const routeDnsCalls: Array<{ overwrite?: boolean }> = [];
    const account: CloudflaredAccount = {
      hasCert: () => true,
      login: async () => undefined,
      listTunnels: async () => [],
      createTunnel: async (name) => ({ id: "55555555-5555-5555-5555-555555555555", name }),
      deleteTunnel: async () => undefined,
      routeDns: async (_tunnelName, _hostname, opts) => {
        routeDnsCalls.push({ overwrite: opts?.overwrite });
      },
    };
    return provisionNamedTunnel({
      workspaceId: "ws4",
      workspaceName: "Demo",
      zone: "example.com",
      account,
    }).then(() => {
      expect(routeDnsCalls).toEqual([{ overwrite: false }]);
    });
  });

  it("falls back to Quick rather than silently accepting a DNS conflict (P1-4)", () => {
    // A real cloudflared account.routeDns() rejects a genuine conflicting
    // record with a non-zero exit even though the message contains
    // "already exists" — it does its own idempotent target check and only
    // exits 0 when the existing record already points at THIS tunnel (see
    // buildRouteDnsArgs's doc comment). This mock reproduces the reject
    // case; provisionNamedTunnel must treat it as a real failure, not
    // silently proceed as if the hostname were correctly routed.
    stateDirs.push(isolateStateDir());
    const account: CloudflaredAccount = {
      hasCert: () => true,
      login: async () => undefined,
      listTunnels: async () => [],
      createTunnel: async (name) => ({ id: "77777777-7777-7777-7777-777777777777", name }),
      deleteTunnel: async () => undefined,
      routeDns: async () => {
        throw new Error("Failed to add route: record already exists with a different target");
      },
    };
    return provisionNamedTunnel({
      workspaceId: "ws5",
      workspaceName: "Demo",
      zone: "example.com",
      account,
    }).then((result) => {
      expect(result.fallback).toBe(true);
      expect(result.state.preference).toBe("quick");
      expect(result.error).toMatch(/already exists/i);
    });
  });
});

describe("Quick -> Named upgrade eligibility (decoupled from the one-time tunnel choice)", () => {
  it("a workspace that already chose quick stops needing the one-time choice, but stays upgrade-eligible", () => {
    stateDirs.push(isolateStateDir());
    const afterChoice = chooseQuickTunnel("ws-upgrade-1");
    expect(needsTunnelChoice(afterChoice)).toBe(false);
    expect(canUpgradeToNamed(afterChoice)).toBe(true);
  });

  it("reproduces the full state transition: quick chosen -> re-run init -> zone now known -> upgraded to named", async () => {
    stateDirs.push(isolateStateDir());
    const account: CloudflaredAccount = {
      hasCert: () => true,
      login: async () => undefined,
      listTunnels: async () => [],
      createTunnel: async (name) => ({ id: "66666666-6666-6666-6666-666666666666", name }),
      deleteTunnel: async () => undefined,
      routeDns: async () => undefined,
    };

    // 1 & 2: the workspace made its one-time choice ("quick", no zone known
    // at the time) and that choice was persisted.
    chooseQuickTunnel("ws-upgrade-2");
    let state = readTunnelState("ws-upgrade-2");
    expect(state.preference).toBe("quick");
    expect(needsTunnelChoice(state)).toBe(false); // never re-asks
    expect(canUpgradeToNamed(state)).toBe(true); // but eligible to upgrade

    // 3 & 4: `imonikai init` runs again later, this time with a zone
    // available — this is exactly the call its upgrade branch makes.
    const result = await provisionNamedTunnel({
      workspaceId: "ws-upgrade-2",
      workspaceName: "Demo",
      zone: "example.com",
      account,
    });

    // 5: the workspace is now on a Named Tunnel, and no longer eligible for
    // "upgrade" (there's nothing left to upgrade). This exact sequence was
    // unreachable before this fix: provisionNamedTunnel used to live only
    // inside `if (needsTunnelChoice(...))`, so a workspace that had already
    // chosen quick could never reach it again.
    expect(result.fallback).toBe(false);
    state = readTunnelState("ws-upgrade-2");
    expect(state.preference).toBe("named");
    expect(isNamedTunnelReady(state)).toBe(true);
    expect(canUpgradeToNamed(state)).toBe(false);
  });

  it("is false once already on a named tunnel — nothing left to upgrade", () => {
    stateDirs.push(isolateStateDir());
    const named = readTunnelState("ws-named");
    expect(
      canUpgradeToNamed({
        ...named,
        preference: "named",
        tunnelName: "c2c-ws-named",
        hostname: "c2c-ws-named.example.com",
      })
    ).toBe(false);
  });

  it("upgrades through the REAL `imonikai init` application path (applyTunnelChoiceOrUpgrade), not just provisionNamedTunnel called directly", async () => {
    // ChatGPT's independent review of iteration 1 flagged that the
    // previous version of this test called chooseQuickTunnel() and
    // provisionNamedTunnel() directly — it never went through the actual
    // `canUpgradeToNamed` branch inside `imonikai init`'s CLI action, so
    // that branch could be deleted entirely and this test would stay
    // green. applyTunnelChoiceOrUpgrade is the exact function the CLI
    // action calls (extracted, not mirrored) — this test now goes through
    // it for real.
    stateDirs.push(isolateStateDir());
    const root = makeTmpDir("cli-upgrade-ws");
    workspaceDirs.push(root);
    const workspace = new Workspace(root);

    const account: CloudflaredAccount = {
      hasCert: () => true,
      login: async () => undefined,
      listTunnels: async () => [],
      createTunnel: async (name) => ({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name }),
      deleteTunnel: async () => undefined,
      routeDns: async () => undefined,
    };

    // 1 & 2: initial one-time choice, no zone known yet — this IS the real
    // `needsTunnelChoice` branch inside applyTunnelChoiceOrUpgrade (no
    // --zone given, no default zone saved).
    await applyTunnelChoiceOrUpgrade({
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspaceRoot: root,
      setDefaultZone: false,
      quiet: true,
      account,
    });
    let state = readTunnelState(workspace.id);
    expect(state.preference).toBe("quick");
    expect(needsTunnelChoice(state)).toBe(false);
    expect(canUpgradeToNamed(state)).toBe(true);

    // 3 & 4: re-run the SAME real function — this time a zone is known —
    // this must land in the `canUpgradeToNamed` branch, since
    // needsTunnelChoice is now false.
    const { messages } = await applyTunnelChoiceOrUpgrade({
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspaceRoot: root,
      zone: "example.com",
      setDefaultZone: false,
      quiet: true,
      account,
    });

    // 5: upgraded, and no longer upgrade-eligible.
    expect(messages.some((m) => m.includes("已升级为固定域名"))).toBe(true);
    state = readTunnelState(workspace.id);
    expect(state.preference).toBe("named");
    expect(isNamedTunnelReady(state)).toBe(true);
    expect(canUpgradeToNamed(state)).toBe(false);
  });
});
