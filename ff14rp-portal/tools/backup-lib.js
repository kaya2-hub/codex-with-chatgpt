import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";

// ---- Firestore REST 型付き値の正規化(比較用)。値は変換せず型を保つ ----
const TYPE_KEYS = ["nullValue", "booleanValue", "integerValue", "doubleValue", "timestampValue", "stringValue", "bytesValue", "referenceValue", "geoPointValue", "arrayValue", "mapValue"];
export function canonValue(v) {
  const k = TYPE_KEYS.find(t => Object.prototype.hasOwnProperty.call(v ?? {}, t));
  if (!k) throw new Error(`未知の値形式: キー=${Object.keys(v ?? {}).join(",")}`);
  switch (k) {
    case "nullValue": return ["null"];
    case "booleanValue": return ["bool", !!v[k]];
    case "integerValue": return ["int", String(BigInt(v[k]))];
    case "doubleValue": return ["double", Object.is(v[k], -0) ? "-0" : (typeof v[k] === "string" ? v[k] : String(v[k]))];
    case "timestampValue": return ["ts", normTimestamp(v[k])];
    case "stringValue": return ["str", v[k]];
    case "bytesValue": return ["bytes", v[k]];
    case "referenceValue": return ["ref", v[k].replace(/^projects\/[^/]+\/databases\/[^/]+\/documents\//, "")]; // プロジェクト名差は無視
    case "geoPointValue": return ["geo", Number(v[k].latitude ?? 0), Number(v[k].longitude ?? 0)];
    case "arrayValue": return ["arr", (v[k].values || []).map(canonValue)];
    case "mapValue": return ["map", canonFields(v[k].fields || {})];
  }
}
export function canonFields(f) { return Object.fromEntries(Object.keys(f).sort().map(k => [k, canonValue(f[k])])); }
function normTimestamp(s) {
  const m = String(s).match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/);
  if (!m) return String(s);
  const sec = Math.floor(Date.parse(m[1] + (m[3] === "Z" ? "Z" : m[3])) / 1000);
  return `${sec}.${(m[2] || "").padEnd(9, "0")}`;
}
export const sameFields = (a, b) => JSON.stringify(canonFields(a)) === JSON.stringify(canonFields(b));
/** 型・値の差を説明(値自体は出さない) */
export function diffFields(a, b) {
  const A = canonFields(a), B = canonFields(b), out = [];
  for (const k of new Set([...Object.keys(A), ...Object.keys(B)])) {
    if (!(k in A)) out.push(`${k}: 復元側に余分`); else if (!(k in B)) out.push(`${k}: 復元側に欠落`);
    else if (JSON.stringify(A[k]) !== JSON.stringify(B[k])) out.push(`${k}: ${A[k][0]}→${B[k][0]}${A[k][0] === B[k][0] ? "(値差)" : "(型差)"}`);
  }
  return out;
}

// ---- バックアップ読み込み ----
export function listBackupFiles(dir) {
  return fs.readdirSync(dir).filter(f => /\.jsonl(\.gz)?$/i.test(f)).sort().map(f => path.join(dir, f));
}
export function readLines(file) {
  let buf = fs.readFileSync(file);
  if (/\.gz$/i.test(file)) buf = zlib.gunzipSync(buf);
  return buf.toString("utf8").split(/\r?\n/).filter(l => l.trim());
}
/** 1行→{path, fields}。形式が不明なら例外(推測しない)。 */
export function parseDocLine(line) {
  const o = JSON.parse(line);
  let p = o.path;
  if (!p && o.name) p = String(o.name).replace(/^projects\/[^/]+\/databases\/[^/]+\/documents\//, "");
  if (!p && o.collection && (o.id ?? o.docId)) p = `${o.collection}/${o.id ?? o.docId}`;
  const fields = o.fields ?? o.data;
  if (!p || typeof fields !== "object" || fields === null) throw new Error(`未知の行形式: キー=${Object.keys(o).join(",")}`);
  canonFields(fields); // 型付き値であることの検証
  return { path: p, fields };
}
export function sha256File(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
export function verifyChecksums(dir) {
  const f = path.join(dir, "checksums.sha256");
  if (!fs.existsSync(f)) return { present: false, ok: 0, bad: [], missing: [] };
  const res = { present: true, ok: 0, bad: [], missing: [] };
  for (const l of fs.readFileSync(f, "utf8").split(/\r?\n/).filter(Boolean)) {
    const m = l.match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/); if (!m) continue;
    const fp = path.join(dir, m[2].trim());
    if (!fs.existsSync(fp)) res.missing.push(m[2]); else if (sha256File(fp).toLowerCase() === m[1].toLowerCase()) res.ok++; else res.bad.push(m[2]);
  }
  return res;
}
export function snapshotHashes(dir) { return Object.fromEntries(fs.readdirSync(dir).filter(f => fs.statSync(path.join(dir, f)).isFile()).sort().map(f => [f, sha256File(path.join(dir, f))])); }
export function loadBackup(dir) {
  const docs = new Map(), dup = [];
  for (const file of listBackupFiles(dir)) for (const line of readLines(file)) {
    const d = parseDocLine(line);
    if (docs.has(d.path)) dup.push(d.path); else docs.set(d.path, d.fields);
  }
  return { docs, duplicates: dup };
}
export function probe(dir) {
  const out = [];
  for (const file of listBackupFiles(dir)) {
    const lines = readLines(file); const sample = lines.slice(0, 3).map(l => { try { const o = JSON.parse(l); return { keys: Object.keys(o), fieldTypes: Object.fromEntries(Object.entries(o.fields ?? o.data ?? {}).slice(0, 30).map(([k, v]) => [k, v && typeof v === "object" ? Object.keys(v)[0] : typeof v])) }; } catch { return { error: "JSONとして読めない行" }; } });
    out.push({ file: path.basename(file), lines: lines.length, sample });
  }
  return out;
}

// ---- Firestoreエミュレータ REST(型を失わず書込/読出) ----
export class EmulatorRest {
  constructor(host, projectId) { this.base = `http://${host}/v1/projects/${projectId}/databases/(default)/documents`; this.project = projectId; }
  async _f(url, init = {}) { const r = await fetch(url, { ...init, headers: { "content-type": "application/json", authorization: "Bearer owner", ...(init.headers || {}) } }); if (!r.ok) throw new Error(`emulator ${r.status}: ${(await r.text()).slice(0, 200)}`); return r.json(); }
  async commit(writes) { return this._f(`${this.base}:commit`, { method: "POST", body: JSON.stringify({ writes }) }); }
  async put(docs) {
    const entries = [...docs.entries()];
    for (let i = 0; i < entries.length; i += 300) await this.commit(entries.slice(i, i + 300).map(([p, fields]) => ({ update: { name: `projects/${this.project}/databases/(default)/documents/${p}`, fields }, currentDocument: { exists: false } })));
  }
  async get(p) { return this._f(`${this.base}/${p.split("/").map(encodeURIComponent).join("/")}`); }
  async clear() { await fetch(`http://${this.base.split("/v1/")[0].replace("http://", "")}/emulator/v1/projects/${this.project}/databases/(default)/documents`, { method: "DELETE" }); }
}
export async function verifyRestore(rest, docs) {
  const res = { expected: docs.size, matched: 0, mismatched: [], missing: [] };
  for (const [p, fields] of docs) {
    let got; try { got = await rest.get(p); } catch { res.missing.push(p); continue; }
    if (sameFields(fields, got.fields || {})) res.matched++; else res.mismatched.push({ path: p, diff: diffFields(fields, got.fields || {}) });
  }
  return res;
}
