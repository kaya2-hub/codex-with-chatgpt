import test from "node:test";
import assert from "node:assert/strict";
import { migratedStore } from "./helpers.js";
import { createBridge } from "../bridge/bridge.js";
import { preflight, setCutover, getCutover } from "../core/cutover.js";
import * as Op from "../core/identity-ops.js";
import { MASTER as M, MASTER_COLLECTIONS } from "../core/collections.js";

const emu = !!process.env.FIRESTORE_EMULATOR_HOST;
const opts = { skip: !emu && "Firestoreエミュレータ必須(npm run test:emu)" };

async function setup(system = "diner") {
  const ctx = await migratedStore();
  const { db, fs } = ctx.store.raw;
  const touched = new Set();
  const sdk = { ...fs, doc: (d, c, ...r) => { touched.add(c); return fs.doc(d, c, ...r); }, collection: (d, c) => { touched.add(c); return fs.collection(d, c); } };
  const load = async () => ({ persons: await ctx.store.list(M.persons), links: await ctx.store.list(M.sourceLinks), characters: await ctx.store.list(M.characters), dinerCustomers: ctx.shops.dinerCustomers, tokoProfiles: ctx.shops.tokoProfiles });
  return { ...ctx, db, sdk, touched, load, mk: () => createBridge({ db, sdk, system, label: "テスト画面" }) };
}

test("切替前: フラグ無し/off では完全に従来動作(overlayは素通し・書込なし)", opts, async () => {
  const t = await setup();
  const b = await t.mk(); assert.equal(b.active, false);
  const c = { customerId: "cus_a", xDmUrl: "local", customerNote: "local" };
  assert.deepEqual(b.overlay({ ...c }), c);
  await b.persistInfo(c); // no-op
  assert.equal((await t.store.get(M.persons, "person-diner-cus_a")).customerNote, "架空メモA");
});
test("preflight: 差異があれば master 化を拒否、解消後は許可。off(戻し)はいつでも可", opts, async () => {
  const t = await setup();
  let pre = preflight(await t.load(), "diner"); assert.equal(pre.ok, true);
  const drifted = { ...(await t.load()), dinerCustomers: t.shops.dinerCustomers.map(c => c.id === "cus_a" ? { ...c, customerNote: "店舗側で更新" } : c) };
  pre = preflight(drifted, "diner"); assert.equal(pre.ok, false); assert.ok(pre.checks.find(c => c.id === "no-drift" && !c.ok));
  await assert.rejects(() => setCutover(t.store, "diner", "master", pre), e => e.code === "preflight-failed");
  await setCutover(t.store, "diner", "master", preflight(await t.load(), "diner"), { label: "Kaya" });
  assert.equal((await getCutover(t.store)).dinerMode, "master");
  await setCutover(t.store, "diner", "off", null, { label: "Kaya" });
  const cut = await getCutover(t.store); assert.equal(cut.dinerMode, "off"); assert.equal(cut.history.length, 2);
});
test("master化(ダイナー): overlay・保存→共通Person更新+履歴+portalからundo・書込先はrp*のみ", opts, async () => {
  const t = await setup();
  await setCutover(t.store, "diner", "master", preflight(await t.load(), "diner"), { label: "Kaya" });
  const b = await t.mk(); assert.equal(b.active, true);
  const c = b.overlay({ customerId: "cus_a", customerName: "Test Alpha", xDmUrl: "stale", customerNote: "stale" });
  assert.equal(c.customerNote, "架空メモA"); assert.equal(c.xDmUrl, "https://x.example/dm/alpha"); assert.equal(c._master, true);
  c.customerNote = "ダイナー画面から編集"; c.xDmUrl = "";
  await b.persistInfo(c);
  const p = await t.store.get(M.persons, "person-diner-cus_a");
  assert.equal(p.customerNote, "ダイナー画面から編集"); assert.equal(p.xDmUrl, ""); assert.equal(p.revision, 2);
  const chg = (await t.store.list(M.identityChanges)).find(x => x.kind === "editPersonInfo");
  await Op.undoChange(t.store, chg.id, { label: "Kaya" });
  assert.equal((await t.store.get(M.persons, "person-diner-cus_a")).customerNote, "架空メモA");
  for (const col of t.touched) assert.ok(MASTER_COLLECTIONS.includes(col), `店舗コレクションに触れた: ${col}`);
});
test("一括取込(persistInfoMany)は空で既存DM/備考を消さない・不正URLは拒否", opts, async () => {
  const t = await setup();
  await setCutover(t.store, "diner", "master", preflight(await t.load(), "diner"));
  const b = await t.mk();
  await b.persistInfoMany([{ customerId: "cus_a", customerName: "Test Alpha", xDmUrl: "", customerNote: "" }]);
  const p = await t.store.get(M.persons, "person-diner-cus_a"); assert.ok(p.xDmUrl); assert.equal(p.customerNote, "架空メモA");
  await assert.rejects(() => b.persistInfo({ customerId: "cus_a", customerName: "x", xDmUrl: "javascript:1", customerNote: "" }), /http/);
});
test("移行後に店舗で登録された新規顧客: 独立Personを作成し、既存人物へ自動統合しない", opts, async () => {
  const t = await setup();
  await setCutover(t.store, "diner", "master", preflight(await t.load(), "diner"));
  const b = await t.mk();
  await b.persistInfo({ customerId: "cus_new", customerName: "Test Alpha", xDmUrl: "https://x.example/dm/new", customerNote: "同名の新規客" }); // 既存と同名でも別人物
  const link = await t.store.get(M.sourceLinks, "diner__pixiesCustomers__cus_new");
  assert.equal(link.personId, "person-diner-cus_new"); assert.equal(link.linkStatus, "confirmed");
  assert.equal((await t.store.get(M.persons, "person-diner-cus_a")).mergedInto, undefined);
  assert.equal(b.overlay({ customerId: "cus_new" }).customerNote, "同名の新規客");
});
test("統合済み人物でも統合先へ解決して保存", opts, async () => {
  const t = await setup();
  await Op.mergePersons(t.store, "person-diner-cus_b", "person-diner-cus_a", { label: "Kaya" });
  // 統合後は cus_b の店舗側値と統合先の共通値が異なる → 差異解消(取り込み)前はmaster化できない
  let ld = await t.load(); assert.equal(preflight(ld, "diner").ok, false);
  const a = t.shops.dinerCustomers.find(x => x.id === "cus_a");
  ld = { ...ld, dinerCustomers: ld.dinerCustomers.map(x => x.id === "cus_b" ? { ...x, customerNote: a.customerNote, xDmUrl: a.xDmUrl } : x) };
  await setCutover(t.store, "diner", "master", preflight(ld, "diner"));
  const b = await t.mk();
  const c = b.overlay({ customerId: "cus_b", customerName: "Test Beta" }); assert.equal(c._personId, "person-diner-cus_a");
  c.customerNote = "統合先へ"; await b.persistInfo(c);
  assert.equal((await t.store.get(M.persons, "person-diner-cus_a")).customerNote, "統合先へ");
});
test("master化(常若亭): 確定リンクの備考は共通へ、未確認(候補)は not-linked で従来保存へ。旧備考は参照用に保持", opts, async () => {
  const t = await setup("toko");
  await setCutover(t.store, "toko", "master", preflight(await t.load(), "toko"));
  const b = await t.mk(); assert.equal(b.active, true);
  const only = b.overlayProfile({ id: "profile-t2", name: "Toko Only", notes: "旧備考X" });
  assert.equal(only._master, true); assert.equal(only.notes, ""); assert.equal(only.legacyNotes, "旧備考X");
  await b.persistNote("profile-t2", "常若亭画面から\n2行目");
  assert.equal((await t.store.get(M.persons, "person-toko-profile-t2")).customerNote, "常若亭画面から\n2行目");
  assert.equal(b.overlayProfile({ id: "profile-t1", notes: "旧備考A" })._master, false); // 候補=未接続
  await assert.rejects(() => b.persistNote("profile-t1", "x"), e => e.code === "not-linked");
});

test("reconcile許可(reconcileAllowed): 未経験のoff=許可/master中=禁止/master経験後のoff=禁止/フラグ読込失敗=禁止(過去Ver保護)", opts, async () => {
  const t = await setup();
  let b = await t.mk(); assert.equal(b.reconcileAllowed, true); // フラグ無し=従来運用
  await setCutover(t.store, "diner", "master", preflight(await t.load(), "diner"));
  b = await t.mk(); assert.equal(b.active, true); assert.equal(b.reconcileAllowed, false);
  await setCutover(t.store, "diner", "off", null);
  b = await t.mk(); assert.equal(b.active, false); assert.equal(b.mode, "off"); assert.equal(b.reconcileAllowed, false); // master経験あり: 店舗側旧DMは凍結で古い
  const broken = await createBridge({ db: t.db, sdk: { ...t.sdk, getDoc: async () => { throw new Error("offline"); } }, system: "diner" });
  assert.equal(broken.active, false); assert.equal(broken.reconcileAllowed, false);
});
test("名前ガード: 同じ顧客IDでも共通側のキャラ名と違えば書かない(別人の可能性)/改名はsyncNameで旧名一致時のみ反映", opts, async () => {
  const t = await setup();
  await setCutover(t.store, "diner", "master", preflight(await t.load(), "diner"));
  const b = await t.mk();
  await assert.rejects(() => b.persistInfo({ customerId: "cus_a", customerName: "Somebody Else", customerNote: "上書きされてはいけない", xDmUrl: "" }), /一致しません/);
  assert.equal((await t.store.get(M.persons, "person-diner-cus_a")).customerNote, "架空メモA");
  await assert.rejects(() => b.syncName("cus_a", "Wrong Old", "Test Alpha 2"), /旧名/);
  await b.syncName("cus_a", "Test Alpha", "Test Alpha 2");
  const ch = await t.store.get(M.characters, "char-diner-cus_a"); assert.equal(ch.currentName, "Test Alpha 2"); assert.deepEqual(ch.previousNames, ["Test Alpha"]);
  await b.persistInfo({ customerId: "cus_a", customerName: "Test Alpha 2", customerNote: "改名後の備考", xDmUrl: "https://x.example/dm/alpha" });
  assert.equal((await t.store.get(M.persons, "person-diner-cus_a")).customerNote, "改名後の備考");
  const chg = (await t.store.list(M.identityChanges)).find(c => c.kind === "renameCharacter"); await Op.undoChange(t.store, chg.id); // ポータルから取り消し可能(後続更新がなければ)
});
test("preflight: ダイナー名の差異/0件読込はmaster化を拒否", opts, async () => {
  const t = await setup(); const ld = await t.load();
  const renamed = { ...ld, dinerCustomers: ld.dinerCustomers.map(c => c.id === "cus_a" ? { ...c, customerName: "Renamed In Diner" } : c) };
  const pre = preflight(renamed, "diner"); assert.equal(pre.ok, false); assert.ok(pre.checks.find(c => c.id === "no-name-drift" && !c.ok));
  assert.equal(preflight({ ...ld, dinerCustomers: [] }, "diner").ok, false);
});
