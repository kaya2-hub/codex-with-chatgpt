import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { snapshotFromTypedDocs, snapshotFromPlainVisits, compareVer, summarize } from "../tools/ver-lib.js";
import { syntheticShops } from "../fixtures/synthetic.js";
import { migratedStore } from "./helpers.js";
import { adoptDinerInfo, appendLegacyTokoNote, candidateSummary, rescanPlan, adoptDinerName } from "../core/adopt.js";
import { applyPlan } from "../tools/migrate-lib.js";
import { MASTER as M } from "../core/collections.js";
import * as Op from "../core/identity-ops.js";

test("VER-01 来店ID単位の比較: 件数合計が同じでも入れ替わりを検出/理由・上書きの変化も検出/IDのみ出力", () => {
  const s = syntheticShops(); const before = snapshotFromPlainVisits(s.dinerVisits);
  assert.equal(compareVer(before, structuredClone(before)).ok, true);
  const swapped = structuredClone(before); // 合計は同じだが ID が入れ替わる
  swapped.vis_1.verCounted = false; swapped.vis_28.verCounted = true;
  const r = compareVer(before, swapped); assert.equal(r.ok, false); assert.equal(r.before.counted, r.after.counted); assert.deepEqual(r.changedIds.sort(), ["vis_1", "vis_28"].sort());
  const reason = structuredClone(before); reason.vis_28.verCountExclusion = "manual_not_counted"; assert.equal(compareVer(before, reason).changedIds.length, 1);
  const ov = structuredClone(before); ov.vis_1.verCountOverride = "not_counted"; assert.equal(compareVer(before, ov).changedIds.length, 1);
  const miss = structuredClone(before); delete miss.vis_1; assert.deepEqual(compareVer(before, miss).missingIds, ["vis_1"]);
  assert.ok(!JSON.stringify(r).includes("Test Alpha"));
  assert.equal(summarize(before).counted, 28); assert.equal(compareVer(before, before, { counted: 28 }).ok, true); assert.equal(compareVer(before, before, { counted: 186 }).ok, false);
});
test("VER: バックアップ(型付き)形式からのスナップショット", () => {
  const docs = new Map([["pixiesVisits/v1", { orderType: { stringValue: "VER" }, verCounted: { booleanValue: true }, verCountExclusion: { stringValue: "" }, verCountOverride: { stringValue: "counted" } }], ["pixiesVisits/v2", { orderType: { stringValue: "A" }, verCounted: { booleanValue: false }, verCountExclusion: { stringValue: "not_ver" } }], ["pixiesCustomers/c1", { customerName: { stringValue: "x" } }]]);
  const sn = snapshotFromTypedDocs(docs); assert.deepEqual(Object.keys(sn), ["v1", "v2"]);
  assert.deepEqual(summarize(sn), { visits: 2, counted: 1, notCounted: 1, notCountedWithReason: 1, overrideCounted: 1, overrideNotCounted: 0, countedNonVer: 0 });
});
test("切替前の取り込み: ダイナー値取込・名前取込・旧備考の明示追記(重複拒否)・再スキャンは冪等・候補要約は内容を含まない", async () => {
  const { store, shops, plan } = await migratedStore();
  const p = await store.get(M.persons, "person-diner-cus_a");
  const diner = { ...shops.dinerCustomers[0], customerNote: "店舗側で更新した備考", xDmUrl: "https://x.example/dm/alpha2" };
  await adoptDinerInfo(store, "person-diner-cus_a", p.revision, diner, ["customerNote", "xDmUrl"], { label: "Kaya" });
  const q = await store.get(M.persons, "person-diner-cus_a"); assert.equal(q.customerNote, "店舗側で更新した備考"); assert.equal(q.xDmUrl, "https://x.example/dm/alpha2");
  await adoptDinerName(store, "char-diner-cus_a", "Test Alpha Renamed", { label: "Kaya" });
  assert.deepEqual((await store.get(M.characters, "char-diner-cus_a")).previousNames, ["Test Alpha"]);
  await appendLegacyTokoNote(store, "person-diner-cus_a", q.revision, "旧備考テキスト", { label: "Kaya" });
  assert.match((await store.get(M.persons, "person-diner-cus_a")).customerNote, /店舗側で更新した備考\n\n【旧常若亭備考】\n旧備考テキスト/);
  const cur = await store.get(M.persons, "person-diner-cus_a");
  await assert.rejects(() => appendLegacyTokoNote(store, "person-diner-cus_a", cur.revision, "旧備考テキスト"), e => e.code === "already");
  const more = { dinerCustomers: [...shops.dinerCustomers, { id: "cus_new", customerName: "Brand New", previousNames: [], xDmUrl: "", customerNote: "" }], tokoProfiles: [...shops.tokoProfiles, { id: "profile-t9", name: "Brand New", notes: "" }] };
  const r1 = await applyPlan(store, rescanPlan(more, "rescan-1")); assert.ok(r1.created >= 3);
  assert.ok(r1.skippedDiffering.length >= 1); // 人が編集済みの文書は触らない
  const links = await store.list(M.sourceLinks); assert.equal(links.find(l => l.sourceId === "profile-t9").linkStatus, "candidate"); // 同名は候補止まり
  const r2 = await applyPlan(store, rescanPlan(more, "rescan-1")); assert.equal(r2.created, 0);
  const persons = await store.list(M.persons), characters = await store.list(M.characters);
  const sm = candidateSummary(links.find(l => l.sourceId === "profile-t1"), { persons, characters }, { toko: { visits: shops.tokoVisits }, diner: { visits: shops.dinerVisits } }, shops.tokoProfiles);
  assert.equal(sm.toko.visits, 4); assert.equal(sm.toko.hasLegacyNote, true); assert.equal(sm.candidates[0].dinerVisits, 14); assert.equal(sm.candidates[0].verStamps, 14);
  assert.ok(!JSON.stringify(sm).includes("旧備考(移行しない)") && !JSON.stringify(sm).includes("x.example"));
});
test("ver-compare CLI: 合格/不合格の終了コード", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-")); const s = syntheticShops();
  const a = path.join(dir, "a.json"), b = path.join(dir, "b.json"), vis = path.join(dir, "v.json");
  fs.writeFileSync(vis, JSON.stringify(s.dinerVisits));
  execFileSync("node", ["tools/ver-compare.mjs", "snapshot", "--json", vis, "--out", a]); fs.copyFileSync(a, b);
  assert.equal(spawnSync("node", ["tools/ver-compare.mjs", "compare", "--before", a, "--after", b, "--expect-counted", "28"]).status, 0);
  const x = JSON.parse(fs.readFileSync(b, "utf8")); x.vis_1.verCounted = false; fs.writeFileSync(b, JSON.stringify(x));
  assert.equal(spawnSync("node", ["tools/ver-compare.mjs", "compare", "--before", a, "--after", b]).status, 1);
});
