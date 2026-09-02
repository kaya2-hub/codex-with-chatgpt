#!/usr/bin/env node
import { existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { spawnSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
// src/cli/run.ts (compiled: dist/cli/run.js) is the one real entry point —
// it unconditionally runs the CLI. src/cli/index.ts only defines it and
// exports `runCli`; it never auto-executes, so it's safe for tests to
// import directly. An earlier version of this file pointed at
// dist/cli/index.js and relied on an "is this the main module?" guess
// inside index.ts to decide whether to auto-run — that guess is exactly
// what silently broke the published dist/npm path (see run.ts's comment).
const dist = path.join(root, "dist", "cli", "run.js");

/** Newest mtime of any .ts file under `dir` (recursive, skipping
 *  node_modules/dotfiles). Used only to detect a stale dist/ build in a dev
 *  checkout — src/ here is small, a full walk costs a few ms. */
function newestSourceMtime(dir) {
  let newest = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.name.endsWith(".ts")) {
        const mtime = statSync(full).mtimeMs;
        if (mtime > newest) newest = mtime;
      }
    }
  }
  return newest;
}

function distIsStale() {
  try {
    const distMtime = statSync(dist).mtimeMs;
    return newestSourceMtime(path.join(root, "src")) > distMtime;
  } catch {
    return false;
  }
}

// `dist/` is a real published npm package's normal, correct entry point —
// prefer it there unconditionally (no `src/`, no `.git`, nothing to compare
// against). In a dev checkout (`.git` present), a `dist/` left over from an
// earlier build silently shadows every later `src/` edit — `c2c` commands
// then run stale code with no indication anything is wrong (this bit a real
// debugging session on 2026-09-02: hours of "why didn't my change take
// effect" before finding a day-old dist/). There, a stale dist/ falls back
// to running src/ directly through tsx instead.
const isDevCheckout = existsSync(path.join(root, ".git"));
const distPresent = existsSync(dist);
const useDist = distPresent && !(isDevCheckout && distIsStale());

if (distPresent && isDevCheckout && !useDist) {
  process.stderr.write(
    "c2c: dist/ is older than src/ in this dev checkout — running from source (tsx) instead. " +
      "Run `pnpm build` to refresh dist/, or delete dist/ to always run from source.\n"
  );
}

if (useDist) {
  // Dynamic import() requires a proper file:// URL on Windows — a raw
  // "C:\..." path is misparsed as a URL with scheme "c:". Importing run.js
  // is enough — it unconditionally calls runCli() itself, top-level.
  await import(pathToFileURL(dist).href);
} else {
  // dev fallback: run TypeScript sources through the tsx ESM loader
  const entry = path.join(root, "src", "cli", "run.ts");
  const result = spawnSync(process.execPath, ["--import", "tsx/esm", entry, ...process.argv.slice(2)], {
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}
