// 自由文 → Kaya｜タイミング・合図・共通条件｜Toushin の3列プレビュー。
// ルールベース。分類できない行は unclassified に残し、担当・時刻・セリフを推測で補わない。
const KAYA = /^(?:kaya|カヤ|かや)\s*[:：]\s*/i;
const TOUSHIN = /^(?:toushin|トウシン|とうしん)\s*[:：]\s*/i;
const CUE = /^(?:共通|合図|タイミング|条件|cue)\s*[:：]\s*/i;
const TIME = /^\s*[\[［(（]?(\d{1,2}:\d{2}(?::\d{2})?)[\]］)）]?\s*/;
const PHASE = /^(?:[■▼◆●]\s*|#{1,3}\s+|【(.+?)】\s*$)/;

export function parseTimeline(text) {
  const rows = []; const unclassified = []; let phase = "";
  const raw = String(text ?? "");
  raw.split(/\r?\n/).forEach((line, i) => {
    const t = line.trim(); if (!t) return;
    // 3列形式: A｜B｜C または A|B|C
    const cols = t.split(/[｜|]/);
    if (cols.length === 3) { rows.push({ phase, kaya: cols[0].trim(), cue: cols[1].trim(), toushin: cols[2].trim(), line: i + 1, source: "table", uncertain: false }); return; }
    if (PHASE.test(t) && !KAYA.test(t) && !TOUSHIN.test(t)) { phase = t.replace(/^(?:[■▼◆●]\s*|#{1,3}\s+)/, "").replace(/^【(.+?)】\s*$/, "$1"); return; }
    let m;
    if ((m = t.match(KAYA))) rows.push({ phase, kaya: t.replace(KAYA, ""), cue: "", toushin: "", line: i + 1, source: "label", uncertain: false });
    else if ((m = t.match(TOUSHIN))) rows.push({ phase, kaya: "", cue: "", toushin: t.replace(TOUSHIN, ""), line: i + 1, source: "label", uncertain: false });
    else if ((m = t.match(CUE))) rows.push({ phase, kaya: "", cue: t.replace(CUE, ""), toushin: "", line: i + 1, source: "label", uncertain: false });
    else if ((m = t.match(TIME)) && t.replace(TIME, "").trim() === "") rows.push({ phase, kaya: "", cue: m[1], toushin: "", line: i + 1, source: "time", uncertain: false });
    else unclassified.push({ line: i + 1, text: t, phase });
  });
  return { rows, unclassified, sourceText: raw };
}
/** 確定前の編集結果を保存形式へ。未分類が残っていれば保存を許可するが明示フラグを持つ。 */
export function finalizeTimeline(parsed, { acceptUnclassified = false } = {}) {
  if (parsed.unclassified.length && !acceptUnclassified) return { ok: false, reason: `未分類 ${parsed.unclassified.length}行があります。行を割り当てるか「未分類のまま保存」を選んでください` };
  return { ok: true, timeline: { rows: parsed.rows, unclassified: parsed.unclassified, sourceText: parsed.sourceText } };
}
