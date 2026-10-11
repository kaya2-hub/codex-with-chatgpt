import { PortalError, clone, nowIso, clean } from "./util.js";
import { MASTER as M } from "./collections.js";
import { newId } from "./identity-ops.js";
import { normalizeDoc } from "./docs.js";

export const STATUSES = ["draft", "scheduled", "postponed", "cancelled", "held"];
const NEXT = { draft: ["scheduled", "cancelled"], scheduled: ["held", "postponed", "cancelled", "draft"], postponed: ["scheduled", "cancelled"], cancelled: ["draft"], held: [] };

export async function createMaster(store, { name, store: shop = null, overview = "", macros = [], timeline = { rows: [], unclassified: [], sourceText: "" }, materials = [] }) {
  const id = newId("evm");
  await store.batch([{ op: "create", col: M.eventMasters, id, data: { name: clean(name), store: shop, overview, macros: clone(macros), timeline: clone(timeline), materials: clone(materials), createdAt: nowIso() } }]);
  return id;
}
/** 開催回はマスターのスナップショット(ディープコピー)。以後マスターが変わっても追従しない。 */
export async function createOccurrence(store, masterId, { date = null, shop = null } = {}) {
  const m = await store.get(M.eventMasters, masterId);
  if (!m) throw new PortalError("not-found", "イベントマスターがありません");
  const id = newId("evo");
  await store.batch([{ op: "create", col: M.eventOccurrences, id, data: {
    masterId, masterRevisionAtCopy: m.revision, name: m.name, store: shop ?? m.store, date, status: "draft",
    overview: m.overview, macros: clone(m.macros), timeline: clone(m.timeline), materials: clone(m.materials), memo: "", history: [], createdAt: nowIso() } }]);
  return id;
}
export async function setStatus(store, occId, to, expectedRevision, { label } = {}) {
  const o = await store.get(M.eventOccurrences, occId);
  if (!o) throw new PortalError("not-found", occId);
  if (!STATUSES.includes(to)) throw new PortalError("bad-status", to);
  if (!NEXT[o.status].includes(to)) throw new PortalError("bad-transition", `${o.status} → ${to} はできません`);
  if (to === "scheduled" && !o.date) throw new PortalError("no-date", "開催日が未設定です");
  await store.batch([{ op: "update", col: M.eventOccurrences, id: occId, expectedRevision, data: { status: to, history: [...o.history, { at: nowIso(), by: clean(label), change: `status:${o.status}->${to}` }] } }]);
}
/** 開催回の編集。held後は履歴(before)を残す。 */
export async function editOccurrence(store, occId, expectedRevision, patch, { label } = {}) {
  const allowed = ["overview", "macros", "timeline", "materials", "memo", "date", "store"];
  for (const k of Object.keys(patch)) if (!allowed.includes(k)) throw new PortalError("bad-field", k);
  const o = await store.get(M.eventOccurrences, occId);
  if (!o) throw new PortalError("not-found", occId);
  const hist = o.status === "held" ? [...o.history, { at: nowIso(), by: clean(label), change: "post-held-edit", fields: Object.keys(patch), before: Object.fromEntries(Object.keys(patch).map(k => [k, clone(o[k])])) }] : o.history;
  await store.batch([{ op: "update", col: M.eventOccurrences, id: occId, expectedRevision, data: { ...clone(patch), history: hist } }]);
}
export async function duplicateOccurrence(store, occId) {
  const o = await store.get(M.eventOccurrences, occId);
  if (!o) throw new PortalError("not-found", occId);
  const d = normalizeDoc("event", o); const id = newId("evo");
  const content = { name: d.name, store: d.store, startTime: d.startTime, endTime: d.endTime, venue: d.venue, overview: d.overview, plan: d.plan, staff: d.staff, prep: d.prep, cautions: d.cautions, macros: d.macros, materials: d.materials, timeline: d.timeline };
  await store.batch([{ op: "create", col: M.eventOccurrences, id, data: { ...clone(content), ...(o.timelineLegacy ? { timelineLegacy: clone(o.timelineLegacy) } : {}), masterId: o.masterId ?? null, masterRevisionAtCopy: o.masterRevisionAtCopy ?? null, date: null, status: "draft", memo: "", history: [], copiedFrom: occId, createdAt: nowIso() } }]);
  return id;
}
/** 表示用。状態は変えない(過去日でもheldにしない)。 */
export const isPastDate = (o, today) => !!o.date && o.date < today;
export function todaysOccurrences(occs, today) { return occs.filter(o => o.date === today && ["scheduled", "held", "postponed"].includes(o.status)); }
export function searchArchive(occs, { store, name, year, includeStatuses = ["held"] } = {}) {
  return occs.filter(o => includeStatuses.includes(o.status) && (!store || o.store === store) && (!name || o.name.includes(name)) && (!year || (o.date || "").startsWith(String(year))))
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
}
