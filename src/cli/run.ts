// The ONLY real entry point for the `c2c` CLI. `src/cli/index.ts` defines
// the program and commands but never auto-executes — this file's entire
// job is to unconditionally run it, so nothing anywhere has to guess
// whether it's "the main module" (an earlier version of this file lived at
// the bottom of index.ts and used an `import.meta.url === process.argv[1]`
// check to skip auto-running when imported by tests — that check silently
// broke the published dist/npm path: `bin/c2c.js` imports `dist/cli/index.js`
// dynamically, so `import.meta.url` there is never `process.argv[1]`
// (`bin/c2c.js`'s own path), and the CLI became a total no-op). `bin/c2c.js`
// always resolves to this file (or its compiled `dist/cli/run.js`
// equivalent) as the thing to run, never to `index.ts`/`index.js` directly.
import { runCli } from "./index.js";

await runCli(process.argv);
