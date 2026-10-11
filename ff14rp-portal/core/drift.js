import { clean } from "./util.js";
/**
 * ダイナー店舗側の customerNote / xDmUrl が共通Personと異なるかを検出(読み取りのみ)。
 * 店舗画面が共通正本に切り替わるまでの二重正本リスクを可視化する。自動同期はしない。値は返さない。
 */
export function detectDrift(entry, dinerCustomers) {
  if (!dinerCustomers) return null;
  const out = [];
  for (const l of entry.links.filter(l => l.sourceSystem === "diner")) {
    const c = dinerCustomers.find(x => x.id === l.sourceId); if (!c) { out.push({ sourceId: l.sourceId, missing: true, fields: [] }); continue; }
    const fields = [];
    if (clean(c.customerNote) !== clean(entry.person.customerNote)) fields.push("customerNote");
    if (clean(c.xDmUrl) !== clean(entry.person.xDmUrl)) fields.push("xDmUrl");
    if (fields.length) out.push({ sourceId: l.sourceId, missing: false, fields });
  }
  return out;
}
