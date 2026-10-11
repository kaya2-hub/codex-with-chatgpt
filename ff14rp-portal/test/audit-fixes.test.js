import test from "node:test";
import assert from "node:assert/strict";
import { migratedStore, freshStore } from "./helpers.js";
import * as Op from "../core/identity-ops.js";
import * as Ce from "../core/ceremony.js";
import { rollbackBatch } from "../tools/migrate-lib.js";
import { renderMacro } from "../core/macro.js";
import { FirestoreStore } from "../store/firestore-store.js";
import { MASTER as M } from "../core/collections.js";

test("M1 統合しても統合元の実施記録を同じ達成として扱い再実施させない / 記録のある人物は分離不可", async () => {
  const { store } = await migratedStore();
  await Ce.recordPerformance(store, { personId: "person-diner-cus_c", stampValue: 7, storeId: "diner", businessDate: "2026-10-11", act: "gg", label: "Kaya" });
  await Op.mergePersons(store, "person-diner-cus_c", "person-diner-cus_a", { label: "Kaya" });
  const into = await store.get(M.persons, "person-diner-cus_a");
  const recs = await store.list(M.ceremonyRecords);
  const st = Ce.ceremonyStatus({ personId: "person-diner-cus_a", verStamps: 21, aliasIds: into.mergedFrom.map(x => x.personId) }, recs);
  assert.deepEqual(st.map(x => x.status), ["done", "reached_pending", "reached_pending"]);
  await Ce.recordPerformance(store, { personId: "person-diner-cus_b", stampValue: 7, storeId: "diner", businessDate: "2026-10-12", act: "gg", label: "K" });
  await assert.rejects(() => Op.splitCharacter(store, "char-diner-cus_b"), e => e.code === "has-ceremony-records");
});
test("M2 後続が参照している作成物のundoは拒否(孤児を作らない)", async () => {
  const { store } = await migratedStore();
  const pidChange = await Op.splitCharacter(store, "char-diner-cus_g", { label: "Kaya" });
  const newPerson = (await store.get(M.characters, "char-diner-cus_g")).personId;
  await Op.addCharacter(store, newPerson, "追加キャラ", { label: "Kaya" });
  const changes = await store.list(M.identityChanges);
  const split = changes.find(c => c.kind === "splitCharacter");
  await assert.rejects(() => Op.undoChange(store, split.id), e => e.code === "conflict");
  assert.ok(await store.get(M.persons, newPerson));
});
test("M5 ダーツ: 取り消し可(記録前のみ)・同時確定は例外でなくdecided:false", async () => {
  const store = await freshStore();
  const a = await Ce.recordDraw(store, { storeId: "diner", businessDate: "2026-10-11", act: "gg", personId: "p1" });
  assert.equal(a.decided, true);
  await Ce.recordPerformance(store, { personId: "p1", stampValue: 7, storeId: "diner", businessDate: "2026-10-11", act: "gg" });
  await assert.rejects(() => Ce.clearDraw(store, { storeId: "diner", businessDate: "2026-10-11" }), e => e.code === "has-records");
  const b = await Ce.recordDraw(store, { storeId: "toko", businessDate: "2026-10-11", act: "monster", personId: "p2" });
  await Ce.clearDraw(store, { storeId: "toko", businessDate: "2026-10-11" });
  assert.equal(await Ce.actForTarget(store, "toko", "2026-10-11"), null);
  assert.equal(b.decided, true);
});
test("M7 rollbackは他から参照されるPerson/Characterを削除しない", async () => {
  const { store } = await migratedStore();
  // 候補確定(オペレータ作成Characterが既存Personを指す)後のrollback
  await Op.resolveCandidate(store, "toko__customerProfiles__profile-t1", "confirm", { characterName: "Test Alpha" });
  const rb = await rollbackBatch(store, "b1");
  assert.ok(rb.keptReferenced.includes(`${M.persons}/person-diner-cus_a`));
  assert.ok(await store.get(M.persons, "person-diner-cus_a"));
  for (const c of await store.list(M.characters)) assert.ok(await store.get(M.persons, c.personId), `孤児Character ${c.id}`);
  for (const l of await store.list(M.sourceLinks)) assert.ok(await store.get(M.persons, l.personId), `孤児Link ${l.id}`);
});
test("m3 空の感謝コメントは空文字で置換、未定義(undefined)だけ未置換として報告", () => {
  const r = renderMacro("A{{thanks_comment}}B{{visit_count}}", { thanks_comment: "", visit_count: undefined });
  assert.equal(r.text, "AB{{visit_count}}"); assert.deepEqual(r.missing, ["visit_count"]);
});
test("m1 FirestoreStoreは本番ID/未指定を拒否", () => {
  assert.throws(() => new FirestoreStore({}, {}, { projectId: "pixies-diner" }), e => e.code === "production-blocked");
  assert.throws(() => new FirestoreStore({}, {}, {}), e => e.code === "project-required");
  assert.doesNotThrow(() => new FirestoreStore({}, {}, { projectId: "demo-x" }));
});
