import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getCodexHome } from "./sandbox-allow.js";

export type CodingAgent = "codex" | "claude-code";

export interface SkillSyncTarget {
  agent: CodingAgent;
  /** Absolute path to this agent's Skill source file inside the c2c-dev checkout. */
  repoPath: string;
  /** Absolute path to the copy Codex/Claude Code actually read from. */
  installedPath: string;
}

export interface SkillSyncResult extends SkillSyncTarget {
  repoFound: boolean;
  installedFound: boolean;
  /** Content differs from the repo (ignoring expected checkout-path and CRLF/LF differences). Always false once `fixed` is true. */
  stale: boolean;
  /** True when `fix` actually rewrote the installed copy this run. */
  fixed: boolean;
}

const CHECKOUT_LINE_RE = /^- The codex-with-chatgpt checkout lives at: `.*`$/m;
const CHECKOUT_LINE_PLACEHOLDER = "- The codex-with-chatgpt checkout lives at: `<CHECKOUT_PATH>`";

/**
 * Every installed Skill file has exactly one line that is expected to differ
 * from the repo copy: the repo ships a placeholder, installing fills in the
 * real checkout path. Git/installer line-ending handling can also leave the
 * repo copy as CRLF while the installed copy is LF. Normalize both expected
 * presentation differences before comparing so drift detection only fires on
 * actual content changes.
 */
export function normalizeSkillContent(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(CHECKOUT_LINE_RE, CHECKOUT_LINE_PLACEHOLDER);
}

/**
 * Where each agent's installed Skill copy lives, following the same
 * conventions the Skills themselves document (`~/.codex/skills/...`,
 * `~/.claude/skills/...`, both respecting an explicit CODEX_HOME override
 * the way `sandbox-allow` already does for Codex).
 */
export function defaultSkillSyncTargets(repoRoot: string): SkillSyncTarget[] {
  return [
    {
      agent: "codex",
      repoPath: path.join(repoRoot, "skill", "SKILL.md"),
      installedPath: path.join(getCodexHome(), "skills", "codex-with-chatgpt", "SKILL.md"),
    },
    {
      agent: "claude-code",
      repoPath: path.join(repoRoot, "skill-claude-code", "SKILL.md"),
      installedPath: path.join(os.homedir(), ".claude", "skills", "codex-with-chatgpt", "SKILL.md"),
    },
  ];
}

function readIfExists(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Compares each target's repo Skill source against the installed copy an
 * agent actually reads, and (with `fix`) rewrites stale installed copies in
 * place with the current repo content, checkout-path line filled in.
 *
 * Deliberately independent of `update-check`'s upstream/fork git sync: a
 * local edit to skill/SKILL.md or skill-claude-code/SKILL.md is drift the
 * moment it is saved, whether or not this checkout is ahead of any git
 * remote — so this never touches git and never needs a network call.
 */
export function runSkillSync(
  targets: SkillSyncTarget[],
  options: { fix: boolean; checkoutPath: string }
): SkillSyncResult[] {
  return targets.map((target) => {
    const repoContent = readIfExists(target.repoPath);
    if (repoContent === undefined) {
      return { ...target, repoFound: false, installedFound: false, stale: false, fixed: false };
    }

    const installedContent = readIfExists(target.installedPath);
    const installedFound = installedContent !== undefined;
    const stale = !installedFound || normalizeSkillContent(installedContent) !== normalizeSkillContent(repoContent);

    let fixed = false;
    if (stale && options.fix) {
      const filled = repoContent.replace(
        CHECKOUT_LINE_RE,
        `- The codex-with-chatgpt checkout lives at: \`${options.checkoutPath}\``
      );
      fs.mkdirSync(path.dirname(target.installedPath), { recursive: true });
      fs.writeFileSync(target.installedPath, filled, { mode: 0o600 });
      fixed = true;
    }

    return { ...target, repoFound: true, installedFound, stale: stale && !fixed, fixed };
  });
}
