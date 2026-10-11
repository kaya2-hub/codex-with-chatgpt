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
