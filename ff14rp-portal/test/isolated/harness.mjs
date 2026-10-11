// 隔離E2Eの共通部品。外部通信は全て遮断し、gstatic上のFirebase SDKはローカルのshimへ差し替える。
import http from "node:http"; import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { initializeApp, deleteApp } from "firebase/app";
import * as F from "firebase/firestore";
import { chromium } from "playwright-core";
import { FirestoreStore } from "../../store/firestore-store.js";
import { MASTER_COLLECTIONS } from "../../core/collections.js";
import { dryRun, applyPlan } from "../../tools/migrate-lib.js";
import { syntheticShops } from "../../fixtures/synthetic.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SHIM = path.resolve(here, "../../out/shim-fb.js");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".json": "application/json" };

export function startStatic(dir) {
  return new Promise(res => {
    const srv = http.createServer((req, r) => {
      const u = decodeURIComponent(new URL(req.url, "http://x").pathname); let f = path.join(dir, u === "/" ? "index.html" : u);
      if (!f.startsWith(dir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(dir, "index.html");
      r.writeHead(200, { "content-type": types[path.extname(f)] || "application/octet-stream", "cache-control": "no-store" }); fs.createReadStream(f).pipe(r);
    }).listen(0, "127.0.0.1", () => res({ url: `http://127.0.0.1:${srv.address().port}/`, close: () => srv.close() }));
  });
}
export async function launch() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  const exe = fs.existsSync(`${root}/chromium`) ? `${root}/chromium` : undefined;
  return chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
}
export async function openApp(browser, siteUrl) {
  const emuPort = process.env.FIRESTORE_EMULATOR_HOST.split(":")[1];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const blocked = [];
  await ctx.route("**/*", route => {
    const u = new URL(route.request().url());
    if (u.hostname === "www.gstatic.com" && /firebasejs\/12\.1\.0\/firebase-(app|auth|firestore)\.js$/.test(u.pathname)) return route.fulfill({ contentType: "text/javascript", body: 'export * from "https://shim.local/fb.js";' });
    if (u.hostname === "shim.local") return route.fulfill({ contentType: "text/javascript", body: fs.readFileSync(SHIM, "utf8") });
    if (["127.0.0.1", "localhost"].includes(u.hostname)) return route.continue();
    blocked.push(u.href); return route.abort();
  });
  await ctx.addInitScript(p => { window.__EMU_PORT = p; }, emuPort);
  const page = await ctx.newPage();
  const logs = []; page.on("console", m => logs.push(`${m.type()}: ${m.text()}`)); page.on("pageerror", e => logs.push(`pageerror: ${e.message}`));
  page.on("dialog", d => d.accept());
  await page.goto(siteUrl);
  return { page, ctx, blocked, logs };
}
let n = 0;
export function adminDb(projectId) {
  const app = initializeApp({ projectId, apiKey: "fake", appId: "fake" }, `admin-${projectId}-${n++}`);
  const db = F.getFirestore(app); const [h, p] = process.env.FIRESTORE_EMULATOR_HOST.split(":");
  F.connectFirestoreEmulator(db, h, Number(p)); return { db, app };
}
export async function wipe(db, cols) { for (const c of cols) for (const d of (await F.getDocs(F.collection(db, c))).docs) await F.deleteDoc(d.ref); }
export async function seedDiner(db) {
  const s = syntheticShops();
  await wipe(db, ["pixiesCustomers", "pixiesVisits", "pixiesMenu"]);
  for (const c of s.dinerCustomers) { const { id, ...d } = c; await F.setDoc(F.doc(db, "pixiesCustomers", id), d); }
  for (const v of s.dinerVisits) { const { id, ...d } = v; await F.setDoc(F.doc(db, "pixiesVisits", id), { ...d, createdAt: "2026-02-01T00:00:00.000Z", updatedAt: "2026-02-01T00:00:00.000Z" }); }
  return s;
}
export async function seedMaster(db, projectId) {
  await wipe(db, MASTER_COLLECTIONS);
  const store = new FirestoreStore(db, F, { projectId });
  const shops = syntheticShops();
  const { plan } = dryRun(shops, { batchId: "iso-1", now: "2026-10-11T00:00:00.000Z" });
  await applyPlan(store, plan);
  return { store, shops };
}
export async function visitFlags(db) {
  const o = {}; for (const d of (await F.getDocs(F.collection(db, "pixiesVisits"))).docs) { const x = d.data(); o[d.id] = { verCounted: !!x.verCounted, verCountExclusion: x.verCountExclusion ?? "", verCountOverride: x.verCountOverride ?? "" }; } return o;
}
export { F };
