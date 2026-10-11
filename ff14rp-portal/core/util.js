// 共通ユーティリティ(ブラウザ/Node両用・依存なし)
export function norm(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase().replace(/[\s　]/g, "");
}
export function clean(value) {
  return String(value ?? "").replace(/\r\n/g, "\n").trim();
}
export function hash(value) {
  let h = 2166136261;
  for (const ch of String(value)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}
export function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}
export const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
export const isHttpUrl = v => /^https?:\/\/\S+$/i.test(String(v ?? "").trim());
export function nowIso() { return new Date().toISOString(); }
export class PortalError extends Error {
  constructor(code, message, detail) { super(message); this.code = code; this.detail = detail; }
}
// Firestore文書IDに使えない'/'を除去
export const safeId = s => String(s).replace(/[\/\s]/g, "_");

// 変更検出用の非暗号ハッシュ(cyrb53)。同時編集の3者比較(_base)に使う。
export function hash53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0, ch; i < str.length; i++) { ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
export const hashOf = v => hash53(stable(v));
