import { PortalError, safeId, nowIso, clean } from "./util.js";
import { MASTER as M } from "./collections.js";
import { ceremonyUnits, STAMP_UNIT } from "./aggregate.js";

export const ACTS = Object.freeze({
  gg: { id: "gg", name: "GGコール", state: "complete", note: "完成・実演済み(完成マクロ本文は未取得)" },
  monster: { id: "monster", name: "魔物ショー", state: "draft", note: "進行案段階(未完成)" },
  darts: { id: "darts", name: "ダーツ", state: "draft", note: "進行案段階(未完成)" }
});
export const achievementKey = (personId, stampValue) => `${personId}__${stampValue}`;

/** 人物別の状態を導出。実施記録(done)があれば実施済み、無ければ到達済み未実施。コピー等では変わらない。 */
export function ceremonyStatus({ personId, verStamps }, records, unit = STAMP_UNIT) {
  const doneKeys = new Set(records.filter(r => r.status === "done").map(r => r.achievementKey));
  const carried = new Map(records.filter(r => r.status === "carried").map(r => [r.achievementKey, r]));
  return ceremonyUnits(verStamps, unit).map(v => {
    const key = achievementKey(personId, v);
    return { achievementKey: key, stampValue: v, status: doneKeys.has(key) ? "done" : carried.has(key) ? "carried" : "reached_pending" };
  });
}
/** 次回到達予定(あと何スタンプか)。 */
export const nextUnit = (verStamps, unit = STAMP_UNIT) => { const r = verStamps % unit; const remaining = unit - r; return { remaining, nextValue: verStamps + remaining }; };

/** 営業回ごとの抽選。最初の対象者のダーツ結果が営業回の演目を決める。後続は既決に従う。 */
export async function recordDraw(store, { storeId, businessDate, act, personId, label }) {
  if (!["gg", "monster"].includes(act)) throw new PortalError("bad-act", "ダーツの結果はGGコールか魔物ショー");
  const id = `${safeId(storeId)}__${businessDate}`;
  const cur = await store.get(M.ceremonyDraws, id);
  if (cur) return { decided: false, draw: { id, ...cur } };
  await store.batch([{ op: "create", col: M.ceremonyDraws, id, data: { storeId, businessDate, act, decidedFor: personId, decidedBy: clean(label), at: nowIso() } }]);
  return { decided: true, draw: { id, storeId, businessDate, act, decidedFor: personId } };
}
export async function actForTarget(store, storeId, businessDate) {
  const d = await store.get(M.ceremonyDraws, `${safeId(storeId)}__${businessDate}`);
  return d ? d.act : null;
}

/** 実施記録。(人物,到達値)で一意。二重記録は拒否。マクロコピーはここを呼ばない。 */
export async function recordPerformance(store, { personId, characterId, stampValue, storeId, businessDate, act, drawId, label, status = "done", note = "" }) {
  if (!["done", "carried"].includes(status)) throw new PortalError("bad-status", status);
  if (!ACTS[act]) throw new PortalError("bad-act", act);
  const key = achievementKey(personId, stampValue);
  const id = status === "done" ? `done__${key}` : `carried__${key}__${businessDate}`;
  const existingDone = await store.get(M.ceremonyRecords, `done__${key}`);
  if (existingDone) throw new PortalError("duplicate", "この達成は既に実施記録があります", { achievementKey: key });
  await store.batch([{ op: "create", col: M.ceremonyRecords, id, data: { achievementKey: key, personId, characterId: characterId ?? null, stampValue, storeId, businessDate, act, drawId: drawId ?? null, status, note: clean(note), recordedBy: clean(label), at: nowIso(), actStateAtRecord: ACTS[act].state } }]);
  return id;
}
