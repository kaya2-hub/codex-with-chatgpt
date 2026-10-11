import test from "node:test";
import assert from "node:assert/strict";
import { migratedStore, byName, freshStore } from "./helpers.js";
import * as Op from "../core/identity-ops.js";
import { buildIndex, personStats } from "../core/aggregate.js";
import { MASTER as M } from "../core/collections.js";
import { MemoryShopSource } from "../store/firestore-store.js";

const load = async store => buildIndex({ persons: await store.list(M.persons), characters: await store.list(M.characters), links: await store.list(M.sourceLinks) });
const shopOf = s => ({ diner: { visits: s.dinerVisits }, toko: { visits: s.tokoVisits } });

test("DATA-09 競合編集: revision違いは拒否、再読込後は成功", async () => {
  const { store } = await migratedStore();
  const p = await store.get(M.persons, "person-diner-cus_a");
  await Op.editPersonInfo(store, "person-diner-cus_a", p.revision, { customerNote: "Kayaが編集" }, { label: "Kaya" });
  await assert.rejects(() => Op.editPersonInfo(store, "person-diner-cus_a", p.revision, { customerNote: "Toushinが古い版から編集" }, { label: "Toushin" }), e => e.code === "conflict");
  assert.equal((await store.get(M.persons, "person-diner-cus_a")).customerNote, "Kayaが編集");
  const p2 = await store.get(M.persons, "person-diner-cus_a");
  await Op.editPersonInfo(store, "person-diner-cus_a", p2.revision, { customerNote: "再読込後" }, { label: "Toushin" });
});
test("共通備考とDM: 保存・再読込で保持/不正URL拒否/改行保持", async () => {
  const { store } = await migratedStore();
  const p = await store.get(M.persons, "person-diner-cus_b");
  await Op.editPersonInfo(store, p.id ?? "person-diner-cus_b", p.revision, { customerNote: "1行目\n2行目", xDmUrl: "https://x.example/dm/new" }, { label: "Kaya" });
  const q = await store.get(M.persons, "person-diner-cus_b");
  assert.equal(q.customerNote, "1行目\n2行目"); assert.equal(q.xDmUrl, "https://x.example/dm/new");
  await assert.rejects(() => Op.editPersonInfo(store, "person-diner-cus_b", q.revision, { xDmUrl: "javascript:alert(1)" }), e => e.code === "bad-url");
});
test("VER-02/03 DM変更だけでVer件数・来店件数は不変、来店とVerは別表示", async () => {
  const { store, shops } = await migratedStore();
  const stat = async () => personStats((await load(store)).get("person-diner-cus_a"), shopOf(shops));
  const before = await stat();
  const p = await store.get(M.persons, "person-diner-cus_a");
  await Op.editPersonInfo(store, "person-diner-cus_a", p.revision, { xDmUrl: "" }, { label: "Kaya" });
  const after = await stat();
  assert.deepEqual(after.diner, before.diner);
  assert.equal(before.diner.visits, 14); assert.equal(before.diner.verStamps, 14);
  const d = personStats((await load(store)).get("person-diner-cus_d"), shopOf(shops));
  assert.equal(d.diner.visits, 3); assert.equal(d.diner.verStamps, 0);
});
test("DATA-04 改名: 旧名保持・履歴保持、undoで復元", async () => {
  const { store } = await migratedStore();
  const c = await byName(store, "Test Alpha");
  const chg = await Op.renameCharacter(store, c.id, "Test Alpha II", { label: "Kaya" });
  const r = await store.get(M.characters, c.id);
  assert.equal(r.currentName, "Test Alpha II"); assert.deepEqual(r.previousNames, ["Test Alpha"]);
  await Op.undoChange(store, chg, { label: "Kaya" });
  const u = await store.get(M.characters, c.id);
  assert.equal(u.currentName, "Test Alpha");
});
test("DATA-03 別キャラ追加: 来店を二重加算しない", async () => {
  const { store, shops } = await migratedStore();
  const a = await store.get(M.characters, "char-diner-cus_a");
  await Op.addCharacter(store, a.personId, "Test Alpha Sub", { label: "Kaya" });
  const e = (await load(store)).get(a.personId);
  assert.equal(e.characters.length, 2);
  assert.equal(personStats(e, shopOf(shops)).diner.visits, 14);
});
test("DATA-05/候補: 同名別人はrejectで独立Person、confirmで候補人物へ。確定前は集計に入らない", async () => {
  const { store, shops } = await migratedStore();
  const before = personStats((await load(store)).get("person-diner-cus_e"), shopOf(shops));
  assert.equal(before.toko.linked, false); assert.ok(before.notes.some(n => n.includes("未確認の照合候補")));
  const link = "toko__customerProfiles__profile-t3";
  await assert.rejects(() => Op.resolveCandidate(store, link, "confirm", { targetPersonId: "person-diner-cus_a", characterName: "x" }), e => e.code === "not-a-candidate");
  await Op.resolveCandidate(store, link, "reject", { characterName: "Same Name", label: "Kaya" });
  assert.equal((await store.get(M.persons, "person-diner-cus_e")).mergedInto, undefined);
  const l = await store.get(M.sourceLinks, link); assert.equal(l.linkStatus, "confirmed"); assert.notEqual(l.personId, "person-diner-cus_e");
  // Alpha: confirm → 常若亭来店が加わる(同営業回は1回、営業回IDなしは別計上・注記)
  await Op.resolveCandidate(store, "toko__customerProfiles__profile-t1", "confirm", { characterName: "Test Alpha", label: "Kaya" });
  const s = personStats((await load(store)).get("person-diner-cus_a"), shopOf(shops));
  assert.equal(s.toko.rawRows, 4); assert.equal(s.toko.visits, 3); assert.equal(s.toko.unverifiableCount, 1);
  assert.equal(s.total, 14 + 3);
});
test("DATA-07 統合とundo(誤統合の訂正)、削除ではなくmergedInto", async () => {
  const { store } = await migratedStore();
  const chg = await Op.mergePersons(store, "person-diner-cus_g", "person-diner-cus_f", { label: "Kaya" });
  assert.equal((await store.get(M.persons, "person-diner-cus_g")).mergedInto, "person-diner-cus_f");
  assert.equal((await store.get(M.characters, "char-diner-cus_g")).personId, "person-diner-cus_f");
  assert.equal((await load(store)).has("person-diner-cus_g"), false);
  await Op.undoChange(store, chg, { label: "Kaya" });
  assert.equal((await store.get(M.characters, "char-diner-cus_g")).personId, "person-diner-cus_g");
  assert.equal((await store.get(M.persons, "person-diner-cus_g")).mergedInto, null);
  await assert.rejects(() => Op.undoChange(store, chg), e => e.code === "already-undone");
});
test("undoは後続更新があれば競合で拒否", async () => {
  const { store } = await migratedStore();
  const c = await byName(store, "Test Beta");
  const chg = await Op.renameCharacter(store, c.id, "Beta2", { label: "Kaya" });
  await Op.renameCharacter(store, c.id, "Beta3", { label: "Toushin" });
  await assert.rejects(() => Op.undoChange(store, chg), e => e.code === "conflict");
});
test("splitCharacterで人物分離", async () => {
  const { store } = await migratedStore();
  const pid = await Op.splitCharacter(store, "char-diner-cus_g", { label: "Kaya" });
  assert.equal((await store.get(M.characters, "char-diner-cus_g")).personId, pid);
});
test("SHOP-04 来店削除相当(店舗側データが空)でもPerson/備考/DMは残る", async () => {
  const { store, shops } = await migratedStore();
  const stats = personStats((await load(store)).get("person-diner-cus_a"), { diner: { visits: [] }, toko: { visits: shops.tokoVisits } });
  assert.equal(stats.diner.visits, 0);
  const p = await store.get(M.persons, "person-diner-cus_a");
  assert.equal(p.customerNote, "架空メモA"); assert.ok(p.xDmUrl);
});
test("店舗読込失敗時は総合来店回数を確定せずnull", async () => {
  const { store, shops } = await migratedStore();
  const s = personStats((await load(store)).get("person-diner-cus_a"), { diner: null, toko: { visits: shops.tokoVisits } });
  assert.equal(s.total, null); assert.equal(s.diner, null);
  const src = new MemoryShopSource({ pixiesVisits: [] }, "diner"); src.failing.add("pixiesVisits");
  await assert.rejects(() => src.list("pixiesVisits"), e => e.code === "shop-read-failed");
});
test("マスター以外のコレクションには書けない/読めない(店舗原記録の分離)", async () => {
  const store = await freshStore();
  await assert.rejects(() => store.batch([{ op: "create", col: "pixiesVisits", id: "x", data: {} }]), e => e.code === "collection-not-allowed");
  await assert.rejects(() => store.get("customerProfiles", "x"), e => e.code === "collection-not-allowed");
});
test("DATA: ダイナー側データ(syntheticShops)の同日複数リンクは自動で1回にせず注記", async () => {
  const { store, shops } = await migratedStore();
  const a = await store.get(M.characters, "char-diner-cus_a");
  // 同一人物にダイナー顧客をもう1件リンクしたと仮定(人物統合)
  await Op.mergePersons(store, "person-diner-cus_b", a.personId, { label: "Kaya" });
  const s = personStats((await load(store)).get(a.personId), shopOf(shops));
  assert.equal(s.diner.visits, 14 + 6);
  assert.ok(s.diner.sameDateAcrossLinks.length > 0); assert.ok(s.notes.some(n => n.includes("自動で1回にしません")));
});
