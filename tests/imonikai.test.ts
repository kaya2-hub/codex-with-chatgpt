import fs from "node:fs";
import { describe, it, expect } from "vitest";
import { isHostnameDirectlyUnderZone } from "../src/tunnel/hostname.js";

describe("imonikai CLI contract", () => {
  const cliSource = fs.readFileSync(new URL("../src/cli/index.ts", import.meta.url), "utf8");

  it("registers both imonikai status and imonikai init commands", () => {
    expect(cliSource).toContain('program.command("imonikai")');
    expect(cliSource).toMatch(/imonikai\s*\n\s*\.command\("status"\)/);
    expect(cliSource).toMatch(/imonikai\s*\n\s*\.command\("init"\)/);
  });

  it("imonikai status accepts --agent, matching both Skills' documented CLI contract", () => {
    const statusBlock = cliSource.slice(
      cliSource.indexOf('.command("status")', cliSource.indexOf("const imonikai =")),
      cliSource.indexOf('.command("init")', cliSource.indexOf("const imonikai ="))
    );
    expect(statusBlock).toContain('.option("--agent <agent>"');
  });

  it("imonikai init accepts --agent, --hostname, --zone and --set-default-zone", () => {
    const initBlock = cliSource.slice(cliSource.indexOf('.command("init")', cliSource.indexOf("const imonikai =")));
    expect(initBlock).toContain('.option("--agent <agent>"');
    expect(initBlock).toContain('.option("--hostname <hostname>"');
    expect(initBlock).toContain('.option("--zone <domain>"');
    expect(initBlock).toContain('.option("--set-default-zone"');
  });

  it("imonikai init's action calls applyTunnelChoiceOrUpgrade — the real, extracted tunnel-choice logic, not a reimplementation", () => {
    const initBlock = cliSource.slice(
      cliSource.indexOf('.command("init")', cliSource.indexOf("const imonikai =")),
      cliSource.indexOf("function handleCliError")
    );
    expect(initBlock).toContain("applyTunnelChoiceOrUpgrade(");
  });

  it("applyTunnelChoiceOrUpgrade itself reuses the shared tunnel primitives instead of a second implementation", () => {
    const fnBlock = cliSource.slice(
      cliSource.indexOf("export async function applyTunnelChoiceOrUpgrade"),
      cliSource.indexOf("export interface ImonikaiStatus")
    );
    expect(fnBlock).toContain("provisionNamedTunnel(");
    expect(fnBlock).toContain("chooseQuickTunnel(");
    expect(fnBlock).toContain("needsTunnelChoice(");
    expect(fnBlock).toContain("canUpgradeToNamed(");
  });
});

describe("imonikai init never auto-derives a zone from --hostname", () => {
  // Regression guard: this fork used to strip --hostname's leftmost label
  // to guess a "zone" whenever neither --zone nor a saved default zone was
  // given. That silently produces a non-apex zone for any --hostname with
  // 3+ labels (e.g. imonikai.c2c.example.com -> "zone" c2c.example.com),
  // which is exactly the shape confirmed to fail TLS silently — DNS routes
  // fine, but Cloudflare's default certificate for the real zone
  // (example.com) does not cover it (see docs/troubleshooting.md,
  // 2026-09-02). The fix removed deriveZoneFromHostname()'s call site from
  // imonikai init's zone-resolution chain entirely; assert it stays gone
  // rather than only asserting what the (now-deleted) helper used to
  // return, which would happily keep passing even if the risky fallback
  // were reintroduced under a new name.
  const cliSource = fs.readFileSync(new URL("../src/cli/index.ts", import.meta.url), "utf8");
  const fnBlock = cliSource.slice(
    cliSource.indexOf("export async function applyTunnelChoiceOrUpgrade"),
    cliSource.indexOf("export interface ImonikaiStatus")
  );

  it("does not reference any hostname-to-zone derivation anywhere in the source", () => {
    expect(cliSource).not.toMatch(/deriveZoneFromHostname/);
  });

  it("resolves the zone candidate from only --zone or a saved default zone", () => {
    const zoneCandidateBlock = fnBlock.slice(
      fnBlock.indexOf("const zoneCandidate"),
      fnBlock.indexOf("const restartBridgeIfLive")
    );
    expect(zoneCandidateBlock).toContain("parseZoneInput(opts.zone");
    expect(zoneCandidateBlock).toContain("readDefaultZone()");
    expect(zoneCandidateBlock).not.toContain("opts.hostname");
  });
});

describe("isHostnameDirectlyUnderZone", () => {
  it("accepts a hostname exactly one label under the zone", () => {
    expect(isHostnameDirectlyUnderZone("imonikai.example.com", "example.com")).toBe(true);
    expect(isHostnameDirectlyUnderZone("c2c-dev.bluecabi.net", "bluecabi.net")).toBe(true);
  });

  it("rejects a hostname one level deeper than the zone apex (the confirmed-failing shape)", () => {
    expect(isHostnameDirectlyUnderZone("imonikai.c2c.example.com", "example.com")).toBe(false);
    expect(isHostnameDirectlyUnderZone("imonikai.c2c.example.com", "c2c.example.com")).toBe(true);
  });

  it("rejects the hostname being the zone apex itself", () => {
    expect(isHostnameDirectlyUnderZone("example.com", "example.com")).toBe(false);
  });

  it("rejects a hostname that isn't under the zone at all", () => {
    expect(isHostnameDirectlyUnderZone("imonikai.other.com", "example.com")).toBe(false);
  });

  it("is case-insensitive and tolerates a trailing dot", () => {
    expect(isHostnameDirectlyUnderZone("Imonikai.Example.com.", "EXAMPLE.COM")).toBe(true);
  });
});
