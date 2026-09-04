import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { normalizeSkillContent, runSkillSync, type SkillSyncTarget } from "../src/config/skill-sync.js";
import { makeTmpDir, cleanup } from "./helpers.js";

function target(dir: string, agent: "codex" | "claude-code"): SkillSyncTarget {
  return {
    agent,
    repoPath: path.join(dir, "repo-SKILL.md"),
    installedPath: path.join(dir, "installed", "SKILL.md"),
  };
}

describe("skill-sync", () => {
  it("ignores the checkout-path line when comparing content", () => {
    const placeholder = "# Skill\n- The codex-with-chatgpt checkout lives at: `<CHECKOUT_PATH>`\nrest\n";
    const filledIn = "# Skill\n- The codex-with-chatgpt checkout lives at: `C:\\real\\path`\nrest\n";
    expect(normalizeSkillContent(placeholder)).toBe(normalizeSkillContent(filledIn));
  });

  it("does not flag a CRLF repo Skill and LF installed Skill as stale when their content otherwise matches", () => {
    const dir = makeTmpDir("skill-sync-line-endings");
    const t = target(dir, "codex");
    fs.writeFileSync(
      t.repoPath,
      "# Skill\r\n- The codex-with-chatgpt checkout lives at: `<ACTUAL_CHECKOUT_PATH>`\r\nbody\r\n"
    );
    fs.mkdirSync(path.dirname(t.installedPath), { recursive: true });
    fs.writeFileSync(
      t.installedPath,
      "# Skill\n- The codex-with-chatgpt checkout lives at: `/real/checkout`\nbody\n"
    );

    const result = runSkillSync([t], { fix: false, checkoutPath: "/real/checkout" });
    expect(result[0]).toMatchObject({ stale: false, fixed: false });
    cleanup(dir);
  });

  it("flags a missing installed copy as stale, and --fix creates it with the real checkout path filled in", () => {
    const dir = makeTmpDir("skill-sync-missing");
    const t = target(dir, "codex");
    fs.writeFileSync(t.repoPath, "# Skill\n- The codex-with-chatgpt checkout lives at: `<ACTUAL_CHECKOUT_PATH>`\nbody\n");

    const dry = runSkillSync([t], { fix: false, checkoutPath: "/checkout" });
    expect(dry[0]).toMatchObject({ repoFound: true, installedFound: false, stale: true, fixed: false });
    expect(fs.existsSync(t.installedPath)).toBe(false);

    const fixed = runSkillSync([t], { fix: true, checkoutPath: "/checkout" });
    expect(fixed[0]).toMatchObject({ stale: false, fixed: true });
    const installed = fs.readFileSync(t.installedPath, "utf8");
    expect(installed).toContain("- The codex-with-chatgpt checkout lives at: `/checkout`");
    expect(installed).toContain("body");
    cleanup(dir);
  });

  it("detects real content drift beyond the checkout-path line and repairs it", () => {
    const dir = makeTmpDir("skill-sync-drift");
    const t = target(dir, "claude-code");
    fs.writeFileSync(t.repoPath, "# Skill v2\n- The codex-with-chatgpt checkout lives at: `<CHECKOUT_PATH>`\nnew rule\n");
    fs.mkdirSync(path.dirname(t.installedPath), { recursive: true });
    fs.writeFileSync(t.installedPath, "# Skill v1\n- The codex-with-chatgpt checkout lives at: `/checkout`\nold rule\n");

    const before = runSkillSync([t], { fix: false, checkoutPath: "/checkout" });
    expect(before[0].stale).toBe(true);

    const after = runSkillSync([t], { fix: true, checkoutPath: "/checkout" });
    expect(after[0].fixed).toBe(true);
    expect(fs.readFileSync(t.installedPath, "utf8")).toContain("new rule");
    cleanup(dir);
  });

  it("reports up to date once content matches modulo the checkout-path line", () => {
    const dir = makeTmpDir("skill-sync-fresh");
    const t = target(dir, "codex");
    fs.writeFileSync(t.repoPath, "# Skill\n- The codex-with-chatgpt checkout lives at: `<ACTUAL_CHECKOUT_PATH>`\nbody\n");
    fs.mkdirSync(path.dirname(t.installedPath), { recursive: true });
    fs.writeFileSync(t.installedPath, "# Skill\n- The codex-with-chatgpt checkout lives at: `/checkout`\nbody\n");

    const result = runSkillSync([t], { fix: false, checkoutPath: "/checkout" });
    expect(result[0]).toMatchObject({ stale: false, fixed: false });
    cleanup(dir);
  });

  it("reports repoFound=false when the repo source is missing, without touching the installed copy", () => {
    const dir = makeTmpDir("skill-sync-norepo");
    const t = target(dir, "codex");
    const result = runSkillSync([t], { fix: true, checkoutPath: "/checkout" });
    expect(result[0]).toMatchObject({ repoFound: false, fixed: false });
    expect(fs.existsSync(t.installedPath)).toBe(false);
    cleanup(dir);
  });
});
