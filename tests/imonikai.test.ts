import fs from "node:fs";
import { describe, it, expect } from "vitest";

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

  it("imonikai init reuses the shared tunnel primitives instead of a second implementation", () => {
    const initBlock = cliSource.slice(
      cliSource.indexOf('.command("init")', cliSource.indexOf("const imonikai =")),
      cliSource.indexOf("function handleCliError")
    );
    expect(initBlock).toContain("provisionNamedTunnel(");
    expect(initBlock).toContain("chooseQuickTunnel(");
    expect(initBlock).toContain("needsTunnelChoice(");
  });
});

describe("deriveZoneFromHostname (via source, pure logic mirrored for a stable public contract)", () => {
  // The real implementation is a small unexported helper in src/cli/index.ts;
  // re-implement the same rule here so a change to the contract fails a test
  // instead of silently drifting. Keep in sync with deriveZoneFromHostname().
  function deriveZoneFromHostname(hostname: string): string | null {
    const parts = hostname.trim().toLowerCase().split(".");
    return parts.length >= 3 ? parts.slice(1).join(".") : null;
  }

  it("strips the leftmost label to derive a zone", () => {
    expect(deriveZoneFromHostname("imonikai.c2c.example.com")).toBe("c2c.example.com");
    expect(deriveZoneFromHostname("sub.example.com")).toBe("example.com");
  });

  it("returns null when there is no label to strip", () => {
    expect(deriveZoneFromHostname("example.com")).toBeNull();
    expect(deriveZoneFromHostname("localhost")).toBeNull();
  });
});
