// 保存版ダイナーアプリ(原本/パッチ済み)を隔離環境で実際に操作し、備考・DM正本の一本化とVer判定の不変を検証する。
import assert from "node:assert/strict";
import { startStatic, launch, openApp, adminDb, seedDiner, seedMaster, visitFlags, F } from "./harness.mjs";
import { setCutover, preflight } from "../../core/cutover.js";
import { MASTER as M } from "../../core/collections.js";

const [, , origDir, patchedDir] = process.argv;
const allBlocked = []; const results = []; const step = async (name, fn) => { try { await fn(); results.push(["PASS", name]); console.log("PASS", name); } catch (e) { results.push(["FAIL", name]); console.log("FAIL", name, "\n  ", e.message.split("\n")[0]); } };
const { db } = adminDb("demo-iso");
const br = await launch();

async function prepare(mode) {
  await seedDiner(db); const { store, shops } = await seedMaster(db, "demo-iso");
  if (mode === "master") {
    const links = await store.list(M.sourceLinks), persons = await store.list(M.persons);
    await setCutover(store, "diner", "master", preflight({ persons, links, dinerCustomers: shops.dinerCustomers, tokoProfiles: shops.tokoProfiles }, "diner"), { label: "iso" });
  } else if (mode === "off") await setCutover(store, "diner", "off", null, { label: "iso" });
  return { store, shops };
}
async function session(dir) {
  const srv = await startStatic(dir); const app = await openApp(br, srv.url); app.page.setDefaultTimeout(8000);
  await app.page.waitForFunction(() => document.querySelector("#dataHeaderStatus")?.textContent && !document.querySelector("#setupError")?.offsetParent, null, { timeout: 15000 }).catch(() => {});
  await app.page.waitForTimeout(2500); return { ...app, close: async () => { allBlocked.push(...app.blocked); await app.ctx.close(); srv.close(); } };
}
async function pickCustomer(page, name) {
  await page.evaluate(() => { document.getElementById("manualOrderDetails").open = true; });
  await page.fill("#customerPickerSearch", name);
  await page.locator("#customerPicker button", { hasText: name }).first().click();
  await page.click("#editCustomerInfoButton").catch(() => {});
}
async function editInfo(page, name, { dm, note }) {
  await pickCustomer(page, name);
  if (dm !== undefined) await page.fill("#xDmUrl", dm);
  if (note !== undefined) await page.fill("#customerNote", note);
  await page.click("#saveCustomerOnly"); await settle(page);
}
// 保存後の非同期書込み(Ver再判定等)が落ち着くまで待つ: Firestore上のVer判定が2回連続(1.5秒間隔)で同じになるまで
async function settle(page) {
  let prev = ""; for (let i = 0; i < 8; i++) { await page.waitForTimeout(1500); const cur = JSON.stringify(await visitFlags(db)); if (cur === prev) return; prev = cur; }
}
const localCustomer = async id => (await F.getDoc(F.doc(db, "pixiesCustomers", id))).data();

let legacyFlipped;
await step("[原本] DMを空にして保存すると過去のVerが一括でfalse化される(既知の危険の再現)", async () => {
  await prepare("none"); const before = await visitFlags(db); const s = await session(origDir);
  await editInfo(s.page, "Test Alpha", { dm: "", note: "n" }); const after = await visitFlags(db); await s.close();
  const changed = Object.keys(before).filter(k => before[k].verCounted !== after[k].verCounted).length;
  legacyFlipped = changed; assert.ok(changed >= 14, `想定: Alphaの14件が変化(実際 ${changed})`);
});
await step("[パッチ済み・flag off] 原本と同じ従来動作(同じ操作で同じ件数が変化)", async () => {
  await prepare("off"); const before = await visitFlags(db); const s = await session(patchedDir);
  assert.equal(await s.page.locator("#ff14rp-master-badge").count(), 0);
  await editInfo(s.page, "Test Alpha", { dm: "", note: "n" }); const after = await visitFlags(db); await s.close();
  assert.equal(Object.keys(before).filter(k => before[k].verCounted !== after[k].verCounted).length, legacyFlipped);
});
await step("[パッチ済み・master] 備考/DM変更は共通Personへ。店舗側の旧フィールド不変・Ver判定は来店ID単位で不変", async () => {
  const { store } = await prepare("master"); const before = await visitFlags(db); const localBefore = await localCustomer("cus_a");
  const s = await session(patchedDir);
  assert.equal(await s.page.locator("#ff14rp-master-badge").count(), 1);
  await editInfo(s.page, "Test Alpha", { dm: "", note: "共通へ保存される備考\n2行目" });
  const after = await visitFlags(db); assert.deepEqual(after, before); // 来店ID単位で完全一致
  const p = await store.get(M.persons, "person-diner-cus_a");
  assert.equal(p.xDmUrl, ""); assert.equal(p.customerNote, "共通へ保存される備考\n2行目"); assert.equal(p.revision, 2);
  const localAfter = await localCustomer("cus_a");
  assert.equal(localAfter.xDmUrl, localBefore.xDmUrl); assert.equal(localAfter.customerNote, localBefore.customerNote); // 凍結(削除・上書きなし)
  assert.ok((await store.list(M.identityChanges)).some(c => c.kind === "editPersonInfo" && c.reason === "diner-app"));
  await s.close();
});
await step("[パッチ済み・master] 起動時にoverlay: 店舗側と共通が違えば共通が表示される。起動で書込みは発生しない", async () => {
  const { store } = await prepare("master");
  const p = await store.get(M.persons, "person-diner-cus_a");
  await store.batch([{ op: "update", col: M.persons, id: "person-diner-cus_a", expectedRevision: p.revision, data: { customerNote: "ポータルで更新した備考" } }]);
  const before = await visitFlags(db); const s = await session(patchedDir);
  await pickCustomer(s.page, "Test Alpha");
  assert.equal(await s.page.inputValue("#customerNote"), "ポータルで更新した備考");
  assert.deepEqual(await visitFlags(db), before);
  assert.equal((await localCustomer("cus_a")).customerNote, "架空メモA");
  await s.close();
});
await step("[パッチ済み・master] 来店記帳(DMなしの顧客でも既存のVer♥が保持される)・注文機能が動く", async () => {
  const { store } = await prepare("master"); const before = await visitFlags(db);
  const s = await session(patchedDir);
  // DMなしにしても過去判定は再計算されない
  await editInfo(s.page, "Test Alpha", { dm: "", note: "x" });
  const afterInfo = await visitFlags(db); assert.deepEqual(afterInfo, before);
  const n0 = (await F.getDocs(F.collection(db, "pixiesVisits"))).size;
  await s.page.click("#changeCustomerButton").catch(() => {});
  await pickCustomer(s.page, "Test Beta");
  await s.page.locator("#orderTypes").getByText("Verセット").click();
  await s.page.locator("#verFoodChoices").getByText("ポポトポタージュ").click();
  await s.page.locator("#verDrinkChoices").getByText("D1").first().click();
  await s.page.click("#submitLedger"); await settle(s.page);
  const n1 = (await F.getDocs(F.collection(db, "pixiesVisits"))).size;
  assert.equal(n1, n0 + 1, "来店が1件追加される");
  const flags = await visitFlags(db); for (const k of Object.keys(before)) assert.deepEqual(flags[k], before[k]); // 既存来店は全て不変
  const added = Object.keys(flags).filter(k => !(k in before)); assert.equal(added.length, 1); assert.equal(flags[added[0]].verCounted, true); // 新規Ver来店はDMありの客なので♥(従来ルール)
  await s.close();
});
await step("[パッチ済み・master] 既存顧客への名前統合は止まり、データは変化しない", async () => {
  await prepare("master"); const s = await session(patchedDir);
  const n0 = (await F.getDocs(F.collection(db, "pixiesCustomers"))).size;
  await pickCustomer(s.page, "Test Delta");
  await s.page.fill("#existingCustomerName", "Test Beta"); await s.page.click("#saveCustomerOnly"); await settle(s.page);
  assert.equal((await F.getDocs(F.collection(db, "pixiesCustomers"))).size, n0);
  assert.match(await s.page.innerText("#toast"), /人物の統合/);
  await s.close();
});
await step("[master経験後にoff] 店舗側の旧DMは凍結で古い: 連携版は過去Verの再判定(reconcile)をしない", async () => {
  const { store } = await prepare("master");
  await setCutover(store, "diner", "off", null, { label: "iso" });
  const before = await visitFlags(db); const s = await session(patchedDir);
  assert.equal(await s.page.locator("#ff14rp-master-badge").count(), 0);
  await editInfo(s.page, "Test Alpha", { dm: "", note: "off後の編集" }); // 従来なら過去Verが一括false化される操作
  assert.deepEqual(await visitFlags(db), before); await s.close();
});
await step("[master] 名前変更(統合でない): 共通のキャラ名を改名として更新し、備考は共通へ。店舗側の備考は凍結", async () => {
  const { store } = await prepare("master"); const s = await session(patchedDir);
  await pickCustomer(s.page, "Test Delta"); await s.page.fill("#existingCustomerName", "Test Delta2"); await s.page.fill("#customerNote", "改名時の備考");
  await s.page.click("#saveCustomerOnly"); await settle(s.page);
  const ch = await store.get(M.characters, "char-diner-cus_d"); assert.equal(ch.currentName, "Test Delta2"); assert.deepEqual(ch.previousNames, ["Test Delta"]);
  assert.equal((await store.get(M.persons, "person-diner-cus_d")).customerNote, "改名時の備考");
  const local = await localCustomer("cus_d"); assert.equal(local.customerName, "Test Delta2"); assert.equal(local.customerNote, ""); // 店舗側名は更新・備考は凍結のまま
  await s.close();
});
await step("[master] 共通への保存に失敗しても店舗の記帳は止まらず、接続エラー状態にならない(通知のみ)", async () => {
  const { store } = await prepare("master");
  const l = await store.get(M.sourceLinks, "diner__pixiesCustomers__cus_e");
  await store.batch([{ op: "update", col: M.sourceLinks, id: l.id ?? "diner__pixiesCustomers__cus_e", expectedRevision: l.revision, data: { linkStatus: "unresolved" } }]);
  const s = await session(patchedDir);
  await editInfo(s.page, "Same Name", { note: "保存できない備考" });
  assert.match(await s.page.innerText("#toast"), /共通顧客マスターへ保存できなかった/); assert.equal(await s.page.locator("#setupError").isVisible(), false);
  const n0 = (await F.getDocs(F.collection(db, "pixiesVisits"))).size;
  await s.page.click("#changeCustomerButton").catch(() => {}); await pickCustomer(s.page, "Test Beta");
  await s.page.locator("#orderTypes").getByText("Verセット").click(); await s.page.locator("#verFoodChoices").getByText("ポポトポタージュ").click(); await s.page.locator("#verDrinkChoices").getByText("D1").first().click();
  await s.page.click("#submitLedger"); await settle(s.page);
  assert.equal((await F.getDocs(F.collection(db, "pixiesVisits"))).size, n0 + 1); await s.close();
});
await step("外部通信ゼロ(許可: localhostと差し替え済みSDKのみ)", async () => { const bad = allBlocked.filter(u => /firestore|firebaseio|identitytoolkit|securetoken|googleapis\.com\/(v1|identitytoolkit)/.test(u)); assert.deepEqual(bad, [], "本番Firebase系への通信試行が遮断された"); console.log("   遮断した外部通信(件数/ホスト):", allBlocked.length, [...new Set(allBlocked.map(u => new URL(u).hostname))].join(",")); });
await br.close();
const fails = results.filter(r => r[0] === "FAIL").length; console.log(fails ? `ISOLATED FAIL ${fails}` : "ISOLATED 全PASS"); process.exit(fails ? 1 : 0);
