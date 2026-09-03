import fs from "node:fs";
import path from "node:path";
import { readJsonIfExists, stateSubdir, writeSecureJson } from "../config/paths.js";
import { runGit } from "./git.js";

/**
 * P2-6 (connector reliability hardening): visibility into the same logical
 * Git project existing as more than one checkout, each with its own
 * workspaceId (workspaceId is `sha256(realpath)` -- unchanged by this file,
 * see workspace/manager.ts). This is deliberately READ-ONLY and additive:
 * - never touches another workspace's process/bridge/tunnel, only its own
 *   small identity file (which every workspace writes about itself, the
 *   same pattern as endpoints/*.json or connector-confirmations/*.json);
 * - never infers a git remote when it can't be read cleanly -- unknown
 *   stays unknown, it is never guessed;
 * - never unifies or merges workspaceIds just because two checkouts share a
 *   remote -- it only ever adds a warning field for a human/agent to read.
 */
export interface WorkspaceGitIdentity {
  workspaceId: string;
  root: string;
  /** Normalized `host/path` form, or null when unknown (not a git repo, no
   *  `origin` remote, or a remote URL shape this can't safely normalize). */
  gitRemote: string | null;
  updatedAt: string;
}

function identityDir(): string {
  return stateSubdir("workspace-identity");
}

function identityFile(workspaceId: string): string {
  return path.join(identityDir(), `${workspaceId}.json`);
}

/**
 * Collapses the common URL and SCP-style forms of the same remote to one
 * comparable string (lowercased host + path, no trailing `.git`/slash).
 * Returns null for anything it can't confidently parse -- never guesses.
 */
export function normalizeGitRemote(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  const scp = trimmed.match(/^[\w.-]+@([\w.-]+):(.+)$/);
  if (scp) {
    const host = scp[1].toLowerCase();
    const p = scp[2].replace(/\.git$/i, "").replace(/^\/+/, "").replace(/\/+$/, "");
    return p ? `${host}/${p}` : null;
  }
  try {
    const parsed = new URL(trimmed);
    if (!parsed.hostname) return null;
    const host = parsed.hostname.toLowerCase();
    const p = parsed.pathname.replace(/\.git$/i, "").replace(/^\/+/, "").replace(/\/+$/, "");
    return p ? `${host}/${p}` : null;
  } catch {
    return null;
  }
}

/** Fail-safe: null on anything but a clean `origin` remote URL -- not a git
 *  repo, no `origin` remote, git not on PATH, or an unnormalizable URL all
 *  return null rather than throwing or guessing.
 *
 *  Also null when `root` is merely a SUBDIRECTORY of some enclosing repo
 *  rather than that repo's own top-level checkout -- git's own upward
 *  directory search would otherwise happily report the ENCLOSING repo's
 *  remote for a `root` that isn't a checkout at all (e.g. a workspace root
 *  nested inside a larger monorepo checkout). Without this check, two such
 *  subdirectory workspaces under the very same single checkout would look
 *  like duplicate checkouts of each other, which they are not -- confirmed
 *  live by this file's own test suite running inside this repo's
 *  `.tooling/test-tmp/`. */
export function gitRemoteOrigin(root: string): string | null {
  let toplevel: ReturnType<typeof runGit>;
  let result: ReturnType<typeof runGit>;
  try {
    toplevel = runGit(root, ["rev-parse", "--show-toplevel"]);
    result = runGit(root, ["remote", "get-url", "origin"]);
  } catch {
    return null;
  }
  if (!toplevel.ok || !result.ok) return null;
  if (path.resolve(toplevel.stdout.trim()) !== path.resolve(root)) return null;
  const raw = result.stdout.trim();
  return raw ? normalizeGitRemote(raw) : null;
}

/**
 * Fail-soft by design: this is optional visibility, never a required part
 * of resolving a workspace. Independent review (iteration 7) found that
 * letting this throw would, at its one call site in doctor, overwrite an
 * ALREADY-SUCCESSFUL `report.workspace: {ok:true}` with `{ok:false}` --
 * conflating "workspace construction failed" with "this optional P2-6
 * feature failed to persist a file". A directory-creation or disk-I/O
 * failure here degrades to "no warning available", never to a doctor
 * failure.
 */
export function recordWorkspaceGitIdentity(workspaceId: string, root: string): WorkspaceGitIdentity {
  const identity: WorkspaceGitIdentity = {
    workspaceId,
    root,
    gitRemote: gitRemoteOrigin(root),
    updatedAt: new Date().toISOString(),
  };
  try {
    writeSecureJson(identityFile(workspaceId), identity);
  } catch {
    // Fail-soft -- see doc comment above.
  }
  return identity;
}

export interface DuplicateCheckoutWarning {
  gitRemote: string;
  otherWorkspaces: { workspaceId: string; root: string }[];
}

/**
 * Read-only cross-check against other workspaces' own already-persisted
 * identity files. Only warns when a DIFFERENT workspaceId's file names the
 * exact same normalized remote -- two workspaces with `gitRemote: null`
 * (unknown) are never treated as a match. Fail-soft (returns null) on any
 * I/O failure, including the identity directory itself not existing yet --
 * see recordWorkspaceGitIdentity's doc comment for why this must never throw.
 */
export function findDuplicateCheckoutWarning(current: WorkspaceGitIdentity): DuplicateCheckoutWarning | null {
  if (!current.gitRemote) return null;
  let dir: string;
  let files: string[];
  try {
    dir = identityDir();
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return null;
  }
  const others: { workspaceId: string; root: string }[] = [];
  for (const file of files) {
    const id = file.replace(/\.json$/, "");
    if (id === current.workspaceId) continue;
    const other = readJsonIfExists<WorkspaceGitIdentity>(path.join(dir, file));
    if (other?.gitRemote && other.gitRemote === current.gitRemote) {
      others.push({ workspaceId: other.workspaceId, root: other.root });
    }
  }
  return others.length > 0 ? { gitRemote: current.gitRemote, otherWorkspaces: others } : null;
}
