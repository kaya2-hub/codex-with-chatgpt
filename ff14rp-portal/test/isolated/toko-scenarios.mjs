// 保存版常若亭アプリ(パッチ済み)を隔離環境で操作し、備考の正本一本化(確認済み人物のみ)と旧備考の保持を検証する。
import assert from "node:assert/strict";
import { startStatic, launch, openApp, adminDb, seedMaster, F } from "./harness.mjs";
import { setCutover, preflight } from "../../core/cutover.js";
import { MASTER as M } from "../../core/collections.js";
const patchedDir = process.env.FF14RP_ISO_TOKO_DIR || process.argv[2];
const results = []; const step = async (name, fn) => { try { await fn(); results.push(1); console.log("PASS", name); } catch (e) { results.push(0); console.log("FAIL", name, "\n  ", e.message.split("\n")[0]); } };
const master = adminDb("demo-iso").db, tdb = adminDb("demo-toko").db;
const br = await launch();

async function prepare(mode) {
  const { store, shops } = await seedMaster(master, "demo-iso");
  for (const c of ["customerProfiles", "customerVisits", "customers", "items", "logs", "meta"]) for (const d of (await F.getDocs(F.collection(tdb, c))).docs) await F.deleteDoc(d.ref);
  await F.setDoc(F.doc(tdb, "customerProfiles", "profile-t2"), { name: "Toko Only", normalizedName: "tokoonly", notes: "旧備考X(切替前)" });
  await F.setDoc(F.doc(tdb, "customerProfiles", "profile-t1"), { name: "Test Alpha Bahamut", normalizedName: "testalphabahamut", notes: "旧備考A" });
  await F.setDoc(F.doc(tdb, "customerVisits", "rv-t2"), { profileId: "profile-t2", customerName: "Toko Only", visitDate: "2026-03-01", visitedAt: "2026-03-01", hasTime: false, source: "receipt", sourceSessionId: "2026-03-01" });
  await F.setDoc(F.doc(tdb, "customerVisits", "rv-t1"), { profileId: "profile-t1", customerName: "Test Alpha", visitDate: "2026-03-01", visitedAt: "2026-03-01", hasTime: false, source: "receipt", sourceSessionId: "2026-03-01" });
  await F.setDoc(F.doc(tdb, "meta", "customer-history-notion-20260807"), { done: true }); // 起動時のNotion初期シード書込みを止める(隔離テストのノイズ排除)
  const inputs = { persons: await store.list(M.persons), links: await store.list(M.sourceLinks), dinerCustomers: shops.dinerCustomers, tokoProfiles: shops.tokoProfiles };
  if (mode === "master") await setCutover(store, "toko", "master", preflight(inputs, "toko"), { label: "iso" });
  else await setCutover(store, "toko", "off", null, { label: "iso" });
  return { store };
}
async function session() {
  const srv = await startStatic(patchedDir); const app = await openApp(br, srv.url); app.page.setDefaultTimeout(8000);
  await app.page.evaluate(() => localStorage.setItem("tokowakatei_page", "customers"));
  await app.page.reload(); await app.page.waitForTimeout(3500);
  return { ...app, close: async () => { await app.ctx.close(); srv.close(); } };
}
async function openCard(page, name) {
  await page.fill("#directorySearch", name).catch(() => {});
  const card = page.locator(`[data-profile-id]`, { hasText: name }).first();
  await card.locator('button[data-action="toggle-profile"]').click().catch(async () => { await card.click(); });
  return card;
}
const note = async id => (await F.getDoc(F.doc(tdb, "customerProfiles", id))).data().notes;

await step("[master] 確認済み人物: 備考欄は共通(空)、旧備考は参照のみで表示、保存は共通Personへ・店舗側旧備考は凍結", async () => {
  const { store } = await prepare("master"); const s = await session();
  assert.equal(await s.page.locator("#ff14rp-master-badge").count(), 1);
  const card = await openCard(s.page, "Toko Only");
  assert.match(await card.innerText(), /切替前の旧備考/); assert.equal(await card.locator("[data-profile-notes]").inputValue(), "");
  await card.locator("[data-profile-notes]").fill("共通へ保存\n2行目"); await card.locator('button[data-action="save-notes"]').click(); await s.page.waitForTimeout(2500);
  assert.equal((await store.get(M.persons, "person-toko-profile-t2")).customerNote, "共通へ保存\n2行目");
  assert.equal(await note("profile-t2"), "旧備考X(切替前)");
  assert.ok((await store.list(M.identityChanges)).some(c => c.reason === "toko-app"));
  await s.close();
});
await step("[master] 照合未確認(候補)の人物は共通へ未接続のまま従来保存(表示で明示)・共通Personは変更されない", async () => {
  const { store } = await prepare("master"); const s = await session();
  const card = await openCard(s.page, "Test Alpha Bahamut");
  assert.match(await card.innerText(), /照合未確認/);
  await card.locator("[data-profile-notes]").fill("従来どおり店舗内に保存"); await card.locator('button[data-action="save-notes"]').click(); await s.page.waitForTimeout(2000);
  assert.equal(await note("profile-t1"), "従来どおり店舗内に保存");
  assert.equal((await store.get(M.persons, "person-diner-cus_a")).customerNote, "架空メモA"); // 名前一致だけでは共通へ入らない(自動統合なし)
  await s.close();
});
await step("[flag off] 従来動作: 店舗内保存のみ・バッジなし・共通は不変", async () => {
  const { store } = await prepare("off"); const s = await session();
  assert.equal(await s.page.locator("#ff14rp-master-badge").count(), 0);
  const card = await openCard(s.page, "Toko Only"); assert.equal(await card.locator("[data-profile-notes]").inputValue(), "旧備考X(切替前)");
  await card.locator("[data-profile-notes]").fill("従来保存"); await card.locator('button[data-action="save-notes"]').click(); await s.page.waitForTimeout(2000);
  assert.equal(await note("profile-t2"), "従来保存"); assert.equal((await store.get(M.persons, "person-toko-profile-t2")).customerNote, "");
  await s.close();
});
await br.close(); const f = results.filter(x => !x).length; console.log(f ? `ISOLATED-TOKO FAIL ${f}` : "ISOLATED-TOKO 全PASS"); process.exit(f ? 1 : 0);
