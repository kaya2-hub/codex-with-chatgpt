import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Workspace } from "../src/workspace/manager.js";
import { deriveProjectKey, resolveEffectiveKokubanConfig, sanitizeProjectKey } from "../src/session/kokuban-config.js";
import { cleanup, makeTmpDir, write } from "./helpers.js";

// Kokuban ITERATION 4 (independent review, 2026-09-03, two rounds):
// default-ON participation + mechanical projectKey auto-derivation,
// resolved through ONE helper (resolveEffectiveKokubanConfig) rather than
// re-implemented at each CLI call site.

/** Creates a directory with an EXACT, caller-controlled basename (unlike
 *  makeTmpDir, which always appends a random suffix) so derivation tests
 *  can assert on a precise expected projectKey. */
function makeNamedDir(basename: string): string {
  const parent = makeTmpDir("kokuban-cfg-parent");
  const dir = path.join(parent, basename);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync.native(dir);
}

describe("sanitizeProjectKey", () => {
  it("lowercases and hyphenates whitespace/symbols", () => {
    expect(sanitizeProjectKey("Codex With ChatGPT")).toBe("codex-with-chatgpt");
    expect(sanitizeProjectKey("UPPER_CASE_NAME")).toBe("upper-case-name");
    expect(sanitizeProjectKey("  leading and trailing  ")).toBe("leading-and-trailing");
  });

  it("collapses runs of separators into a single hyphen", () => {
    expect(sanitizeProjectKey("a..b__c   d")).toBe("a-b-c-d");
  });

  it("leaves an already-kebab-case name unchanged", () => {
    expect(sanitizeProjectKey("already-kebab-case")).toBe("already-kebab-case");
  });

  it("keeps digits, including a leading digit", () => {
    expect(sanitizeProjectKey("123numeric-Start")).toBe("123numeric-start");
  });

  it("strips non-ASCII runs like any other separator, never transliterating them", () => {
    expect(sanitizeProjectKey("mixed 日本語 chars 123")).toBe("mixed-chars-123");
  });

  it("returns an empty string for input that sanitizes to nothing -- never fabricates a name", () => {
    expect(sanitizeProjectKey("日本語のみ")).toBe("");
    expect(sanitizeProjectKey("!!!###")).toBe("");
    expect(sanitizeProjectKey("")).toBe("");
  });
});

describe("deriveProjectKey / resolveEffectiveKokubanConfig", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) cleanup(dirs.pop()!);
  });

  it("no kokuban block at all: default ON, deterministic projectKey derived from the workspace ROOT's basename", () => {
    const root = makeNamedDir("My Cool Workspace");
    dirs.push(path.dirname(root));
    write(root, "a.txt", "a");
    const workspace = new Workspace(root);

    expect(deriveProjectKey(workspace)).toBe("my-cool-workspace");
    const effective = resolveEffectiveKokubanConfig(workspace);
    expect(effective).not.toBeNull();
    expect(effective?.projectKey).toBe("my-cool-workspace");

    // Deterministic: re-resolving the SAME workspace produces the SAME key.
    const again = resolveEffectiveKokubanConfig(new Workspace(root));
    expect(again?.projectKey).toBe(effective?.projectKey);
  });

  it("normal workspace without .c2c.json at all: still default ON, derived from the root directory's basename", () => {
    const root = makeTmpDir("kokuban-cfg-no-c2cjson");
    dirs.push(root);
    write(root, "a.txt", "a");
    const workspace = new Workspace(root);

    const effective = resolveEffectiveKokubanConfig(workspace);
    expect(effective).not.toBeNull();
    expect(effective?.projectKey).toBe(sanitizeProjectKey(path.basename(workspace.root)));
    expect(effective?.projectKey.length).toBeGreaterThan(0);
  });

  it("a workspace root directory name that sanitizes to nothing falls back to the workspace's own stable identity hash", () => {
    const root = makeNamedDir("日本語のみ");
    dirs.push(path.dirname(root));
    write(root, "a.txt", "a");
    const workspace = new Workspace(root);

    expect(deriveProjectKey(workspace)).toBe(workspace.id);
    expect(resolveEffectiveKokubanConfig(workspace)?.projectKey).toBe(workspace.id);
  });

  // Independent review, Kokuban ITERATION 4, second pass: `.c2c.json`'s
  // `name` field is a user-editable DISPLAY label, not a stable identity
  // signal -- deriving from it would let renaming a workspace (without
  // moving/renaming its actual root directory) silently split that
  // workspace's Kokuban history across two different projectKeys.
  it("changing ONLY .c2c.json's name field, with the workspace root untouched, does NOT change the derived projectKey", () => {
    const root = makeNamedDir("Stable Root Name");
    dirs.push(path.dirname(root));
    write(root, "a.txt", "a");

    const before = resolveEffectiveKokubanConfig(new Workspace(root));
    expect(before?.projectKey).toBe("stable-root-name");

    write(root, ".c2c.json", JSON.stringify({ name: "A Completely Different Display Name" }));
    const after = resolveEffectiveKokubanConfig(new Workspace(root));

    expect(after?.projectKey).toBe(before?.projectKey);
    expect(after?.projectKey).toBe("stable-root-name"); // still the root basename, never the display name
    // The display name itself DID take effect elsewhere (workspace.name),
    // proving this isn't just "the override was ignored somehow" -- only
    // the Kokuban projectKey derivation is insulated from it.
    expect(new Workspace(root).name).toBe("A Completely Different Display Name");
  });

  it("explicit projectKey always wins over derivation, whether or not enabled is also present", () => {
    const root = makeTmpDir("kokuban-cfg-explicit-key");
    dirs.push(root);
    write(root, "a.txt", "a");
    write(root, ".c2c.json", JSON.stringify({ name: "Something Else Entirely", kokuban: { projectKey: "custom-key" } }));
    const workspace = new Workspace(root);

    expect(resolveEffectiveKokubanConfig(workspace)?.projectKey).toBe("custom-key");
  });

  it("enabled:false is an explicit opt-out -- returns null regardless of projectKey", () => {
    const root = makeTmpDir("kokuban-cfg-opt-out");
    dirs.push(root);
    write(root, "a.txt", "a");
    write(root, ".c2c.json", JSON.stringify({ kokuban: { enabled: false } }));
    const workspace = new Workspace(root);

    expect(resolveEffectiveKokubanConfig(workspace)).toBeNull();
  });

  it("enabled:false with an explicit projectKey is still an opt-out -- enabled:false always wins", () => {
    const root = makeTmpDir("kokuban-cfg-opt-out-with-key");
    dirs.push(root);
    write(root, "a.txt", "a");
    write(root, ".c2c.json", JSON.stringify({ kokuban: { enabled: false, projectKey: "would-be-used-otherwise" } }));
    const workspace = new Workspace(root);

    expect(resolveEffectiveKokubanConfig(workspace)).toBeNull();
  });

  it("a bare kokuban block with no projectKey and no enabled field: default ON, derived key (same as no block at all)", () => {
    const root = makeNamedDir("Bare Block Workspace");
    dirs.push(path.dirname(root));
    write(root, "a.txt", "a");
    write(root, ".c2c.json", JSON.stringify({ kokuban: { apiBaseUrl: "https://staging.example.com" } }));
    const workspace = new Workspace(root);

    const effective = resolveEffectiveKokubanConfig(workspace);
    expect(effective?.projectKey).toBe("bare-block-workspace");
    expect(effective?.apiBaseUrl).toBe("https://staging.example.com"); // other overrides still pass through
  });

  it("backward compatibility: an existing { kokuban: { projectKey: ... } } workspace (pre-ITERATION-4 shape) keeps using that exact projectKey", () => {
    const root = makeTmpDir("kokuban-cfg-legacy-shape");
    dirs.push(root);
    write(root, "a.txt", "a");
    write(root, ".c2c.json", JSON.stringify({ kokuban: { projectKey: "bluecabi-personal-core" } }));
    const workspace = new Workspace(root);

    const effective = resolveEffectiveKokubanConfig(workspace);
    expect(effective?.projectKey).toBe("bluecabi-personal-core");
    expect(effective?.apiBaseUrl).toBeUndefined();
    expect(effective?.tokenEnvVar).toBeUndefined();
    expect(effective?.actor).toBeUndefined();
  });

  it("does not touch other ProjectConfig fields (chatgptSurface, rejectWorkSuggestion, maxIterations, name)", () => {
    const root = makeTmpDir("kokuban-cfg-other-fields");
    dirs.push(root);
    write(root, "a.txt", "a");
    write(
      root,
      ".c2c.json",
      JSON.stringify({ name: "Untouched Name", maxIterations: 7, chatgptSurface: "work", rejectWorkSuggestion: false })
    );
    const workspace = new Workspace(root);

    expect(workspace.name).toBe("Untouched Name");
    expect(workspace.projectConfig.maxIterations).toBe(7);
    expect(workspace.chatgptPolicy).toEqual({ chatgptSurface: "work", rejectWorkSuggestion: false });
    // And Kokuban still resolves normally alongside those, unaffected --
    // derived from the root basename, NOT the "Untouched Name" display name.
    expect(resolveEffectiveKokubanConfig(workspace)?.projectKey).toBe(sanitizeProjectKey(path.basename(workspace.root)));
  });
});
