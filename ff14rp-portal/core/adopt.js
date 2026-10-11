import { MASTER as M } from "./collections.js";
import { PortalError, clean } from "./util.js";
import { editPersonInfo, renameCharacter } from "./identity-ops.js";
import { buildMigrationPlan } from "./identity-plan.js";

/** 切替前の取り込み: ダイナー店舗側の値を共通Personへ(運用者が差異を見て選んだ項目のみ)。undo可能な履歴付き。 */
export async function adoptDinerInfo(store, personId, expectedRevision, dinerCustomer, fields, { label } = {}) {
  const patch = {};
  for (const f of fields) { if (!["customerNote", "xDmUrl"].includes(f)) throw new PortalError("bad-field", f); patch[f] = f === "xDmUrl" ? clean(dinerCustomer.xDmUrl) : String(dinerCustomer.customerNote ?? ""); }
  if (!Object.keys(patch).length) throw new PortalError("nothing", "取り込む項目がありません");
  return editPersonInfo(store, personId, expectedRevision, patch, { label: `${label ?? "operator"}(ダイナー値を取り込み)` });
}
/** ダイナー側で名前が変わっていた場合に、共通側Characterを改名として更新(旧名は保持)。 */
export async function adoptDinerName(store, characterId, dinerName, { label } = {}) { return renameCharacter(store, characterId, dinerName, { label, reason: "ダイナー側の名前変更を取り込み" }); }
/** 常若亭の旧備考を共通備考の末尾へ「明示操作で」追記。自動取り込みはしない。 */
export async function appendLegacyTokoNote(store, personId, expectedRevision, legacyNote, { label } = {}) {
  const ln = String(legacyNote ?? "").trim(); if (!ln) throw new PortalError("nothing", "旧備考が空です");
  const p = await store.get(M.persons, personId); if (!p) throw new PortalError("not-found", personId);
  const cur = String(p.customerNote ?? "");
  if (cur.includes(ln)) throw new PortalError("already", "既に追記済みです");
  return editPersonInfo(store, personId, expectedRevision, { customerNote: `${cur}${cur ? "\n\n" : ""}【旧常若亭備考】\n${ln}` }, { label: `${label ?? "operator"}(旧備考を追記)` });
}
/** 再スキャン: 店舗に新しく増えた顧客/プロフィールを共通マスターへ追加する(既存文書は上書きしない=冪等)。 */
export function rescanPlan(inputs, batchId) { return buildMigrationPlan(inputs, { batchId }); }

/** 候補確認画面用の要約(名前・件数・日付・旧備考/DMの有無のみ。内容は含めない)。 */
export function candidateSummary(link, { persons, characters }, shop, tokoProfiles) {
  const prof = (tokoProfiles || []).find(p => p.id === link.sourceId);
  const tv = (shop.toko?.visits || []).filter(v => v.profileId === link.sourceId);
  const pids = link.candidatePersonIds?.length ? link.candidatePersonIds : [link.personId];
  return {
    linkId: link.id, status: link.linkStatus, ambiguous: link.basis === "ambiguous-name", basis: link.basis,
    toko: { name: prof?.name ?? link.sourceId, visits: tv.length, lastVisit: tv.map(v => v.visitDate).sort().at(-1) ?? null, hasLegacyNote: !!clean(prof?.notes) },
    candidates: pids.map(pid => {
      const p = persons.find(x => x.id === pid); if (!p || p.mergedInto) return null;
      const chars = characters.filter(c => c.personId === pid);
      const dv = (shop.diner?.visits || []).filter(v => v.customerId && pid === `person-diner-${v.customerId}`);
      return { personId: pid, name: chars.find(c => c.id === p.primaryCharacterId)?.currentName ?? chars[0]?.currentName ?? "(名前なし)", previousNames: chars.flatMap(c => [...c.previousNames, ...c.legacyNameCandidates]),
        dinerVisits: dv.length, verStamps: dv.filter(v => v.orderType === "VER" && v.verCounted === true).length, lastVisit: dv.map(v => String(v.visitAt).slice(0, 10)).sort().at(-1) ?? null, hasNote: !!clean(p.customerNote), hasDm: !!clean(p.xDmUrl) };
    }).filter(Boolean)
  };
}
