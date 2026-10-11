// Verスタンプ(verCounted/対象外理由/手動上書き)の来店ID単位スナップショットと比較。氏名・備考・DMは扱わない。
const sv = f => (f && typeof f === "object" ? (f.stringValue ?? "") : (f ?? ""));
const bv = f => (f && typeof f === "object" ? f.booleanValue === true : f === true);

export function snapshotFromTypedDocs(docs) { // docs: Map(path -> typed fields)  (バックアップ形式)
  const snap = {};
  for (const [p, f] of docs) { const m = p.match(/^pixiesVisits\/([^/]+)$/); if (!m) continue;
    snap[m[1]] = { orderType: sv(f.orderType), verCounted: bv(f.verCounted), verCountExclusion: sv(f.verCountExclusion), verCountOverride: sv(f.verCountOverride) }; }
  return snap;
}
export function snapshotFromPlainVisits(visits) { // visits: [{id, orderType, verCounted, ...}]
  if (visits.some(v => !(v.id ?? v.visitId))) throw new Error("来店IDのない行があります(id または visitId が必要)");
  return Object.fromEntries(visits.map(v => [v.id ?? v.visitId, { orderType: v.orderType ?? "", verCounted: v.verCounted === true, verCountExclusion: v.verCountExclusion ?? "", verCountOverride: v.verCountOverride ?? "" }]));
}
export function summarize(snap) {
  const v = Object.values(snap);
  return { visits: v.length, counted: v.filter(x => x.verCounted).length, notCounted: v.filter(x => !x.verCounted).length,
    notCountedWithReason: v.filter(x => !x.verCounted && x.verCountExclusion).length, overrideCounted: v.filter(x => x.verCountOverride === "counted").length,
    overrideNotCounted: v.filter(x => x.verCountOverride === "not_counted").length, countedNonVer: v.filter(x => x.verCounted && x.orderType !== "VER").length };
}
/** 来店ID単位の比較。件数合計の一致だけで合格にしない。差異は来店IDだけを返す。 */
export function compareVer(before, after, expect = {}) {
  const ids = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed = [], missing = [], extra = [];
  for (const id of ids) {
    if (!(id in after)) { missing.push(id); continue; } if (!(id in before)) { extra.push(id); continue; }
    const a = before[id], b = after[id];
    if (a.verCounted !== b.verCounted || a.verCountExclusion !== b.verCountExclusion || a.verCountOverride !== b.verCountOverride) changed.push(id);
  }
  const sb = summarize(before), sa = summarize(after);
  const expectOk = Object.entries(expect).every(([k, v]) => sb[k] === v && sa[k] === v);
  return { before: sb, after: sa, changedIds: changed, missingIds: missing, extraIds: extra, expectOk, ok: !changed.length && !missing.length && !extra.length && expectOk };
}
