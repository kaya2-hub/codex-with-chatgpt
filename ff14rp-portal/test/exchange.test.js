import test from "node:test";
import assert from "node:assert/strict";
import { freshStore, migratedStore } from "./helpers.js";
import { validateImport, exportDoc, planImport, applyPlan } from "../core/exchange.js";
import { previewImport, commitImport, setScriptStatus, scriptId, ceremonyFacts } from "../core/exchange-store.js";
import { buildSpec, buildEditPackage } from "../core/exchange-spec.js";
import { sampleEvent, sampleCeremony } from "../core/samples.js";
import { normalizeDoc, updateItem, moveItem, updateFields, newItemId } from "../core/docs.js";
import { normRole, roleJa } from "../core/roles.js";
import { MASTER as M } from "../core/collections.js";
import * as Ce from "../core/ceremony.js";
import { hashOf } from "../core/util.js";

const J = o => JSON.parse(JSON.stringify(o));
async function importEvent(store, json) { const p = await previewImport(store, "event", json); assert.ok(p.ok, JSON.stringify(p.errors)); return commitImport(store, "event", p, {}, { label: "かや" }); }

test("担当者: 英語/日本語の表記ゆれを同じ人物として扱い、表示は日本語", () => {
  for (const v of ["Kaya", "kaya", "かや", "カヤ", "かやさん"]) assert.equal(normRole(v), "Kaya");
  for (const v of ["Toushin", "toushin", "トーシン", "トウシン", "トーシンさん"]) assert.equal(normRole(v), "Toushin");
  assert.equal(normRole("誰か"), null); assert.equal(roleJa("Kaya"), "かや"); assert.equal(roleJa("Toushin"), "トーシン"); assert.equal(roleJa("操作者名"), "操作者名");
});
test("ChatGPT仕様書: 必須の内容(形式・必須/任意/未定・担当ID・タイムライン・マクロ原文・推測禁止・質問・書き出し条件)を含む", () => {
  for (const kind of ["event", "ceremony"]) {
    const t = buildSpec(kind);
    for (const w of ["schema", "version", "必須", "任意", "未定", "Kaya", "Toushin", "かや", "トーシン", "timeline", "原文", "推測", "質問", "これでOK", "書き出して", ".json", "```json", "/yell", "<t>", "15行", "facts"]) assert.ok(t.includes(w), `${kind}: 「${w}」が仕様書にない`);
  }
  assert.ok(buildSpec("event").includes("22:55頃") && buildSpec("ceremony").includes("実施済み"));
  const pkg = buildEditPackage("event", exportDoc("event", { id: "evo-1", name: "x", revision: 2 })); assert.ok(pkg.includes("現在のデータ") && pkg.includes('"_base"'));
});
test("サンプル(イベント/セレモニー)は検証に合格する", () => {
  assert.equal(validateImport(sampleEvent(), "event").ok, true); assert.equal(validateImport(JSON.stringify(sampleCeremony()), "ceremony").ok, true);
});
test("不正なJSONを安全に拒否し、問題の場所を示す(保存されない)", async () => {
  const store = await freshStore();
  const bad = (mut, expectPath) => { const j = J(sampleEvent()); mut(j); const v = validateImport(j, "event"); assert.equal(v.ok, false); assert.ok(v.errors.some(e => e.path.includes(expectPath)), `${expectPath}: ${JSON.stringify(v.errors)}`); };
  assert.equal(validateImport("{ not json", "event").ok, false);
  assert.equal(validateImport("[1,2]", "event").ok, false);
  bad(j => { j.schema = "other"; }, "schema"); bad(j => { j.version = 99; }, "version"); bad(j => { delete j.event.name; }, "event.name");
  bad(j => { j.event.timeline.steps[0].kaya[0].type = "yell"; }, "steps[0].kaya[0].type"); bad(j => { j.event.macros[0].role = "他人"; }, "macros[0].role");
  bad(j => { j.event.date = "2026-13-40"; }, "event.date"); bad(j => { j.event.store = "moon"; }, "event.store"); bad(j => { j.event.timeline.steps[1].id = "s-1"; }, "id");
  bad(j => { j.event.timeline.steps[0].cue[0].text = 5; }, "text"); bad(j => { j.event.macros[0].body = ""; }, "body"); bad(j => { j.op = "update"; }, "target.occurrenceId");
  assert.equal(validateImport(sampleCeremony(), "event").ok, false); // 種別違い
  const j = J(sampleEvent()); j.event.surprise = 1; j.facts = { x: 1 }; const v = validateImport(j, "event"); assert.ok(v.ok && v.warnings.length === 2); assert.ok(!("surprise" in v.data));
  assert.equal((await store.list(M.eventOccurrences)).length, 0);
  const p = await previewImport(store, "event", { ...J(sampleEvent()), op: "update", target: { occurrenceId: "nope" } }); assert.equal(p.ok, false);
});
test("イベント全体を一括新規登録(下書き・ID付与・マクロ原文/時刻表現/複雑な掛け合いを保持)", async () => {
  const store = await freshStore(); const src = sampleEvent();
  const { id } = await importEvent(store, src);
  const o = await store.get(M.eventOccurrences, id); assert.equal(o.status, "draft"); assert.equal(o.masterId, null);
  assert.equal(o.macros[0].body, src.event.macros[0].body); assert.equal(o.macros[0].role, "Kaya"); // かや→内部ID
  const steps = o.timeline.steps; assert.deepEqual(steps.map(s => s.time), ["22:00", "22:50", "22:55頃", "23時になったら"]);
  assert.equal(steps[3].kaya.length, 4); assert.equal(steps[3].kaya[2].type, "action"); assert.equal(steps[3].kaya[3].type, "change"); assert.equal(steps[3].toushin[0].text, "「面白い話…！？」");
  assert.equal(steps[1].kaya[0].text, src.event.timeline.steps[1].kaya[0].text); assert.equal(steps[2].toushin[1].type, "change");
  assert.equal(o.venue, src.event.venue); assert.deepEqual(o.prep, src.event.prep); assert.equal(o.history[0].change, "import:create");
});
test("未定の下書き(最小項目)も登録でき、取り込みだけで開催状態は変わらない", async () => {
  const store = await freshStore(); const { id } = await importEvent(store, { schema: "ff14rp.event", version: 1, event: { name: "未定のイベント", date: null } });
  const o = await store.get(M.eventOccurrences, id); assert.equal(o.status, "draft"); assert.equal(o.date, null);
  const j = exportDoc("event", { ...o, id }); j.event.date = "2020-01-01"; const p = await previewImport(store, "event", j); await commitImport(store, "event", p, {});
  assert.equal((await store.get(M.eventOccurrences, id)).status, "draft"); // 過去日でもheld/scheduledにならない
});
test("書き出し→再取り込みで差分なし(往復)・編集用パッケージにIDと_baseを含む", async () => {
  const store = await freshStore(); const { id } = await importEvent(store, sampleEvent());
  const raw = await store.get(M.eventOccurrences, id); const exp = exportDoc("event", { ...raw, id });
  const p = await previewImport(store, "event", exp); assert.ok(p.ok); assert.equal(p.plan.changes.length, 0);
  assert.deepEqual(exp.event.timeline.steps.map(s => s.id), raw.timeline.steps.map(s => s.id)); assert.ok(exp._base.revision >= 1);
});
test("既存イベントをJSONから差分更新: 変えた箇所だけ反映され、他の項目は不変・履歴に記録", async () => {
  const store = await freshStore(); const { id } = await importEvent(store, sampleEvent());
  const raw = await store.get(M.eventOccurrences, id); const exp = exportDoc("event", { ...raw, id });
  exp.event.timeline.steps[2].time = "22:50頃"; exp.event.macros[0].body += "\n/s 追記行"; exp.event.macros.push({ title: "新マクロ", role: "トーシン", body: "/s 新" }); exp.event.timeline.steps.splice(1, 1);
  const p = await previewImport(store, "event", exp);
  assert.deepEqual(p.plan.changes.map(c => c.key).sort(), [`add:macros:${p.plan.changes.find(c => c.kind === "item-add").itemId}`, `edit:macros:${raw.macros[0].id}`, `edit:steps:${raw.timeline.steps[2].id}`, `remove:steps:${raw.timeline.steps[1].id}`].sort());
  assert.ok(p.plan.changes.every(c => !c.conflict));
  await commitImport(store, "event", p, {}, { label: "トーシン" });
  const after = await store.get(M.eventOccurrences, id);
  assert.equal(after.timeline.steps.length, 3); assert.equal(after.timeline.steps[1].time, "22:50頃"); assert.ok(after.macros[0].body.endsWith("/s 追記行")); assert.equal(after.macros.length, 2);
  assert.equal(after.venue, raw.venue); assert.deepEqual(after.timeline.steps[2], raw.timeline.steps[3]); assert.equal(after.name, raw.name); // 変更していない項目は完全に不変
  assert.ok(after.history.at(-1).change.startsWith("import:update"));
  // 選択適用: 追加だけ採用しない
  const p2 = await previewImport(store, "event", { ...exportDoc("event", { ...after, id }), event: { macros: [...exportDoc("event", { ...after, id }).event.macros, { title: "もう1つ", role: "かや", body: "/s x" }] } });
  const addKey = p2.plan.changes[0].key; await commitImport(store, "event", p2, { [addKey]: false }).catch(e => assert.equal(e.code, "nothing"));
});
test("別々の利用者の編集の衝突: 同じ項目は競合・別の項目は自動マージ・他者の追加は保持・書出し後の更新を検知", async () => {
  const store = await freshStore(); const { id } = await importEvent(store, sampleEvent());
  const raw0 = await store.get(M.eventOccurrences, id);
  const kaya = exportDoc("event", { ...raw0, id }), toushin = exportDoc("event", { ...raw0, id });  // 同じ時点の書き出しを二人が持つ
  const s1 = raw0.timeline.steps[0].id, s2 = raw0.timeline.steps[1].id;
  kaya.event.timeline.steps[0].kaya[0].text = "かや版の入店対応"; kaya.event.macros[0].title = "かやが改名";
  const pk = await previewImport(store, "event", kaya); assert.ok(pk.plan.changes.every(c => !c.conflict)); await commitImport(store, "event", pk, {});
  // トーシン: 同じステップを変更(競合)+別のステップを変更(自動)+かやが変えたマクロはそのまま(維持)+新規追加
  toushin.event.timeline.steps[0].kaya[0].text = "トーシン版の入店対応"; toushin.event.timeline.steps[1].toushin = [{ type: "say", text: "別ステップの変更" }];
  toushin.event.materials.push({ label: "追加資料", url: "https://example.com/new" });
  const pt = await previewImport(store, "event", toushin);
  const byKey = Object.fromEntries(pt.plan.changes.map(c => [c.key, c]));
  assert.equal(byKey[`edit:steps:${s1}`].conflict, true); assert.equal(byKey[`edit:steps:${s2}`].conflict, false);
  assert.ok(!pt.plan.changes.some(c => c.key.startsWith("edit:macros"))); // かやの改名は消えない(ChatGPT未変更の項目は他者の編集を維持)
  assert.ok(pt.plan.notes.some(n => n.includes("更新されています")));
  await commitImport(store, "event", pt, {}); // 既定: cleanは採用・conflictは現在値(かや版)を維持
  let a = await store.get(M.eventOccurrences, id); assert.equal(a.timeline.steps[0].kaya[0].text, "かや版の入店対応"); assert.equal(a.timeline.steps[1].toushin[0].text, "別ステップの変更"); assert.equal(a.macros[0].title, "かやが改名"); assert.equal(a.materials.length, 2);
  // 競合を「取り込み側を採用」に
  const pt2 = await previewImport(store, "event", toushin); const ck = `edit:steps:${s1}`;
  assert.ok(pt2.plan.changes.find(c => c.key === ck).conflict); await commitImport(store, "event", pt2, { [ck]: true });
  a = await store.get(M.eventOccurrences, id); assert.equal(a.timeline.steps[0].kaya[0].text, "トーシン版の入店対応");
  // プレビュー後に更新されたら保存を拒否
  const p3 = await previewImport(store, "event", exportDoc("event", { ...a, id, revision: a.revision })); p3.plan.changes.length || (p3.data.name = "変更"); const p3b = await previewImport(store, "event", { ...exportDoc("event", { ...a, id }), event: { name: "名前変更" } });
  await updateFields(store, "event", id, { venue: "別会場" }, { label: "かや" });
  await assert.rejects(() => commitImport(store, "event", p3b, {}), e => e.code === "conflict");
});
test("他者が変更した項目をChatGPTが削除した場合は競合・他者が追加した項目は削除扱いにしない", async () => {
  const store = await freshStore(); const { id } = await importEvent(store, sampleEvent());
  const raw0 = await store.get(M.eventOccurrences, id); const mine = exportDoc("event", { ...raw0, id }); const mid = raw0.macros[0].id;
  await updateItem(store, "event", id, "macros", mid, { title: "他者が編集", role: "Kaya", body: "/s 他者", note: "" }, { label: "かや" });
  await updateItem(store, "event", id, "materials", newItemId("materials"), { label: "他者の追加資料", url: "", note: "" }, { label: "かや" });
  mine.event.macros = []; mine.event.materials = mine.event.materials.slice(0, 1);
  const p = await previewImport(store, "event", mine); const rm = p.plan.changes.find(c => c.key === `remove:macros:${mid}`); assert.equal(rm.conflict, true);
  assert.ok(!p.plan.changes.some(c => c.key.startsWith("remove:materials"))); assert.ok(p.plan.notes.some(n => n.includes("他の人が追加")));
});
test("ベース情報(_base)がない取り込みでも差分を表示し、注意を出す", async () => {
  const store = await freshStore(); const { id } = await importEvent(store, sampleEvent()); const raw = await store.get(M.eventOccurrences, id);
  const j = exportDoc("event", { ...raw, id }); delete j._base; j.event.name = "名前だけ変更"; const p = await previewImport(store, "event", j);
  assert.deepEqual(p.plan.changes.map(c => c.key), ["field:name"]); assert.ok(p.plan.notes.some(n => n.includes("_base")));
});
test("一箇所だけの手動編集(項目単位)は他の項目を変えず、同時編集は検出される・並べ替え・追加・削除", async () => {
  const store = await freshStore(); const { id } = await importEvent(store, sampleEvent()); const before = await store.get(M.eventOccurrences, id);
  const stepId = before.timeline.steps[2].id; const base = hashOf(normalizeDoc("event", before).timeline.steps[2]);
  const step = { ...normalizeDoc("event", before).timeline.steps[2], time: "22:56頃" };
  await updateItem(store, "event", id, "steps", stepId, step, { baseHash: base, label: "かや" });
  const after = await store.get(M.eventOccurrences, id); assert.equal(after.timeline.steps[2].time, "22:56頃");
  assert.deepEqual(after.timeline.steps.filter(s => s.id !== stepId), before.timeline.steps.filter(s => s.id !== stepId)); assert.equal(after.name, before.name); assert.deepEqual(after.macros, before.macros);
  await assert.rejects(() => updateItem(store, "event", id, "steps", stepId, { ...step, time: "別の人" }, { baseHash: base, label: "トーシン" }), e => e.code === "conflict");
  await moveItem(store, "event", id, "steps", stepId, -1, { label: "かや" }); assert.equal((await store.get(M.eventOccurrences, id)).timeline.steps[1].id, stepId);
  await updateItem(store, "event", id, "steps", stepId, null, { label: "かや" }); assert.equal((await store.get(M.eventOccurrences, id)).timeline.steps.length, 3);
  const nid = newItemId("steps"); await updateItem(store, "event", id, "steps", nid, { time: "24:00", phase: "", cue: [], kaya: [], toushin: [], note: "" }, { afterId: before.timeline.steps[0].id, label: "かや" });
  assert.equal((await store.get(M.eventOccurrences, id)).timeline.steps[1].id, nid);
  await assert.rejects(() => updateFields(store, "event", id, { venue: "x" }, { baseValues: { venue: "古い値" } }), e => e.code === "conflict"); await assert.rejects(() => updateFields(store, "event", id, { status: "held" }), e => e.code === "bad-field");
});
test("旧データ(ルールベースの3列/未分類・IDなしマクロ)を失わず閲覧でき、編集すると新形式へ変換され旧データも退避される", async () => {
  const store = await freshStore();
  await store.batch([{ op: "create", col: M.eventOccurrences, id: "evo-legacy", data: { name: "旧イベント", store: "toko", date: null, status: "held", masterId: "m", overview: "旧", macros: [{ title: "旧マクロ", role: "Toushin", body: "/yell 旧 <t>\n/wait 1" }], timeline: { rows: [{ phase: "導入", kaya: "挨拶", cue: "合図", toushin: "返事" }], unclassified: [{ text: "分類不能な行", phase: "導入" }], sourceText: "原文全体" }, materials: [{ label: "資料", url: "https://example.com" }], memo: "反省", history: [] } }]);
  const raw = await store.get(M.eventOccurrences, "evo-legacy"); const d = normalizeDoc("event", raw);
  assert.equal(d.timeline.steps.length, 2); assert.equal(d.timeline.steps[0].kaya[0].text, "挨拶"); assert.equal(d.timeline.steps[1].cue[0].text, "分類不能な行"); assert.equal(d.macros[0].role, "Toushin"); assert.equal(d.memo, "反省");
  const exp = exportDoc("event", { ...raw, id: "evo-legacy" }); assert.equal(exp.event.retrospective, "反省"); assert.equal(exp.event.macros[0].body, "/yell 旧 <t>\n/wait 1");
  const p = await previewImport(store, "event", exp); assert.equal(p.plan.changes.length, 0);
  await updateItem(store, "event", "evo-legacy", "steps", d.timeline.steps[0].id, { ...d.timeline.steps[0], time: "21:00" }, { label: "かや" });
  const after = await store.get(M.eventOccurrences, "evo-legacy"); assert.equal(after.timeline.version, 2); assert.equal(after.timelineLegacy.sourceText, "原文全体"); assert.equal(after.status, "held"); assert.equal(after.macros[0].body, raw.macros[0].body);
});
test("セレモニー原稿: ChatGPT取り込みで作成でき、完成/実施済みにならない・Ver/来店記録/実施記録に触れない・重複作成は拒否", async () => {
  const { store } = await migratedStore();
  await Ce.recordPerformance(store, { personId: "person-diner-cus_a", stampValue: 7, storeId: "diner", businessDate: "2026-10-11", act: "gg", label: "かや" });
  const recsBefore = JSON.stringify(await store.list(M.ceremonyRecords)); const personBefore = JSON.stringify(await store.get(M.persons, "person-diner-cus_a"));
  const src = sampleCeremony(); src.target.personId = "person-diner-cus_a"; src.target.stampValue = 14; src.facts = { totalVisitCount: 9999, verStamps: 9999 };
  const p = await previewImport(store, "ceremony", src); assert.ok(p.ok); assert.ok(p.warnings.some(w => w.path === "facts"));
  const r = await commitImport(store, "ceremony", p, {}, { label: "かや" }); assert.equal(r.id, scriptId("person-diner-cus_a", 14));
  const s = await store.get(M.ceremonyScripts, r.id); assert.equal(s.scriptStatus, "draft"); assert.equal(s.macros[0].role, "Kaya"); assert.equal(s.thanks, src.ceremony.thanks); assert.ok(!("verStamps" in s) && !("totalVisitCount" in s));
  assert.equal(JSON.stringify(await store.list(M.ceremonyRecords)), recsBefore); assert.equal(JSON.stringify(await store.get(M.persons, "person-diner-cus_a")), personBefore);
  assert.equal(Ce.ceremonyStatus({ personId: "person-diner-cus_a", verStamps: 14 }, await store.list(M.ceremonyRecords)).map(x => x.status).join(), "done,reached_pending"); // 14は未実施のまま
  assert.equal((await previewImport(store, "ceremony", src)).ok, false); // 既存を無断上書きしない
  await setScriptStatus(store, r.id, "complete", { label: "かや" }); assert.equal((await store.get(M.ceremonyScripts, r.id)).scriptStatus, "complete");
  assert.equal((await store.list(M.ceremonyRecords)).length, 1); // 完成にしても実施記録は増えない
  const exp = exportDoc("ceremony", { ...(await store.get(M.ceremonyScripts, r.id)) }, { target: { personId: "person-diner-cus_a", stampValue: 14 }, facts: ceremonyFacts({ names: ["x"], total: null, verStamps: 14, stampValue: 14 }) });
  assert.equal(exp.facts.totalVisitCount, "不明"); assert.ok(!JSON.stringify(exp).includes("xDmUrl") && !JSON.stringify(exp).includes("customerNote"));
  exp.ceremony.thanks = "更新版の感謝"; const up = await previewImport(store, "ceremony", exp); assert.equal(up.plan.changes.length, 1); await commitImport(store, "ceremony", up, {});
  assert.equal((await store.get(M.ceremonyScripts, r.id)).scriptStatus, "complete"); // 取り込みで完成状態は変わらない
  assert.equal((await previewImport(store, "ceremony", { ...src, target: { personId: "nobody", stampValue: 7 } })).ok, false);
});

import fs from "node:fs"; import path from "node:path";
import { outputs } from "../tools/gen-spec-docs.mjs";
test("docs/samples(仕様書・サンプルJSON)がコードと一致している(node tools/gen-spec-docs.mjs で再生成)", () => {
  for (const [f, t] of Object.entries(outputs())) assert.equal(fs.readFileSync(path.join("docs", f), "utf8"), t, `${f} が古い`);
});

test("[監査] 新規IDの衝突は競合/ベースなしの削除は既定オフ/timelineのsteps省略は拒否/ID衝突の誤判定なし", async () => {
  const store = await freshStore(); const { id } = await importEvent(store, sampleEvent());
  const raw0 = await store.get(M.eventOccurrences, id);
  const a = exportDoc("event", { ...raw0, id }), b = exportDoc("event", { ...raw0, id });
  a.event.macros.push({ id: "m-2", title: "Aが追加", role: "かや", body: "/s A" }); b.event.macros.push({ id: "m-2", title: "Bが追加", role: "トーシン", body: "/s B" });
  await commitImport(store, "event", await previewImport(store, "event", a), {});
  const pb = await previewImport(store, "event", b); const ch = pb.plan.changes.find(c => c.key === "edit:macros:m-2"); assert.equal(ch.conflict, true); assert.match(ch.reason, /ID衝突/);
  await assert.rejects(() => commitImport(store, "event", pb, {}), e => e.code === "nothing"); assert.equal((await store.get(M.eventOccurrences, id)).macros.find(m => m.id === "m-2").title, "Aが追加"); // 既定は現在値を維持(競合は選ばない限り反映されない)
  // ベース情報なし: 削除は既定でオフ(チェックしなければ消えない)
  const nb = { schema: "ff14rp.event", version: 1, op: "update", target: { occurrenceId: id }, event: { macros: [{ title: "これだけ", role: "かや", body: "/s x" }] } };
  const pn = await previewImport(store, "event", nb); assert.ok(pn.plan.changes.filter(c => c.kind === "item-remove").every(c => c.defaultOff));
  const before = (await store.get(M.eventOccurrences, id)).macros.length; await commitImport(store, "event", pn, {}); const after = await store.get(M.eventOccurrences, id);
  assert.equal(after.macros.length, before + 1); // 追加だけ反映され、既存マクロは削除されない
  assert.equal(validateImport({ ...sampleEvent(), event: { name: "x", timeline: {} } }, "event").ok, false); // steps省略=全削除と区別できないため拒否
  assert.equal(validateImport({ ...sampleEvent(), event: { ...sampleEvent().event, date: "2026-02-31" } }, "event").ok, false);
  const badBase = exportDoc("event", { ...after, id }); badBase._base.items = "x"; const vb = validateImport(badBase, "event"); assert.equal(vb.ok, false); assert.ok(vb.errors.some(e => e.path === "_base"));
  const odd = exportDoc("event", { ...after, id }); odd.event.macros.push({ id: "constructor", title: "t", role: "かや", body: "/s" }); assert.ok((await previewImport(store, "event", odd)).ok);
});
test("[監査] 取り込み先の取り違えを拒否(別イベントのJSON/新規画面へのupdate/別原稿)", async () => {
  const store = await freshStore(); const { id: A } = await importEvent(store, sampleEvent()); const { id: B } = await importEvent(store, { ...sampleEvent(), event: { ...sampleEvent().event, name: "別イベント" } });
  const forB = exportDoc("event", { ...(await store.get(M.eventOccurrences, B)), id: B });
  const r1 = await previewImport(store, "event", forB, A); assert.equal(r1.ok, false); assert.match(r1.errors[0].message, /別のイベント/);
  assert.equal((await previewImport(store, "event", forB, B)).ok, true); assert.equal((await previewImport(store, "event", forB, "new")).ok, false); assert.equal((await previewImport(store, "event", sampleEvent(), A)).ok, false);
  assert.equal((await previewImport(store, "event", sampleEvent(), "new")).ok, true);
  const { store: cs } = await migratedStore(); const cj = sampleCeremony(); cj.target = { personId: "person-diner-cus_a", stampValue: 7 };
  assert.equal((await previewImport(cs, "ceremony", cj, scriptId("person-diner-cus_a", 14))).ok, false); assert.equal((await previewImport(cs, "ceremony", cj, scriptId("person-diner-cus_a", 7))).ok, true);
});
test("[監査] 開催済みの編集は編集前の内容を履歴に残す/複製は全項目をコピー/削除は同時編集を検出/未知の担当は保持", async () => {
  const store = await freshStore(); const { id } = await importEvent(store, sampleEvent());
  let o = await store.get(M.eventOccurrences, id); await store.batch([{ op: "update", col: M.eventOccurrences, id, expectedRevision: o.revision, data: { status: "held" } }]);
  const before = (await store.get(M.eventOccurrences, id)).venue; await updateFields(store, "event", id, { venue: "変更後" }, { label: "かや" });
  const h = (await store.get(M.eventOccurrences, id)).history.at(-1); assert.equal(h.before.venue, before);
  const { duplicateOccurrence } = await import("../core/events.js"); const d = await store.get(M.eventOccurrences, await duplicateOccurrence(store, id));
  const src = await store.get(M.eventOccurrences, id); for (const f of ["venue", "startTime", "endTime", "plan", "staff", "prep", "cautions", "macros", "timeline", "materials"]) assert.deepEqual(d[f], src[f], f); assert.equal(d.status, "draft"); assert.equal(d.date, null);
  const m = normalizeDoc("event", src).macros[0]; await updateItem(store, "event", id, "macros", m.id, { ...m, title: "他者が編集" }, { label: "トーシン" });
  await assert.rejects(() => updateItem(store, "event", id, "macros", m.id, null, { baseHash: hashOf(m), label: "かや" }), e => e.code === "conflict"); // 古い画面からの削除は拒否
  await updateItem(store, "event", id, "macros", "legacy-role", { title: "旧", role: "操作者名", body: "/s", note: "" }, { label: "かや" });
  assert.equal(normalizeDoc("event", await store.get(M.eventOccurrences, id)).macros.find(x => x.id === "legacy-role").role, "操作者名");
});
