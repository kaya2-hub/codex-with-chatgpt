// マクロ処理。原文は一切加工しない(trim/改行正規化/切詰めなし)。
// 置換は明示的な {{var}} のみ。未定義変数は置換せず報告する。
export const FF14_LINE_LIMIT = 15; // 目安。超えても自動で削除/切詰めしない(警告のみ)

export function renderMacro(template, vars) {
  const missing = new Set();
  const text = String(template).replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (m, k) => {
    if (Object.prototype.hasOwnProperty.call(vars, k) && vars[k] !== undefined && vars[k] !== null && vars[k] !== "") return String(vars[k]);
    missing.add(k); return m;
  });
  return { text, missing: [...missing] };
}
export function macroVariables(template) {
  return [...new Set([...String(template).matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map(m => m[1]))];
}
export function analyzeMacro(text) {
  const t = String(text);
  const lines = t.split("\n");
  const warnings = [];
  const nonEmpty = lines.filter(l => l.trim() !== "").length;
  if (nonEmpty > FF14_LINE_LIMIT) warnings.push(`行数 ${nonEmpty} がFF14マクロ1枠の目安(${FF14_LINE_LIMIT}行)を超えています。分割して貼ってください(自動では削りません)`);
  const cr = t.includes("\r");
  if (cr) warnings.push("CRを含みます(コピー時もそのまま保持します)");
  return { lineCount: lines.length, nonEmptyLines: nonEmpty, tags: [...t.matchAll(/<t>/g)].length, commands: [...new Set(lines.map(l => (l.match(/^\/[a-z]+/i) || [])[0]).filter(Boolean))], warnings };
}
/** コピー対象テキスト。そのまま返す(テストで原文一致を保証)。 */
export const copyText = text => String(text);
