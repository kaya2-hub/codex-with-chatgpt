import test from "node:test";
import assert from "node:assert/strict";
import { freshStore } from "./helpers.js";
import * as Ev from "../core/events.js";
import * as Ce from "../core/ceremony.js";
import { ceremonyUnits } from "../core/aggregate.js";
import { renderMacro, analyzeMacro, copyText, macroVariables } from "../core/macro.js";
import { parseTimeline, finalizeTimeline } from "../core/timeline.js";
import { MASTER as M } from "../core/collections.js";

const GG = "/yell 今日の主役は <t>さん！\n/s  ⚑ 特殊記号　全角スペース ♡\n\n/wait 3\n/s {{customer_name}}さん {{stamp_count}}スタンプ達成！\n";

test("MAC-01 マクロ原文: 行順/改行/<t>/特殊文字を保持、変数だけ置換、未定義は報告", () => {
  assert.equal(copyText(GG), GG);
  const r = renderMacro(GG, { customer_name: "テスト太郎", stamp_count: 7 });
  assert.equal(r.text, GG.replace("{{customer_name}}", "テスト太郎").replace("{{stamp_count}}", "7"));
  assert.ok(r.text.includes("<t>") && r.text.includes("\n\n/wait 3"));
  const r2 = renderMacro(GG, { customer_name: "A" });
  assert.deepEqual(r2.missing, ["stamp_count"]); assert.ok(r2.text.includes("{{stamp_count}}"));
  assert.deepEqual(macroVariables(GG), ["customer_name", "stamp_count"]);
});
test("マクロ15行超は警告のみで切り詰めない", () => {
  const long = Array.from({ length: 20 }, (_, i) => `/s l${i}`).join("\n");
  const a = analyzeMacro(long); assert.equal(a.warnings.length, 1);
  assert.equal(copyText(long), long);
});
test("EVT-04 自由文→3列: 抽出・未分類保持・推測しない", () => {
  const text = "■オープニング\nKaya: 乾杯の挨拶\n[00:30]\nToushin: 照明を落とす\n共通: 全員着席後\nKaya｜合図あり｜Toushin返答\n謎の行\n";
  const t = parseTimeline(text);
  assert.equal(t.rows.length, 5);
  assert.equal(t.rows[0].phase, "オープニング"); assert.equal(t.rows[0].kaya, "乾杯の挨拶");
  assert.equal(t.rows[1].cue, "00:30"); assert.equal(t.rows[2].toushin, "照明を落とす");
  assert.equal(t.rows[4].cue, "合図あり");
  assert.deepEqual(t.unclassified.map(u => u.text), ["謎の行"]);
  assert.equal(t.sourceText, text);
  assert.equal(finalizeTimeline(t).ok, false);
  assert.equal(finalizeTimeline(t, { acceptUnclassified: true }).ok, true);
});
test("EVT-01〜03 開催状況・スナップショット・複製", async () => {
  const store = await freshStore();
  const mid = await Ev.createMaster(store, { name: "テストイベント", store: "diner", overview: "v1", macros: [{ title: "開幕", role: "Kaya", body: GG }] });
  const oid = await Ev.createOccurrence(store, mid, { date: "2020-01-01" });
  // 過去日でもheldにならない
  let o = await store.get(M.eventOccurrences, oid);
  assert.equal(o.status, "draft"); assert.equal(Ev.isPastDate(o, "2026-10-11"), true);
  await Ev.setStatus(store, oid, "scheduled", o.revision, { label: "Kaya" });
  o = await store.get(M.eventOccurrences, oid); assert.equal(o.status, "scheduled");
  await assert.rejects(() => Ev.setStatus(store, oid, "draft", 99), e => e.code === "conflict");
  await assert.rejects(() => Ev.setStatus(store, oid, "cancelled", o.revision).then(() => Ev.setStatus(store, oid, "held", o.revision + 1)), e => e.code === "bad-transition");
  // マスター編集は開催回に影響しない
  const m = await store.get(M.eventMasters, mid);
  await store.batch([{ op: "update", col: M.eventMasters, id: mid, expectedRevision: m.revision, data: { overview: "v2", macros: [] } }]);
  const o2 = await store.get(M.eventOccurrences, oid);
  assert.equal(o2.overview, "v1"); assert.equal(o2.macros[0].body, GG);
  // 複製
  const did = await Ev.duplicateOccurrence(store, oid);
  const d = await store.get(M.eventOccurrences, did);
  assert.equal(d.status, "draft"); assert.equal(d.date, null); assert.equal(d.copiedFrom, oid); assert.equal(d.macros[0].body, GG);
  assert.equal((await store.get(M.eventOccurrences, oid)).status, "cancelled");
});
test("held後の編集は履歴(before)を残す/アーカイブ検索/本日の予定は登録済みのみ", async () => {
  const store = await freshStore();
  const mid = await Ev.createMaster(store, { name: "祭", store: "toko" });
  const oid = await Ev.createOccurrence(store, mid, { date: "2026-09-01" });
  let o = await store.get(M.eventOccurrences, oid);
  await Ev.setStatus(store, oid, "scheduled", o.revision); o = await store.get(M.eventOccurrences, oid);
  await Ev.setStatus(store, oid, "held", o.revision); o = await store.get(M.eventOccurrences, oid);
  await Ev.editOccurrence(store, oid, o.revision, { memo: "反省点" }, { label: "Kaya" });
  const e = await store.get(M.eventOccurrences, oid);
  assert.equal(e.history.at(-1).change, "post-held-edit"); assert.equal(e.history.at(-1).before.memo, "");
  const all = await store.list(M.eventOccurrences);
  assert.equal(Ev.searchArchive(all, { store: "toko", year: 2026 }).length, 1);
  assert.equal(Ev.searchArchive(all, { store: "diner" }).length, 0);
  assert.equal(Ev.todaysOccurrences(all, "2026-09-02").length, 0);
});
test("CER-01 7スタンプ到達は来店回数と別: Ver14=2回分、来店だけ多くても0", () => {
  assert.deepEqual(ceremonyUnits(14), [7, 14]); assert.deepEqual(ceremonyUnits(6), []);
  assert.deepEqual(ceremonyUnits(0), []);
});
test("CER-02/03 抽選は営業回で最初の1件のみ決定、実施記録は一意でコピーでは完了しない", async () => {
  const store = await freshStore();
  const a = await Ce.recordDraw(store, { storeId: "diner", businessDate: "2026-10-11", act: "gg", personId: "p1", label: "Kaya" });
  const b = await Ce.recordDraw(store, { storeId: "diner", businessDate: "2026-10-11", act: "monster", personId: "p2", label: "Kaya" });
  assert.equal(a.decided, true); assert.equal(b.decided, false); assert.equal(b.draw.act, "gg");
  assert.equal(await Ce.actForTarget(store, "diner", "2026-10-11"), "gg");
  assert.equal(await Ce.actForTarget(store, "diner", "2026-10-18"), null);
  // マクロをレンダー/コピーしても記録は増えない
  renderMacro(GG, { customer_name: "x", stamp_count: 7 });
  let recs = await store.list(M.ceremonyRecords); assert.equal(recs.length, 0);
  assert.equal(Ce.ceremonyStatus({ personId: "p1", verStamps: 7 }, recs)[0].status, "reached_pending");
  await Ce.recordPerformance(store, { personId: "p1", stampValue: 7, storeId: "diner", businessDate: "2026-10-11", act: "gg", label: "Kaya" });
  recs = await store.list(M.ceremonyRecords);
  assert.equal(Ce.ceremonyStatus({ personId: "p1", verStamps: 7 }, recs)[0].status, "done");
  await assert.rejects(() => Ce.recordPerformance(store, { personId: "p1", stampValue: 7, storeId: "diner", businessDate: "2026-10-18", act: "gg", label: "Toushin" }), e => e.code === "duplicate");
  // 14到達は別の達成単位
  assert.equal(Ce.ceremonyStatus({ personId: "p1", verStamps: 14 }, recs).map(x => x.status).join(), "done,reached_pending");
});
test("CER 持ち越しは実施済みにならない/MAC-02 演目の完成状態を区別", async () => {
  const store = await freshStore();
  await Ce.recordPerformance(store, { personId: "p9", stampValue: 7, storeId: "toko", businessDate: "2026-10-11", act: "monster", status: "carried", label: "Kaya" });
  const recs = await store.list(M.ceremonyRecords);
  assert.equal(Ce.ceremonyStatus({ personId: "p9", verStamps: 7 }, recs)[0].status, "carried");
  assert.equal(Ce.ACTS.gg.state, "complete"); assert.equal(Ce.ACTS.monster.state, "draft"); assert.equal(Ce.ACTS.darts.state, "draft");
  assert.equal(recs[0].actStateAtRecord, "draft");
});

import { buildHistory } from "../core/history.js";
import { buildIndex } from "../core/aggregate.js";
import { migratedStore } from "./helpers.js";
import * as Op from "../core/identity-ops.js";
test("SHOP-03 横断履歴: 当時の名称/単価/数量を原文のまま表示し、確定リンクだけ含む", async () => {
  const { store, shops } = await migratedStore();
  const idx = async () => buildIndex({ persons: await store.list(M.persons), characters: await store.list(M.characters), links: await store.list(M.sourceLinks) });
  const shop = { diner: { visits: shops.dinerVisits }, toko: { visits: shops.tokoVisits, sessionCustomers: shops.tokoSessionCustomers, items: shops.tokoItems } };
  let h = buildHistory((await idx()).get("person-diner-cus_a"), shop);
  assert.equal(h.filter(r => r.shop === "toko").length, 0); // 候補は未確定→含めない
  await Op.resolveCandidate(store, "toko__customerProfiles__profile-t1", "confirm", { characterName: "Test Alpha" });
  h = buildHistory((await idx()).get("person-diner-cus_a"), shop);
  assert.equal(h.filter(r => r.shop === "diner").length, 14);
  assert.ok(h.some(r => r.shop === "toko" && r.text === "架空紅茶 ×2 @300"));
  assert.ok(h.every((r, i) => i === 0 || h[i - 1].date >= r.date));
});

import { detectDrift } from "../core/drift.js";
test("二重正本検出: ダイナー側の備考/DMが共通と異なれば検出(値は返さず自動同期もしない)", async () => {
  const { store, shops } = await migratedStore();
  const e = buildIndex({ persons: await store.list(M.persons), characters: await store.list(M.characters), links: await store.list(M.sourceLinks) }).get("person-diner-cus_a");
  assert.deepEqual(detectDrift(e, shops.dinerCustomers), []);
  const changed = shops.dinerCustomers.map(c => c.id === "cus_a" ? { ...c, customerNote: "店舗側で編集" } : c);
  const d = detectDrift(e, changed);
  assert.deepEqual(d.map(x => x.fields), [["customerNote"]]);
  assert.equal(JSON.stringify(d).includes("店舗側で編集"), false);
  assert.equal(detectDrift(e, null), null);
});
