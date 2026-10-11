import { startStatic, launch, openApp, adminDb, seedDiner, seedMaster } from "./harness.mjs";
const dir = process.argv[2];
const { db } = adminDb("demo-iso"); await seedDiner(db); await seedMaster(db, "demo-iso");
const srv = await startStatic(dir); const br = await launch(); const { page, blocked, logs } = await openApp(br, srv.url);
await page.waitForTimeout(3500);
console.log((await page.innerText("body")).slice(0, 1500));
console.log("blocked:", [...new Set(blocked.map(u => new URL(u).hostname))]); console.log(logs.slice(0, 8));
await page.screenshot({ path: "out/diner-explore.png" }); await br.close(); srv.close(); process.exit(0);
