// ChatGPT連携の共通基盤: 取り込みJSONの検証・書き出し・差分(3者比較)・適用。イベントとセレモニーで共通。
// ChatGPTが作るJSONは「原稿」にすぎず、来店記録・Ver判定・実施記録・開催状態には一切触れない(取り込める項目を限定)。
import { PortalError, hashOf, stable, clone, isHttpUrl, nowIso, clean } from "./util.js";
import { normRole } from "./roles.js";
import { ITEM_TYPES } from "./timeline.js";
import { KINDS, normalizeDoc, canon, canonItem, listOf, newItemId } from "./docs.js";

export const SCHEMAS = Object.freeze({ event: "ff14rp.event", ceremony: "ff14rp.ceremony" });
export const SCHEMA_VERSION = 1;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAXTEXT = 20000;
// 取り込める項目(これ以外はすべて無視して警告)。内部名: 取り込みキー
const FIELD_KEY = { event: { memo: "retrospective" }, ceremony: {} };
const BODY = { event: "event", ceremony: "ceremony" };

class Report {
  constructor() { this.errors = []; this.warnings = []; }
  err(path, message) { this.errors.push({ path, message }); }
  warn(path, message) { this.warnings.push({ path, message }); }
}
const isObj = v => v && typeof v === "object" && !Array.isArray(v);
function str(r, path, v, { max = MAXTEXT, required = false } = {}) {
  if (v === undefined || v === null) { if (required) r.err(path, "必須項目です"); return undefined; }
  if (typeof v !== "string") { r.err(path, "文字列で指定してください"); return undefined; }
  if (required && v.trim() === "") { r.err(path, "空にできません"); return undefined; }
  if (v.length > max) { r.err(path, `長すぎます(最大${max}文字)`); return undefined; }
  return v;
}
function unknownKeys(r, path, obj, allowed) { for (const k of Object.keys(obj)) if (!allowed.includes(k)) r.warn(`${path}.${k}`, "未知の項目のため無視します"); }
function arr(r, path, v, max) { if (!Array.isArray(v)) { r.err(path, "配列で指定してください"); return null; } if (v.length > max) { r.err(path, `多すぎます(最大${max}件)`); return null; } return v; }

function vItems(r, path, v) {
  const a = arr(r, path, v ?? [], 200); if (!a) return [];
  return a.map((x, i) => {
    const p = `${path}[${i}]`; if (!isObj(x)) { r.err(p, "オブジェクトで指定してください"); return null; }
    unknownKeys(r, p, x, ["type", "text"]);
    if (!ITEM_TYPES.includes(x.type)) r.err(`${p}.type`, `種別は ${ITEM_TYPES.join(" / ")} のいずれか`);
    const text = str(r, `${p}.text`, x.text, { required: true, max: 5000 });
    return { type: x.type, text };
  }).filter(Boolean);
}
function vStep(r, p, x) {
  if (!isObj(x)) { r.err(p, "オブジェクトで指定してください"); return null; }
  unknownKeys(r, p, x, ["id", "time", "phase", "cue", "kaya", "toushin", "note"]);
  return { id: str(r, `${p}.id`, x.id, { max: 60 }), time: str(r, `${p}.time`, x.time, { max: 80 }) ?? "", phase: str(r, `${p}.phase`, x.phase, { max: 200 }) ?? "",
    cue: vItems(r, `${p}.cue`, x.cue), kaya: vItems(r, `${p}.kaya`, x.kaya), toushin: vItems(r, `${p}.toushin`, x.toushin), note: str(r, `${p}.note`, x.note, { max: 5000 }) ?? "" };
}
const ID_OK = id => id === undefined || /^[A-Za-z0-9_-]{1,60}$/.test(id);
function vList(r, path, v, max, one) {
  const a = arr(r, path, v, max); if (!a) return null;
  const out = a.map((x, i) => one(r, `${path}[${i}]`, x)).filter(Boolean);
  const seen = new Set(); out.forEach((x, i) => { if (x.id !== undefined) { if (!ID_OK(x.id)) r.err(`${path}[${i}].id`, "IDは英数字・-・_のみ(60文字まで)"); if (seen.has(x.id)) r.err(`${path}[${i}].id`, `ID「${x.id}」が重複しています`); seen.add(x.id); } });
  return out;
}
const vMacro = (r, p, x) => {
  if (!isObj(x)) { r.err(p, "オブジェクトで指定してください"); return null; }
  unknownKeys(r, p, x, ["id", "title", "role", "body", "note"]);
  const role = normRole(x.role); if (!role) r.err(`${p}.role`, "担当は「かや」または「トーシン」(Kaya/Toushinも可)");
  return { id: str(r, `${p}.id`, x.id, { max: 60 }), title: str(r, `${p}.title`, x.title, { required: true, max: 200 }), role, body: str(r, `${p}.body`, x.body, { required: true }), note: str(r, `${p}.note`, x.note, { max: 5000 }) ?? "" };
};
const vStaff = (r, p, x) => {
  if (!isObj(x)) { r.err(p, "オブジェクトで指定してください"); return null; }
  unknownKeys(r, p, x, ["id", "role", "duty"]);
  const role = normRole(x.role); if (!role) r.err(`${p}.role`, "担当は「かや」または「トーシン」(Kaya/Toushinも可)");
  return { id: str(r, `${p}.id`, x.id, { max: 60 }), role, duty: str(r, `${p}.duty`, x.duty, { max: 2000 }) ?? "" };
};
const vMaterial = (r, p, x) => {
  if (!isObj(x)) { r.err(p, "オブジェクトで指定してください"); return null; }
  unknownKeys(r, p, x, ["id", "label", "url", "note"]);
  const url = str(r, `${p}.url`, x.url, { max: 2000 }) ?? ""; if (url && !isHttpUrl(url)) r.warn(`${p}.url`, "http(s)のURLではありません(リンクとして開けません)");
  return { id: str(r, `${p}.id`, x.id, { max: 60 }), label: str(r, `${p}.label`, x.label, { max: 200 }) ?? "", url, note: str(r, `${p}.note`, x.note, { max: 2000 }) ?? "" };
};
const vStrList = (r, path, v) => { const a = arr(r, path, v, 100); return a ? a.map((x, i) => str(r, `${path}[${i}]`, x, { required: true, max: 2000 })).filter(x => x !== undefined) : null; };

const FIELD_RULES = {
  event: {
    name: (r, p, v) => str(r, p, v, { required: true, max: 200 }),
    store: (r, p, v) => { if (v === null || v === "") return null; if (!["diner", "toko"].includes(v)) { r.err(p, "店舗は diner / toko / null のいずれか"); return undefined; } return v; },
    date: (r, p, v) => { if (v === null || v === "") return null; if (typeof v !== "string" || !DATE.test(v) || Number.isNaN(Date.parse(v))) { r.err(p, "日付は YYYY-MM-DD 形式、未定なら null"); return undefined; } return v; },
    startTime: (r, p, v) => str(r, p, v, { max: 80 }), endTime: (r, p, v) => str(r, p, v, { max: 80 }), venue: (r, p, v) => str(r, p, v, { max: 500 }),
    overview: (r, p, v) => str(r, p, v), plan: (r, p, v) => str(r, p, v), memo: (r, p, v) => str(r, p, v)
  },
  ceremony: { characterName: (r, p, v) => str(r, p, v, { max: 200 }), content: (r, p, v) => str(r, p, v), thanks: (r, p, v) => str(r, p, v), postNote: (r, p, v) => str(r, p, v) }
};

/**
 * 取り込みJSONの検証。成功時 data には「指定された項目だけ」が内部名・正規形で入る(省略した項目は更新しない)。
 * @returns {{ok:boolean, kind, op, target, base, data, errors, warnings}}
 */
export function validateImport(input, expectedKind) {
  const r = new Report(); let j = input;
  if (typeof j === "string") { try { j = JSON.parse(j); } catch (e) { r.err("(全体)", `JSONとして読めません: ${e.message}`); return { ok: false, errors: r.errors, warnings: r.warnings }; } }
  if (!isObj(j)) { r.err("(全体)", "JSONオブジェクトである必要があります"); return { ok: false, errors: r.errors, warnings: r.warnings }; }
  const kind = Object.entries(SCHEMAS).find(([, v]) => v === j.schema)?.[0];
  if (!kind) r.err("schema", `schema は ${Object.values(SCHEMAS).join(" または ")} のいずれか(受け取った値: ${JSON.stringify(j.schema)})`);
  else if (expectedKind && kind !== expectedKind) r.err("schema", `この画面は ${SCHEMAS[expectedKind]} 用です(受け取った値: ${j.schema})`);
  if (j.version !== SCHEMA_VERSION) r.err("version", `未対応のバージョンです(対応: ${SCHEMA_VERSION}、受け取った値: ${JSON.stringify(j.version)})`);
  const op = j.op ?? "create"; if (!["create", "update"].includes(op)) r.err("op", "op は create または update");
  if (!kind || r.errors.length) return { ok: false, kind, errors: r.errors, warnings: r.warnings };
  unknownKeys(r, "", j, ["schema", "version", "op", "target", "_base", "facts", BODY[kind], "comment"]);
  if (j.facts !== undefined) r.warn("facts", "読み取り専用の情報です。取り込みでは無視し、来店回数・Ver判定などは変更しません");
  let target = null;
  if (j.target !== undefined) {
    if (!isObj(j.target)) r.err("target", "オブジェクトで指定してください");
    else if (kind === "event") { target = { occurrenceId: str(r, "target.occurrenceId", j.target.occurrenceId, { max: 100 }) }; }
    else { const sv = j.target.stampValue; if (!Number.isInteger(sv) || sv <= 0) r.err("target.stampValue", "達成スタンプ数は正の整数"); target = { personId: str(r, "target.personId", j.target.personId, { required: true, max: 200 }), stampValue: sv }; }
  }
  if (op === "update" && kind === "event" && !target?.occurrenceId) r.err("target.occurrenceId", "update には対象の開催回IDが必要です");
  if (kind === "ceremony" && !target?.personId) r.err("target", "セレモニーには対象のお客様(personId)と達成スタンプ数(stampValue)が必要です");
  const body = j[BODY[kind]];
  if (!isObj(body)) { r.err(BODY[kind], "オブジェクトで指定してください"); return { ok: false, kind, errors: r.errors, warnings: r.warnings }; }
  const k = KINDS[kind]; const data = {}; const rules = FIELD_RULES[kind];
  const allowed = [...k.scalars.map(f => FIELD_KEY[kind][f] ?? f), ...k.lists, ...k.items, "timeline"];
  unknownKeys(r, BODY[kind], body, allowed);
  for (const f of k.scalars) { const key = FIELD_KEY[kind][f] ?? f; if (key in body) { const v = rules[f](r, `${BODY[kind]}.${key}`, body[key]); if (v !== undefined) data[f] = v; } }
  if (op === "create" && kind === "event" && !("name" in body)) r.err(`${BODY[kind]}.name`, "新規登録にはイベント名が必要です");
  for (const f of k.lists) if (f in body) { const v = vStrList(r, `${BODY[kind]}.${f}`, body[f]); if (v) data[f] = v; }
  const itemRule = { staff: vStaff, macros: vMacro, materials: vMaterial };
  for (const f of k.items) if (f in body) { const v = vList(r, `${BODY[kind]}.${f}`, body[f], 300, itemRule[f]); if (v) data[f] = v; }
  if ("timeline" in body) {
    const t = body.timeline; if (!isObj(t)) r.err(`${BODY[kind]}.timeline`, "オブジェクト(steps配列を持つ)で指定してください");
    else { unknownKeys(r, `${BODY[kind]}.timeline`, t, ["version", "steps"]); const v = vList(r, `${BODY[kind]}.timeline.steps`, t.steps ?? [], 500, vStep); if (v) data.steps = v; }
  }
  let base = null;
  if (j._base !== undefined) { if (isObj(j._base) && isObj(j._base.fields) && isObj(j._base.items)) base = j._base; else r.err("_base", "_base は書き出し時の値をそのまま残してください"); }
  if (!r.errors.length && op === "update" && !Object.keys(data).length) r.warn(BODY[kind], "更新する項目がありません");
  return { ok: !r.errors.length, kind, op, target, base, data, errors: r.errors, warnings: r.warnings };
}

// ---------- 書き出し ----------
const baseOf = (kind, doc) => {
  const k = KINDS[kind]; const fields = {}, items = {}, order = {};
  for (const f of [...k.scalars, ...k.lists]) fields[f] = hashOf(doc[f]);
  for (const f of [...k.items, "steps"]) { const l = listOf(doc, f); items[f] = Object.fromEntries(l.map(x => [x.id, hashOf(x)])); order[f] = l.map(x => x.id); }
  return { fields, items, order };
};
function bodyOf(kind, doc) {
  const k = KINDS[kind]; const b = {};
  for (const f of k.scalars) b[FIELD_KEY[kind][f] ?? f] = doc[f];
  for (const f of k.lists) b[f] = doc[f];
  for (const f of k.items) b[f] = doc[f];
  b.timeline = { version: 2, steps: doc.timeline.steps };
  return b;
}
/** ChatGPTへ渡す現在データ。_base は編集の衝突検出に使うため、ChatGPTには変更させず返してもらう。 */
export function exportDoc(kind, raw, { target, facts } = {}) {
  const doc = normalizeDoc(kind, raw);
  const out = { schema: SCHEMAS[kind], version: SCHEMA_VERSION, op: "update", target: target ?? (kind === "event" ? { occurrenceId: raw.id } : undefined), _base: { revision: raw.revision ?? 0, ...baseOf(kind, doc) } };
  if (facts) out.facts = facts;
  out[BODY[kind]] = bodyOf(kind, doc);
  return out;
}

// ---------- 差分(3者比較) ----------
const labelField = (kind, f) => ({ name: "イベント名", store: "店舗", date: "開催日", startTime: "開始", endTime: "終了", venue: "会場", overview: "概要", plan: "企画内容", memo: "振り返り・メモ", characterName: "当日の呼称", content: "セレモニー内容", thanks: "個別の感謝コメント", postNote: "実施後メモ", prep: "準備事項", cautions: "注意事項", staff: "担当・役割", macros: "マクロ", materials: "資料", steps: "タイムライン" }[f] ?? f);
const itemTitle = (key, x) => key === "steps" ? `${x.time || "(時刻未定)"} ${x.phase || ""}`.trim() : key === "macros" ? `${x.title}(${x.role})` : key === "materials" ? x.label || x.url : `${x.role}: ${x.duty}`.slice(0, 40);

/**
 * 取り込み(data=検証済みの指定項目)と現在値の差を、項目単位の変更リストにする。
 * base(書き出し時の _base)があれば3者比較: 「ChatGPTが変えた」かつ「その後に他者が変えていない」ものは clean、
 * 両方が変えたものは conflict(利用者が選択)。ChatGPTが変えていない項目は、他者の編集を維持して変更なし。
 */
export function planImport(kind, currentRaw, data, base) {
  const k = KINDS[kind]; const cur = normalizeDoc(kind, currentRaw); const changes = []; const notes = []; const incoming = {};
  if (!base) notes.push("書き出し時の情報(_base)がないため、他の人の編集との衝突は検出できません。差分をよく確認してください。");
  else if (base.revision !== currentRaw.revision) notes.push(`書き出し後にこのデータは更新されています(rev ${base.revision} → ${currentRaw.revision})。両方が変えた箇所だけ選択が必要です。`);
  const baseF = base?.fields ?? {};
  for (const f of [...k.scalars, ...k.lists]) {
    if (!(f in data)) continue; if (stable(cur[f]) === stable(data[f])) continue;
    const bh = baseF[f]; const incomingIsBase = bh !== undefined && hashOf(data[f]) === bh;
    if (incomingIsBase) continue; // ChatGPTは変更していない(現在値は他者の編集)→維持
    const conflict = bh !== undefined && hashOf(cur[f]) !== bh;
    changes.push({ key: `field:${f}`, kind: "field", area: f, label: labelField(kind, f), before: cur[f], after: data[f], conflict });
  }
  const itemKeys = [...k.items, ...("steps" in data ? ["steps"] : [])];
  for (const f of itemKeys) {
    if (!(f in data)) continue;
    const curList = listOf(cur, f), curMap = new Map(curList.map(x => [x.id, x]));
    const inc = data[f].map(x => canonItem(f, x, x.id ?? newItemId(f)));
    const dupe = new Set(); for (const x of inc) { if (dupe.has(x.id)) x.id = newItemId(f); dupe.add(x.id); }
    incoming[f] = inc;
    const incMap = new Map(inc.map(x => [x.id, x])); const bItems = base?.items?.[f]; const bOrder = base?.order?.[f];
    for (const x of inc) {
      const c = curMap.get(x.id);
      if (!c) { const wasInBase = bItems && x.id in bItems; changes.push({ key: `add:${f}:${x.id}`, kind: "item-add", area: f, itemId: x.id, label: `${labelField(kind, f)}を追加`, title: itemTitle(f, x), before: null, after: x, conflict: !!wasInBase, reason: wasInBase ? "他の人が削除した項目です" : undefined }); continue; }
      if (stable(c) === stable(x)) continue;
      const bh = bItems?.[x.id];
      if (bh !== undefined && hashOf(x) === bh) continue; // ChatGPTは未変更
      const conflict = bh !== undefined && hashOf(c) !== bh;
      changes.push({ key: `edit:${f}:${x.id}`, kind: "item-edit", area: f, itemId: x.id, label: `${labelField(kind, f)}を変更`, title: itemTitle(f, x), before: c, after: x, conflict, reason: conflict ? "ChatGPTと他の人の両方がこの項目を変更しました" : undefined });
    }
    for (const c of curList) {
      if (incMap.has(c.id)) continue;
      if (bItems && !(c.id in bItems)) { notes.push(`「${itemTitle(f, c)}」は書き出し後に他の人が追加したため残します`); continue; }
      const conflict = !!bItems && hashOf(c) !== bItems[c.id];
      changes.push({ key: `remove:${f}:${c.id}`, kind: "item-remove", area: f, itemId: c.id, label: `${labelField(kind, f)}を削除`, title: itemTitle(f, c), before: c, after: null, conflict, reason: conflict ? "他の人が編集した項目を、ChatGPTは削除しています" : undefined });
    }
    // 並べ替え(共通する項目だけで比較)
    const common = curList.filter(x => incMap.has(x.id)).map(x => x.id); const incCommon = inc.filter(x => curMap.has(x.id)).map(x => x.id);
    if (stable(common) !== stable(incCommon)) {
      const bc = bOrder ? bOrder.filter(id => curMap.has(id) && incMap.has(id)) : null;
      if (!(bc && stable(bc) === stable(incCommon))) changes.push({ key: `order:${f}`, kind: "order", area: f, label: `${labelField(kind, f)}の並び順を変更`, before: common, after: incCommon, conflict: !!bc && stable(bc) !== stable(common) });
    }
  }
  return { changes, notes, incoming };
}

/** 変更リストのうち採用するもの(decisions[key]===true。未指定はcleanなら採用、conflictなら現在値を維持)を適用した「書込み用patch」を返す。 */
export function applyPlan(kind, currentRaw, data, plan, decisions = {}) {
  const k = KINDS[kind]; const cur = normalizeDoc(kind, currentRaw); const patch = {}; const chosen = c => (c.key in decisions ? !!decisions[c.key] : !c.conflict);
  const fieldsApplied = [];
  for (const c of plan.changes) if (c.kind === "field" && chosen(c)) { patch[c.area] = c.after; fieldsApplied.push(c.area); }
  for (const f of [...k.items, "steps"]) {
    const cs = plan.changes.filter(c => c.area === f && c.kind !== "field" && chosen(c)); if (!cs.length) continue;
    let list = listOf(cur, f).map(x => x);
    const incIds = (plan.incoming[f] ?? []).map(x => x.id);
    for (const c of cs) if (c.kind === "item-remove") list = list.filter(x => x.id !== c.itemId);
    for (const c of cs) if (c.kind === "item-edit") list = list.map(x => (x.id === c.itemId ? c.after : x));
    for (const c of cs) if (c.kind === "item-add") {
      let at = 0; const idx = incIds.indexOf(c.itemId);
      for (let i = idx - 1; i >= 0; i--) { const p = list.findIndex(x => x.id === incIds[i]); if (p >= 0) { at = p + 1; break; } }
      list.splice(at, 0, c.after);
    }
    const ord = cs.find(c => c.kind === "order");
    if (ord) { const slots = list.map((x, i) => (ord.after.includes(x.id) ? i : -1)).filter(i => i >= 0); const byId = new Map(list.map(x => [x.id, x])); const seq = ord.after.filter(id => byId.has(id)); slots.forEach((slot, n) => { list[slot] = byId.get(seq[n]); }); }
    if (f === "steps") patch.timeline = { version: 2, steps: list }; else patch[f] = list;
    fieldsApplied.push(f === "steps" ? "timeline" : f);
  }
  return { patch, fields: [...new Set(fieldsApplied)] };
}

/** 新規登録用: 検証済みdataから完全な文書内容を作る(IDを付与)。 */
export function buildNewDoc(kind, data) {
  const k = KINDS[kind]; const d = {};
  for (const f of k.scalars) d[f] = data[f] ?? (f === "store" || f === "date" ? null : "");
  for (const f of k.lists) d[f] = data[f] ?? [];
  for (const f of k.items) d[f] = (data[f] ?? []).map(x => canonItem(f, x, x.id ?? newItemId(f)));
  d.timeline = { version: 2, steps: (data.steps ?? []).map(x => canonItem("steps", x, x.id ?? newItemId("steps"))) };
  return d;
}
