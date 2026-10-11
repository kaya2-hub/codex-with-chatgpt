// 進行タイムライン v2。1つのステップ(時刻)に、かや/トーシンの複数の行動・セリフと共通の合図・条件を持てる。
// 時刻は「22:55頃」「23時になったら」など原文の表現のまま保持する(正規化・補完しない)。
export const ITEM_TYPES = Object.freeze(["say", "action", "change", "condition", "intent", "text"]);
export const TYPE_JA = Object.freeze({ say: "セリフ", action: "動作", change: "キャラチェンジ", condition: "進行条件", intent: "演出意図", text: "未分類" });
export const COLUMNS = Object.freeze(["kaya", "cue", "toushin"]);
export const emptyTimeline = () => ({ version: 2, steps: [] });
export const isV2 = t => !!t && t.version === 2 && Array.isArray(t.steps);

/** 旧形式(ルールベース3列: rows/unclassified)を新形式へ変換。内容は一切捨てない(種別不明は「未分類」)。 */
export function upgradeTimeline(t) {
  if (isV2(t)) return t;
  if (!t || typeof t !== "object") return emptyTimeline();
  const one = (type, text) => (String(text ?? "") === "" ? [] : [{ type, text: String(text) }]);
  const steps = [];
  (t.rows || []).forEach((r, i) => steps.push({ id: `legacy-s-${i}`, time: "", phase: r.phase || "", cue: one("text", r.cue), kaya: one("text", r.kaya), toushin: one("text", r.toushin), note: "" }));
  (t.unclassified || []).forEach((u, i) => steps.push({ id: `legacy-u-${i}`, time: "", phase: u.phase || "", cue: one("text", u.text), kaya: [], toushin: [], note: "旧・未分類の行" }));
  return { version: 2, steps };
}
export const newStep = id => ({ id, time: "", phase: "", cue: [], kaya: [], toushin: [], note: "" });
