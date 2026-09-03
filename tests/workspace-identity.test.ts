import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  gitRemoteOrigin,
  normalizeGitRemote,
  recordWorkspaceGitIdentity,
  findDuplicateCheckoutWarning,
} from "../src/workspace/identity.js";
import { cleanup, isolateStateDir, makeTmpDir, git, makeGitRepo, write } from "./helpers.js";

// P2-6 (connector reliability hardening): read-only visibility into the same
// logical Git project existing as more than one checkout / workspaceId.
// Deliberately conservative -- see src/workspace/identity.ts's own doc
// comment for the three guarantees these tests pin: never guesses a remote,
// never touches another workspace beyond its own small identity file, never
// merges/unifies workspaceIds.

describe("normalizeGitRemote", () => {
  it("normalizes an HTTPS URL", () => {
    expect(normalizeGitRemote("https://github.com/Owner/Repo.git")).toBe("github.com/Owner/Repo");
  });

  it("normalizes an SCP-style URL to the same form as the equivalent HTTPS URL", () => {
    expect(normalizeGitRemote("git@github.com:Owner/Repo.git")).toBe("github.com/Owner/Repo");
    expect(normalizeGitRemote("https://github.com/Owner/Repo.git")).toBe("github.com/Owner/Repo");
  });

  it("is case-insensitive on host but preserves path case", () => {
    expect(normalizeGitRemote("https://GitHub.COM/Owner/Repo.git")).toBe("github.com/Owner/Repo");
  });

  it("tolerates a missing .git suffix and a trailing slash", () => {
    expect(normalizeGitRemote("https://github.com/owner/repo/")).toBe("github.com/owner/repo");
  });

  it("returns null for an unparseable / non-URL, non-SCP string rather than guessing", () => {
    expect(normalizeGitRemote("not a url at all")).toBeNull();
    expect(normalizeGitRemote("")).toBeNull();
  });

  it("treats different hosts or different paths as genuinely different remotes", () => {
    expect(normalizeGitRemote("https://github.com/a/b.git")).not.toBe(normalizeGitRemote("https://gitlab.com/a/b.git"));
    expect(normalizeGitRemote("https://github.com/a/b.git")).not.toBe(normalizeGitRemote("https://github.com/a/c.git"));
  });
});

describe("gitRemoteOrigin", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) cleanup(dirs.pop()!);
  });

  it("returns null for a directory that isn't a git repo at all (fail-safe, never throws)", () => {
    const root = makeTmpDir("identity-not-git");
    dirs.push(root);
    write(root, "a.txt", "a");
    expect(gitRemoteOrigin(root)).toBeNull();
  });

  it("returns null for a git repo with no origin remote configured", () => {
    const root = makeTmpDir("identity-no-origin");
    dirs.push(root);
    makeGitRepo(root);
    expect(gitRemoteOrigin(root)).toBeNull();
  });

  it("returns the normalized origin URL when one is configured", () => {
    const root = makeTmpDir("identity-with-origin");
    dirs.push(root);
    makeGitRepo(root);
    git(root, "remote", "add", "origin", "https://github.com/acme/widget.git");
    expect(gitRemoteOrigin(root)).toBe("github.com/acme/widget");
  });
});

describe("recordWorkspaceGitIdentity / findDuplicateCheckoutWarning", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) cleanup(dirs.pop()!);
    delete process.env.C2C_STATE_DIR;
  });

  it("warns only when a DIFFERENT workspaceId's own recorded remote matches", () => {
    isolateStateDir();
    const rootA = makeTmpDir("identity-dup-a");
    dirs.push(rootA);
    makeGitRepo(rootA);
    git(rootA, "remote", "add", "origin", "https://github.com/acme/shared.git");

    const rootB = makeTmpDir("identity-dup-b");
    dirs.push(rootB);
    makeGitRepo(rootB);
    git(rootB, "remote", "add", "origin", "git@github.com:acme/shared.git"); // same repo, SCP form

    const identityA = recordWorkspaceGitIdentity("workspace-a", rootA);
    // No other workspace has recorded anything yet.
    expect(findDuplicateCheckoutWarning(identityA)).toBeNull();

    const identityB = recordWorkspaceGitIdentity("workspace-b", rootB);
    const warning = findDuplicateCheckoutWarning(identityB);
    expect(warning).not.toBeNull();
    expect(warning?.gitRemote).toBe("github.com/acme/shared");
    expect(warning?.otherWorkspaces).toEqual([{ workspaceId: "workspace-a", root: rootA }]);

    // Symmetric: re-checking A now also sees B.
    const warningForA = findDuplicateCheckoutWarning(recordWorkspaceGitIdentity("workspace-a", rootA));
    expect(warningForA?.otherWorkspaces).toEqual([{ workspaceId: "workspace-b", root: rootB }]);
  });

  it("never warns for two workspaces with an unrelated remote", () => {
    isolateStateDir();
    const rootA = makeTmpDir("identity-unrelated-a");
    dirs.push(rootA);
    makeGitRepo(rootA);
    git(rootA, "remote", "add", "origin", "https://github.com/acme/one.git");

    const rootB = makeTmpDir("identity-unrelated-b");
    dirs.push(rootB);
    makeGitRepo(rootB);
    git(rootB, "remote", "add", "origin", "https://github.com/acme/two.git");

    recordWorkspaceGitIdentity("workspace-a", rootA);
    const identityB = recordWorkspaceGitIdentity("workspace-b", rootB);
    expect(findDuplicateCheckoutWarning(identityB)).toBeNull();
  });

  it("never warns when the remote is unknown (null), even for two otherwise-identical non-git workspaces", () => {
    isolateStateDir();
    const rootA = makeTmpDir("identity-null-a");
    dirs.push(rootA);
    write(rootA, "a.txt", "a");
    const rootB = makeTmpDir("identity-null-b");
    dirs.push(rootB);
    write(rootB, "a.txt", "a");

    recordWorkspaceGitIdentity("workspace-a", rootA);
    const identityB = recordWorkspaceGitIdentity("workspace-b", rootB);
    expect(identityB.gitRemote).toBeNull();
    expect(findDuplicateCheckoutWarning(identityB)).toBeNull();
  });

  it("never includes itself as its own duplicate", () => {
    isolateStateDir();
    const root = makeTmpDir("identity-self");
    dirs.push(root);
    makeGitRepo(root);
    git(root, "remote", "add", "origin", "https://github.com/acme/solo.git");
    const identity = recordWorkspaceGitIdentity("workspace-solo", root);
    expect(findDuplicateCheckoutWarning(identity)).toBeNull();
  });
});

// Independent review (ChatGPT, via the real C2C connector, iteration 7,
// 2026-09-03) found that if this optional visibility feature ever threw
// (e.g. the state dir became unwritable), its ONE call site in doctor
// (src/cli/index.ts) originally shared a try/catch with Workspace
// construction -- overwriting an already-successful `report.workspace:
// {ok:true}` with `{ok:false}`. Fixed on both sides: doctor now gives
// identity its own try/catch, and these two functions are fail-soft
// themselves (defense in depth, not the only guard). This pins the second
// half of that fix directly, with no fs mocking: a real, unwritable target
// path (a file where a directory is expected) forces a genuine ENOTDIR.
describe("identity persistence is fail-soft (never throws) even when the state dir is unwritable", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) cleanup(dirs.pop()!);
    delete process.env.C2C_STATE_DIR;
  });

  it("recordWorkspaceGitIdentity and findDuplicateCheckoutWarning degrade to null instead of throwing", () => {
    const blockerParent = makeTmpDir("identity-failsoft-blocker");
    dirs.push(blockerParent);
    const blockerFile = path.join(blockerParent, "not-a-directory");
    fs.writeFileSync(blockerFile, "x");
    // A real, unwritable target: a path THROUGH a plain file, not a
    // directory -- mkdirSync(..., {recursive:true}) genuinely throws ENOTDIR
    // here, no mocking involved.
    process.env.C2C_STATE_DIR = path.join(blockerFile, "nested", "codex-with-chatgpt");

    const root = makeTmpDir("identity-failsoft-ws");
    dirs.push(root);
    makeGitRepo(root);
    git(root, "remote", "add", "origin", "https://github.com/acme/failsoft.git");

    let identity: ReturnType<typeof recordWorkspaceGitIdentity> | undefined;
    expect(() => {
      identity = recordWorkspaceGitIdentity("workspace-failsoft", root);
    }).not.toThrow();
    expect(identity?.gitRemote).toBe("github.com/acme/failsoft");

    expect(() => findDuplicateCheckoutWarning(identity!)).not.toThrow();
    expect(findDuplicateCheckoutWarning(identity!)).toBeNull();
  });
});
