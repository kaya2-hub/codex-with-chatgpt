// イベント開催回(rpEventOccurrences)とセレモニー原稿(rpCeremonyScripts)に共通の「文書」操作。
// 一箇所の編集は、最新を読み直して対象の項目だけを差し替える(他の項目は変わらない)。項目単位のハッシュで同時編集を検出する。
import { MASTER as M } from "./collections.js";
import { PortalError, clean, clone, nowIso, hashOf } from "./util.js";
import { normRole } from "./roles.js";
import { upgradeTimeline, isV2 } from "./timeline.js";

export const KINDS = Object.freeze({
  event: { col: M.eventOccurrences, scalars: ["name", "store", "date", "startTime", "endTime", "venue", "overview", "plan", "memo"], lists: ["prep", "cautions"], items: ["staff", "macros", "materials"], timeline: true },
  ceremony: { col: M.ceremonyScripts, scalars: ["characterName", "content", "thanks", "postNote"], lists: ["prep"], items: ["staff", "macros"], timeline: true }
});
const PREFIX = { steps: "s", staff: "st", macros: "m", materials: "mt" };
let seq = 0;
export const newItemId = key => `${PREFIX[key] || "x"}-${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const S_ = v => (v == null ? "" : String(v));
const canonItems = arr => (Array.isArray(arr) ? arr : []).filter(x => x && S_(x.text) !== "").map(x => ({ type: x.type, text: S_(x.text) }));
// 項目の正規形(保存・取り込み・比較で共通)。未知のキーは落とし、欠けた任意項目は空にそろえる。
export const canon = {
  step: (x, id) => ({ id: x.id || id, time: S_(x.time), phase: S_(x.phase), cue: canonItems(x.cue), kaya: canonItems(x.kaya), toushin: canonItems(x.toushin), note: S_(x.note) }),
  macro: (x, id) => ({ id: x.id || id, title: S_(x.title), role: normRole(x.role) ?? S_(x.role), body: S_(x.body), note: S_(x.note) }),
  material: (x, id) => ({ id: x.id || id, label: S_(x.label), url: S_(x.url), note: S_(x.note) }),
  staff: (x, id) => ({ id: x.id || id, role: normRole(x.role) ?? S_(x.role), duty: S_(x.duty) })
};
const CANON_FOR = { steps: "step", macros: "macro", materials: "material", staff: "staff" };
export const canonItem = (key, x, id) => canon[CANON_FOR[key]](x, id);

/** 保存済み文書を作業用に正規化(メモリ上のみ)。旧データのマクロ/資料にIDを付与(位置由来で決定的)し、旧タイムラインはv2へ変換。 */
export function normalizeDoc(kind, d) {
  const k = KINDS[kind]; const o = clone(d) ?? {};
  for (const f of k.scalars) o[f] = o[f] ?? (f === "store" || f === "date" ? null : "");
  for (const f of k.lists) o[f] = Array.isArray(o[f]) ? o[f] : [];
  for (const f of k.items) o[f] = (Array.isArray(o[f]) ? o[f] : []).map((x, i) => canonItem(f, x, `legacy-${PREFIX[f]}-${i}`));
  o.timeline = upgradeTimeline(o.timeline);
  o.timeline = { version: 2, steps: o.timeline.steps.map((x, i) => canonItem("steps", x, `legacy-s-${i}`)) };
  return o;
}
export const listOf = (o, key) => (key === "steps" ? o.timeline.steps : o[key]);
const withList = (o, key, arr) => (key === "steps" ? { timeline: { ...o.timeline, steps: arr } } : { [key]: arr });

/** 書込み(旧形式のタイムラインを新形式に置換する場合は、元を timelineLegacy に退避して失わない)。 */
export async function commitPatch(store, kind, id, cur, patch, label, change, expectedRevision) {
  const k = KINDS[kind]; const data = { ...patch };
  if (patch.timeline && !isV2(cur.timeline) && cur.timeline && !cur.timelineLegacy) data.timelineLegacy = cur.timeline;
  data.history = [...(cur.history || []), { at: nowIso(), by: clean(label), change, fields: Object.keys(patch) }];
  await store.batch([{ op: "update", col: k.col, id, expectedRevision, data }]);
}
async function load(store, kind, id) {
  const raw = await store.get(KINDS[kind].col, id); if (!raw) throw new PortalError("not-found", `${id} がありません`);
  return { raw, doc: normalizeDoc(kind, raw) };
}

/** 項目の追加/差替え/削除。baseHash指定時、開いた時点から他者が変更していれば競合として拒否。afterId で挿入位置指定。 */
export async function updateItem(store, kind, id, key, itemId, next, { baseHash, afterId, label } = {}) {
  const { raw, doc } = await load(store, kind, id);
  const list = [...listOf(doc, key)]; const i = list.findIndex(x => x.id === itemId);
  if (baseHash !== undefined && i >= 0 && hashOf(list[i]) !== baseHash) throw new PortalError("conflict", "他の人が先にこの項目を更新しました。再読込して確認してください");
  if (i < 0 && next === null) throw new PortalError("not-found", "項目がありません(既に削除済み)");
  if (next === null) list.splice(i, 1);
  else if (i >= 0) list[i] = { ...next, id: itemId };
  else { const at = afterId ? list.findIndex(x => x.id === afterId) + 1 : list.length; list.splice(at, 0, { ...next, id: itemId }); }
  await commitPatch(store, kind, id, raw, withList(doc, key, list), label, `${next === null ? "remove" : i >= 0 ? "edit" : "add"}:${key}:${itemId}`, raw.revision);
}
export async function moveItem(store, kind, id, key, itemId, dir, { label } = {}) {
  const { raw, doc } = await load(store, kind, id); const list = [...listOf(doc, key)];
  const i = list.findIndex(x => x.id === itemId); const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  await commitPatch(store, kind, id, raw, withList(doc, key, list), label, `move:${key}:${itemId}`, raw.revision);
}
/** スカラー/文字列リストの編集(渡した項目だけを書く)。baseValues指定で開いた時点との差を検出。 */
export async function updateFields(store, kind, id, patch, { baseValues, label } = {}) {
  const k = KINDS[kind]; const { raw, doc } = await load(store, kind, id);
  for (const f of Object.keys(patch)) if (![...k.scalars, ...k.lists].includes(f)) throw new PortalError("bad-field", `編集できない項目: ${f}`);
  if (baseValues) for (const f of Object.keys(patch)) if (f in baseValues && hashOf(doc[f]) !== hashOf(baseValues[f])) throw new PortalError("conflict", `他の人が先に「${f}」を更新しました。再読込して確認してください`);
  await commitPatch(store, kind, id, raw, patch, label, "edit:fields", raw.revision);
}
