// 担当者。内部IDは既存データとの互換のため英語表記(Kaya/Toushin)のまま、画面表示は日本語に統一する。
export const ROLES = Object.freeze([{ id: "Kaya", ja: "かや" }, { id: "Toushin", ja: "トーシン" }]);
const ALIASES = { kaya: "Kaya", かや: "Kaya", カヤ: "Kaya", toushin: "Toushin", トーシン: "Toushin", トウシン: "Toushin", とーしん: "Toushin", とうしん: "Toushin", トオシン: "Toushin" };
/** 英語/日本語どちらの表記でも同じ人物として内部ID(Kaya/Toushin)へ。不明なら null。 */
export function normRole(v) {
  const k = String(v ?? "").normalize("NFKC").trim().replace(/\s+(さん|様)$/, "").replace(/(さん|様)$/, "");
  return ALIASES[k.toLowerCase()] ?? ALIASES[k] ?? null;
}
/** 表示用。既知の担当者は日本語、それ以外(操作名など)は元の文字列を返す。 */
export const roleJa = v => { const r = normRole(v); return r ? ROLES.find(x => x.id === r).ja : String(v ?? ""); };
