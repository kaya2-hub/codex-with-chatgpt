import { MASTER as M } from "../core/collections.js";
import { buildMigrationPlan, verifyPlan, verSnapshot, verSnapshotHash } from "../core/identity-plan.js";
import { stable, clone } from "../core/util.js";

export const PLAN_COLLECTIONS = [["persons", M.persons], ["characters", M.characters], ["sourceLinks", M.sourceLinks]];

const deepFreeze = o => { if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };

export function dryRun(inputs, opts) {
  // 入力(店舗原記録)を凍結して計画を作る。計画が原記録を変更しようとすれば例外になる。
  deepFreeze(inputs);
  const before = verSnapshotHash(verSnapshot(inputs.dinerVisits || []));
  const plan = buildMigrationPlan(inputs, opts);
  const errors = verifyPlan(inputs, plan);
  const after = verSnapshotHash(verSnapshot(inputs.dinerVisits || []));
  return { plan, errors, report: { ...plan.report, verCountedByVisitIdUnchanged: before === after, visitCountBefore: { diner: (inputs.dinerVisits || []).length, toko: (inputs.tokoVisits || []).length }, planInvariantErrors: errors.length, rollbackReady: true } };
}

/** 冪等な適用: 既存文書は上書きしない(人が編集した値を守る)。差異は報告のみ。分割バッチ(既定100件)。 */
export async function applyPlan(store, plan, { chunk = 100, onProgress } = {}) {
  const res = { created: 0, skippedSame: 0, skippedDiffering: [] };
  const existing = new Map();
  for (const [, col] of PLAN_COLLECTIONS) for (const d of await store.list(col)) existing.set(`${col}/${d.id}`, d);
  const ops = [];
  for (const [key, col] of PLAN_COLLECTIONS) for (const doc of plan[key]) {
    const { id, ...data } = doc; const ex = existing.get(`${col}/${id}`);
    if (!ex) ops.push({ op: "create", col, id, data });
    else {
      const { id: _id, revision, updatedAt, ...exData } = ex;
      if (stable(exData) === stable(data)) res.skippedSame++; else res.skippedDiffering.push(`${col}/${id}`);
    }
  }
  for (let i = 0; i < ops.length; i += chunk) { await store.batch(ops.slice(i, i + chunk)); res.created += Math.min(chunk, ops.length - i); onProgress?.(res.created, ops.length); }
  return res;
}

export async function postCheck(store, plan) {
  const errs = [];
  for (const [key, col] of PLAN_COLLECTIONS) {
    const got = new Map((await store.list(col)).map(d => [d.id, d]));
    for (const doc of plan[key]) if (!got.has(doc.id)) errs.push(`欠落 ${col}/${doc.id}`);
  }
  const links = await store.list(M.sourceLinks);
  const keys = new Set(); for (const l of links) { const k = `${l.sourceSystem}|${l.sourceType}|${l.sourceId}`; if (keys.has(k)) errs.push(`SourceLink重複 ${k}`); keys.add(k); }
  return errs;
}

/** ロールバック: 当該バッチが作成し未編集(revision==1)で、かつ他の(残る)文書から参照されていない文書だけ削除。参照されるものは残して報告。 */
export async function rollbackBatch(store, batchId) {
  const out = { deleted: 0, keptEdited: [], keptReferenced: [] };
  const all = {}; for (const [key, col] of PLAN_COLLECTIONS) all[key] = await store.list(col);
  const cand = new Set(); const mine = {};
  for (const [key, col] of PLAN_COLLECTIONS) for (const d of all[key]) {
    if (d.migrationBatchId !== batchId) continue;
    if (d.revision === 1) cand.add(`${col}/${d.id}`); else out.keptEdited.push(`${col}/${d.id}`);
  }
  // 残る文書(候補外)が参照する Person/Character は候補から外す。固定点まで繰り返す
  let changed = true;
  while (changed) {
    changed = false;
    const keep = [...all.characters, ...all.sourceLinks].filter(d => !cand.has(`${PLAN_COLLECTIONS.find(([k]) => all[k].includes(d))[1]}/${d.id}`));
    for (const d of keep) for (const ref of [d.personId && `${M.persons}/${d.personId}`, d.characterId && `${M.characters}/${d.characterId}`, ...(d.candidatePersonIds || []).map(x => `${M.persons}/${x}`)]) {
      if (ref && cand.has(ref)) { cand.delete(ref); out.keptReferenced.push(ref); changed = true; }
    }
  }
  const ops = [...cand].map(k => { const [col, ...r] = k.split("/"); return { op: "delete", col, id: r.join("/"), expectedRevision: 1 }; });
  // 参照元(SourceLink/Character)→Person の順で削除
  ops.sort((a, b) => (a.col === M.persons) - (b.col === M.persons));
  for (let i = 0; i < ops.length; i += 100) await store.batch(ops.slice(i, i + 100));
  out.deleted = ops.length; return out;
}
