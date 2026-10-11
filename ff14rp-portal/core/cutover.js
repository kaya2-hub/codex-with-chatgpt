import { MASTER as M } from "./collections.js";
import { PortalError, clean, nowIso } from "./util.js";
import { detectDrift } from "./drift.js";

/**
 * 切替前チェック(読み取りのみ)。
 * diner: 全顧客が確定リンクを持つ / 共通と店舗側の備考・DMに未解決の差異が無い / リンク重複なし。
 * toko:  全プロフィールにSourceLinkがある。未確認(候補/保留)は従来の店舗内備考のまま動く(件数を警告表示)。
 */
export function preflight({ persons, links, dinerCustomers, tokoProfiles }, system) {
  const checks = [];
  const add = (id, label, ok, detail = "", blocking = true) => checks.push({ id, label, ok, detail, blocking });
  const byId = new Map(persons.map(p => [p.id, p]));
  const resolveP = pid => { let p = byId.get(pid), n = 0; while (p?.mergedInto && n++ < 5) p = byId.get(p.mergedInto); return p; };
  const mine = links.filter(l => l.sourceSystem === system);
  const keys = new Set(); let dup = 0; for (const l of mine) { const k = `${l.sourceType}|${l.sourceId}`; if (keys.has(k)) dup++; keys.add(k); }
  add("no-dup", "SourceLinkの重複なし", dup === 0, dup ? `${dup}件重複` : "");
  const orphan = mine.filter(l => l.linkStatus === "confirmed" && !resolveP(l.personId)).length;
  add("no-orphan", "確定リンクの参照先Personが存在", orphan === 0, orphan ? `${orphan}件` : "");
  if (system === "diner") {
    if (!dinerCustomers) add("loaded", "ダイナー顧客を読み込めた", false, "読込失敗");
    else {
      const linked = new Set(mine.filter(l => l.linkStatus === "confirmed").map(l => l.sourceId));
      const missing = dinerCustomers.filter(c => !linked.has(c.id)).length;
      add("all-linked", "全ダイナー顧客が確定リンク済み", missing === 0, missing ? `未連携 ${missing}件(総合DBの再スキャンで作成)` : `${dinerCustomers.length}件`);
      let driftN = 0;
      for (const c of dinerCustomers) {
        const l = mine.find(x => x.sourceId === c.id && x.linkStatus === "confirmed"); const p = l && resolveP(l.personId); if (!p) continue;
        if (clean(c.customerNote) !== clean(p.customerNote) || clean(c.xDmUrl) !== clean(p.xDmUrl)) driftN++;
      }
      add("no-drift", "店舗側と共通の備考・DMに未解決の差異なし", driftN === 0, driftN ? `${driftN}件(「ダイナー側の値を取り込む」か「共通を維持」を選択)` : "");
    }
  } else {
    if (!tokoProfiles) add("loaded", "常若亭プロフィールを読み込めた", false, "読込失敗");
    else {
      const have = new Set(mine.map(l => l.sourceId));
      const missing = tokoProfiles.filter(p => !have.has(p.id)).length;
      add("all-linked", "全常若亭プロフィールにSourceLinkあり", missing === 0, missing ? `未登録 ${missing}件(再スキャンで作成)` : `${tokoProfiles.length}件`);
      const unconfirmed = mine.filter(l => l.linkStatus !== "confirmed").length;
      add("unconfirmed", "未確認の照合候補(従来の店舗内備考のまま動作)", true, unconfirmed ? `${unconfirmed}件は確認するまで共通備考に接続されません` : "なし", false);
    }
  }
  return { system, ok: checks.every(c => c.ok || !c.blocking), checks };
}

export async function getCutover(store) { return (await store.get(M.migrationBatches, "cutover")) || { dinerMode: "off", tokoMode: "off", history: [] }; }

/** 切替フラグの更新。master化はpreflightが全て通った場合のみ。off(戻し)はいつでも可。 */
export async function setCutover(store, system, mode, pre, { label } = {}) {
  if (!["diner", "toko"].includes(system) || !["off", "master"].includes(mode)) throw new PortalError("bad-arg", "system/modeが不正です");
  if (mode === "master" && !(pre && pre.system === system && pre.ok)) throw new PortalError("preflight-failed", "切替前チェックが全て合格していません");
  const cur = await store.get(M.migrationBatches, "cutover");
  const entry = { at: nowIso(), by: clean(label), system, mode };
  if (!cur) await store.batch([{ op: "create", col: M.migrationBatches, id: "cutover", data: { dinerMode: "off", tokoMode: "off", [`${system}Mode`]: mode, history: [entry] } }]);
  else await store.batch([{ op: "update", col: M.migrationBatches, id: "cutover", expectedRevision: cur.revision, data: { [`${system}Mode`]: mode, history: [...(cur.history || []), entry] } }]);
}
