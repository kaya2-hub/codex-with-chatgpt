import test from "node:test";
import assert from "node:assert/strict";
import { syntheticShops } from "../fixtures/synthetic.js";
import { dryRun, applyPlan, postCheck, rollbackBatch } from "../tools/migrate-lib.js";
import { verSnapshot, verSnapshotHash } from "../core/identity-plan.js";
import { freshStore } from "./helpers.js";
import { MASTER as M } from "../core/collections.js";

test("DATA-01/08 元IDを保持し、SourceLinkは一意・孤立なし", () => {
  const s = syntheticShops(); const { plan, errors } = dryRun(s, { batchId: "b" });
  assert.deepEqual(errors, []);
  for (const c of s.dinerCustomers) assert.ok(plan.sourceLinks.some(l => l.sourceSystem === "diner" && l.sourceId === c.id && l.linkStatus === "confirmed"));
  for (const p of s.tokoProfiles) assert.ok(plan.sourceLinks.some(l => l.sourceSystem === "toko" && l.sourceId === p.id));
});
test("DATA-02 同名は候補のみ: 推測マージ0、曖昧は全候補列挙", () => {
  const { plan } = dryRun(syntheticShops(), { batchId: "b" });
  const cand = plan.sourceLinks.filter(l => l.linkStatus === "candidate");
  assert.equal(cand.length, 4);
  assert.equal(plan.persons.length, 8); // diner7 + toko-only1。候補ぶんの人物は作らない
  assert.equal(plan.candidates.find(c => c.tokoProfileId === "profile-t4").ambiguous, true);
  assert.equal(plan.candidates.find(c => c.tokoProfileId === "profile-t4").dinerCandidates.length, 2);
  // ワールド名付きでも候補止まり(確定ではない)
  assert.equal(plan.sourceLinks.find(l => l.sourceId === "profile-t1").linkStatus, "candidate");
});
test("DATA-06 旧名は改名と決めつけず legacyNameCandidates に保持、characterIdはnull可", () => {
  const { plan } = dryRun(syntheticShops(), { batchId: "b" });
  const g = plan.characters.find(c => c.currentName === "Test Gamma");
  assert.deepEqual(g.previousNames, []); assert.deepEqual(g.legacyNameCandidates, ["Old Gamma"]);
  assert.equal(plan.sourceLinks.find(l => l.sourceId === "profile-t1").characterId, null);
});
test("常若亭旧備考は移行しない / ダイナー備考とDMは共通Personへ", () => {
  const { plan, report } = dryRun(syntheticShops(), { batchId: "b" });
  assert.equal(report.oldNoteMigrated.fromToko, 0);
  assert.ok(!JSON.stringify(plan).includes("旧備考"));
  assert.equal(plan.persons.find(p => p.id === "person-diner-cus_a").customerNote, "架空メモA");
});
test("VER-01 計画は店舗来店に触れない(入力凍結で実行)", () => {
  const s = syntheticShops(); const before = verSnapshotHash(verSnapshot(s.dinerVisits));
  const { report } = dryRun(s, { batchId: "b" });
  assert.equal(report.verCountedByVisitIdUnchanged, true);
  assert.equal(verSnapshotHash(verSnapshot(s.dinerVisits)), before);
  assert.equal(s.dinerVisits.filter(v => v.verCounted).length, 14 + 6 + 7 + 1 - 0);
});
test("DATA-08 適用は冪等・再実行で重複0・編集済み文書は上書きしない・ロールバック", async () => {
  const store = await freshStore(); const { plan } = dryRun(syntheticShops(), { batchId: "b1", now: "2026-10-11T00:00:00.000Z" });
  const r1 = await applyPlan(store, plan, { chunk: 5 });
  assert.equal(r1.created, plan.persons.length + plan.characters.length + plan.sourceLinks.length);
  const r2 = await applyPlan(store, plan);
  assert.equal(r2.created, 0); assert.equal(r2.skippedDiffering.length, 0);
  assert.deepEqual(await postCheck(store, plan), []);
  // 人手の編集後に再実行しても上書きされない
  const p = await store.get(M.persons, "person-diner-cus_a");
  await store.batch([{ op: "update", col: M.persons, id: "person-diner-cus_a", expectedRevision: p.revision, data: { customerNote: "人が編集" } }]);
  const r3 = await applyPlan(store, plan);
  assert.equal(r3.created, 0); assert.deepEqual(r3.skippedDiffering, [`${M.persons}/person-diner-cus_a`]);
  assert.equal((await store.get(M.persons, "person-diner-cus_a")).customerNote, "人が編集");
  const rb = await rollbackBatch(store, "b1");
  assert.deepEqual(rb.keptEdited, [`${M.persons}/person-diner-cus_a`]);
  assert.equal((await store.list(M.persons)).length, 1);
});
