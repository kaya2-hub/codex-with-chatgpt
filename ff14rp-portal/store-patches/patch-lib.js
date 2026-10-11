import crypto from "node:crypto";
export const sha256 = s => crypto.createHash("sha256").update(s).digest("hex");
/** 固定文字列置換。各アンカーは元ソースにちょうど1回だけ現れなければならない(違えば例外。曖昧な適用はしない)。 */
export function applyEdits(source, edits) {
  let out = source; const applied = [];
  for (const e of edits) {
    const n = out.split(e.find).length - 1;
    if (n !== 1) throw new Error(`アンカー不一致 [${e.name}]: ${n}箇所(1箇所のみ許可)。対象ソースが想定版と異なります`);
    out = out.replace(e.find, () => e.replace); applied.push(e.name);
  }
  return { text: out, applied };
}
