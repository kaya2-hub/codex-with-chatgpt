import { MASTER as M } from "./collections.js";
import { PortalError, clone, nowIso, clean, norm, isHttpUrl } from "./util.js";
import { personIdFor, characterIdFor, linkId } from "./identity-plan.js";

let seq = 0;
export const newId = prefix => `${prefix}-${(globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 8)}`)}`;

class ChangeBuilder {
  constructor(store) { this.store = store; this.cache = new Map(); this.ops = []; this.diffs = []; this.touched = new Set(); }
  async load(col, id) {
    const k = `${col}/${id}`;
    if (!this.cache.has(k)) {
      const d = await this.store.get(col, id);
      if (!d) throw new PortalError("not-found", `存在しません: ${k}`);
      this.cache.set(k, d);
    }
    return this.cache.get(k);
  }
  update(col, id, patch) {
    const k = `${col}/${id}`, cur = this.cache.get(k);
    if (!cur) throw new PortalError("not-loaded", k);
    if (this.touched.has(k)) throw new PortalError("double-update", `同一文書を複数回更新: ${k}`);
    this.touched.add(k);
    const before = {}; for (const f of Object.keys(patch)) before[f] = cur[f] === undefined ? null : clone(cur[f]);
    this.ops.push({ op: "update", col, id, data: patch, expectedRevision: cur.revision });
    this.diffs.push({ type: "update", col, id, before, after: clone(patch), revisionAfter: cur.revision + 1 });
    this.cache.set(k, { ...cur, ...clone(patch), revision: cur.revision + 1 });
  }
  create(col, id, data) {
    this.ops.push({ op: "create", col, id, data });
    this.diffs.push({ type: "create", col, id, after: clone(data) });
    this.cache.set(`${col}/${id}`, { ...clone(data), revision: 1 });
    this.touched.add(`${col}/${id}`);
  }
  async commit(kind, label, reason = "") {
    const logId = newId("chg");
    this.ops.push({ op: "create", col: M.identityChanges, id: logId, data: { kind, label: clean(label) || "unknown", reason: clean(reason), at: nowIso(), diffs: this.diffs, undone: false } });
    await this.store.batch(this.ops);
    return logId;
  }
}

/** 共通備考・DMリンク等の人物情報編集。DMリンクの変更は店舗来店のVer判定に一切触れない(店舗側データは書かない)。 */
export async function editPersonInfo(store, personId, expectedRevision, patch, { label } = {}) {
  const allowed = ["customerNote", "xDmUrl", "primaryCharacterId"];
  const clean_ = {};
  for (const k of Object.keys(patch)) {
    if (!allowed.includes(k)) throw new PortalError("bad-field", `編集できない項目: ${k}`);
    clean_[k] = k === "customerNote" ? String(patch[k] ?? "").replace(/\r\n/g, "\n") : clean(patch[k]);
  }
  if (clean_.xDmUrl && !isHttpUrl(clean_.xDmUrl)) throw new PortalError("bad-url", "DMリンクはhttp(s)のURLにしてください");
  const b = new ChangeBuilder(store);
  const p = await b.load(M.persons, personId);
  if (p.revision !== expectedRevision) throw new PortalError("conflict", "他の人が先に更新しました。再読込してください", { expected: expectedRevision, actual: p.revision });
  b.update(M.persons, personId, clean_);
  return b.commit("editPersonInfo", label, Object.keys(clean_).join(","));
}

/** 改名: 同一Characterの現在名更新+旧名保持。 */
export async function renameCharacter(store, characterId, newName, { label, reason } = {}) {
  const name = clean(newName); if (!name) throw new PortalError("empty-name", "名前が空です");
  const b = new ChangeBuilder(store);
  const c = await b.load(M.characters, characterId);
  if (norm(c.currentName) === norm(name)) throw new PortalError("same-name", "現在名と同じです");
  const prev = c.previousNames.includes(c.currentName) ? c.previousNames : [...c.previousNames, c.currentName];
  b.update(M.characters, characterId, { currentName: name, previousNames: prev.filter(x => norm(x) !== norm(name)) });
  return b.commit("renameCharacter", label, reason);
}

/** 別キャラ追加: 同一人物へ新しいCharacter。 */
export async function addCharacter(store, personId, name, { world = null, label, reason } = {}) {
  const nm = clean(name); if (!nm) throw new PortalError("empty-name", "名前が空です");
  const b = new ChangeBuilder(store);
  await b.load(M.persons, personId);
  const id = newId("char");
  b.create(M.characters, id, { personId, currentName: nm, previousNames: [], legacyNameCandidates: [], world, origin: "operator", createdAt: nowIso() });
  await b.commit("addCharacter", label, reason);
  return id;
}

/** ダイナーの旧名候補(改名か別キャラか不明)を人が分類する。 */
export async function classifyLegacyName(store, characterId, name, decision, { label } = {}) {
  const b = new ChangeBuilder(store);
  const c = await b.load(M.characters, characterId);
  if (!c.legacyNameCandidates.includes(name)) throw new PortalError("not-candidate", "旧名候補にありません");
  const rest = c.legacyNameCandidates.filter(x => x !== name);
  if (decision === "rename") {
    b.update(M.characters, characterId, { legacyNameCandidates: rest, previousNames: c.previousNames.includes(name) ? c.previousNames : [...c.previousNames, name] });
  } else if (decision === "separate") {
    b.update(M.characters, characterId, { legacyNameCandidates: rest });
    b.create(M.characters, newId("char"), { personId: c.personId, currentName: name, previousNames: [], legacyNameCandidates: [], world: null, origin: "operator", createdAt: nowIso() });
  } else if (decision === "ignore") {
    b.update(M.characters, characterId, { legacyNameCandidates: rest });
  } else throw new PortalError("bad-decision", decision);
  return b.commit("classifyLegacyName", label, `${decision}:${name}`);
}

/** 照合候補の確定/却下/保留。自動では呼ばれない。 */
export async function resolveCandidate(store, sourceLinkId, decision, { targetPersonId, asCharacter = "new", characterName, label } = {}) {
  const b = new ChangeBuilder(store);
  const link = await b.load(M.sourceLinks, sourceLinkId);
  if (link.linkStatus === "confirmed") throw new PortalError("already-confirmed", "確定済みです");
  if (decision === "hold") {
    b.update(M.sourceLinks, sourceLinkId, { linkStatus: "unresolved" });
  } else if (decision === "confirm") {
    const pid = targetPersonId || link.personId;
    if (!(link.candidatePersonIds || [link.personId]).includes(pid)) throw new PortalError("not-a-candidate", "候補にない人物は選べません(統合は人物統合操作で)");
    await b.load(M.persons, pid);
    let charId;
    if (asCharacter === "new") {
      if (!clean(characterName)) throw new PortalError("empty-name", "キャラ名が必要です");
      charId = newId("char");
      b.create(M.characters, charId, { personId: pid, currentName: clean(characterName), previousNames: [], legacyNameCandidates: [], world: null, origin: "toko", createdAt: nowIso() });
    } else {
      const ch = await b.load(M.characters, asCharacter);
      if (ch.personId !== pid) throw new PortalError("mismatch", "キャラが別人物のものです");
      charId = asCharacter;
    }
    b.update(M.sourceLinks, sourceLinkId, { personId: pid, characterId: charId, linkStatus: "confirmed", basis: "operator-confirmed" });
  } else if (decision === "reject") {
    // 同名別人: 常若亭プロフィールを独立Personとして確定
    if (!clean(characterName)) throw new PortalError("empty-name", "キャラ名が必要です");
    const pid = newId("person"), cid = newId("char");
    b.create(M.persons, pid, { primaryCharacterId: cid, customerNote: "", xDmUrl: "", origin: "toko", createdAt: nowIso(), createdBy: "operator" });
    b.create(M.characters, cid, { personId: pid, currentName: clean(characterName), previousNames: [], legacyNameCandidates: [], world: null, origin: "toko", createdAt: nowIso() });
    b.update(M.sourceLinks, sourceLinkId, { personId: pid, characterId: cid, linkStatus: "confirmed", basis: "operator-separate", candidatePersonIds: [] });
  } else throw new PortalError("bad-decision", decision);
  return b.commit("resolveCandidate", label, decision);
}

/** 人物統合: fromをintoへ。fromは削除せず mergedInto を付ける(元ID・履歴保持、undo可能)。 */
export async function mergePersons(store, fromId, intoId, { label, reason } = {}) {
  if (fromId === intoId) throw new PortalError("same-person", "同じ人物です");
  const b = new ChangeBuilder(store);
  const from = await b.load(M.persons, fromId), into = await b.load(M.persons, intoId);
  if (from.mergedInto || into.mergedInto) throw new PortalError("already-merged", "統合済みの人物が含まれています");
  const chars = (await store.list(M.characters)).filter(c => c.personId === fromId);
  const links = (await store.list(M.sourceLinks)).filter(l => l.personId === fromId || (l.candidatePersonIds || []).includes(fromId));
  for (const c of chars) { await b.load(M.characters, c.id); b.update(M.characters, c.id, { personId: intoId }); }
  for (const l of links) {
    await b.load(M.sourceLinks, l.id);
    const patch = {};
    if (l.personId === fromId) patch.personId = intoId;
    if ((l.candidatePersonIds || []).includes(fromId)) patch.candidatePersonIds = [...new Set(l.candidatePersonIds.map(x => x === fromId ? intoId : x))];
    b.update(M.sourceLinks, l.id, patch);
  }
  const keep = [...(into.mergedFrom || []), { personId: fromId, customerNote: from.customerNote, xDmUrl: from.xDmUrl }];
  b.update(M.persons, intoId, { mergedFrom: keep });
  b.update(M.persons, fromId, { mergedInto: intoId });
  return b.commit("mergePersons", label, reason);
}

/** キャラ分離: 誤統合の訂正。キャラとそのSourceLinkを新Personへ。 */
export async function splitCharacter(store, characterId, { label, reason } = {}) {
  const b = new ChangeBuilder(store);
  const c = await b.load(M.characters, characterId);
  const oldPerson = await b.load(M.persons, c.personId);
  // セレモニー実施記録は人物単位。分離すると達成が再実施可能になるため、記録がある人物は分離しない。
  if ((await store.list(M.ceremonyRecords)).some(r => r.personId === c.personId)) throw new PortalError("has-ceremony-records", "セレモニーの実施記録がある人物は分離できません(記録の扱いを決めてから実施してください)");
  const links = (await store.list(M.sourceLinks)).filter(l => l.characterId === characterId);
  const pid = newId("person");
  b.create(M.persons, pid, { primaryCharacterId: characterId, customerNote: "", xDmUrl: "", origin: "operator", createdAt: nowIso(), createdBy: "operator" });
  b.update(M.characters, characterId, { personId: pid });
  if (oldPerson.primaryCharacterId === characterId) { const other = (await store.list(M.characters)).find(x => x.personId === c.personId && x.id !== characterId); b.update(M.persons, c.personId, { primaryCharacterId: other ? other.id : null }); }
  for (const l of links) { await b.load(M.sourceLinks, l.id); b.update(M.sourceLinks, l.id, { personId: pid }); }
  await b.commit("splitCharacter", label, reason);
  return pid;
}

/** 変更履歴の取り消し。対象文書が変更後から動いていれば競合として拒否(無警告上書きなし)。 */
export async function undoChange(store, changeId, { label } = {}) {
  const ch = await store.get(M.identityChanges, changeId);
  if (!ch) throw new PortalError("not-found", "履歴がありません");
  if (ch.undone) throw new PortalError("already-undone", "取り消し済みです");
  const ops = [];
  const cur = new Map();
  await assertUndoLeavesNoOrphans(store, ch);
  for (const d of [...ch.diffs].reverse()) {
    const doc = await store.get(d.col, d.id);
    if (!doc || doc.revision !== d.revisionAfter && !(d.type === "create" && doc?.revision === 1)) {
      throw new PortalError("conflict", `後続の更新があるため取り消せません: ${d.col}/${d.id}`);
    }
    if (d.type === "create") ops.push({ op: "delete", col: d.col, id: d.id, expectedRevision: doc.revision });
    else ops.push({ op: "update", col: d.col, id: d.id, data: d.before, expectedRevision: doc.revision });
    cur.set(d.id, doc);
  }
  ops.push({ op: "update", col: M.identityChanges, id: changeId, data: { undone: true, undoneBy: clean(label) }, expectedRevision: ch.revision });
  await store.batch(ops);
  return changeId;
}

/** undo後の状態を仮想的に作り、削除される Person/Character を指す参照が残るなら拒否(孤児防止)。 */
async function assertUndoLeavesNoOrphans(store, ch) {
  const creates = ch.diffs.filter(d => d.type === "create" && [M.persons, M.characters].includes(d.col));
  if (!creates.length) return;
  const gone = new Set(ch.diffs.filter(d => d.type === "create").map(d => `${d.col}/${d.id}`));
  const patched = new Map(ch.diffs.filter(d => d.type === "update").map(d => [`${d.col}/${d.id}`, d.before]));
  const view = async col => (await store.list(col)).filter(x => !gone.has(`${col}/${x.id}`)).map(x => ({ ...x, ...(patched.get(`${col}/${x.id}`) || {}) }));
  const chars = await view(M.characters), links = await view(M.sourceLinks);
  for (const d of creates) {
    const refs = d.col === M.persons
      ? [...chars.filter(c => c.personId === d.id), ...links.filter(l => l.personId === d.id)]
      : links.filter(l => l.characterId === d.id);
    if (refs.length) throw new PortalError("conflict", `後から追加された内容が参照しているため取り消せません: ${d.col}/${d.id}`);
  }
}

export { personIdFor, characterIdFor, linkId };
