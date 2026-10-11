#!/usr/bin/env node
/**
 * 現行Hosting配信の静的ファイルと、保存版ソースの差分確認(副作用なし)。
 * HTTP GETのみ。ページはブラウザで開かず、JSも実行しません(Firestoreに触れません)。
 *   node tools/hosting-diff.mjs --base https://<site>.web.app --local <保存版dir> [--files index.html,app.js,logic.js,styles.css,version.json]
 * 出力: ファイルごとの SAME / DIFFERENT / REMOTE_MISSING / LOCAL_MISSING と SHA256先頭と長さ。
 * ※ firebase-config.js(公開Web設定)は比較対象に含めますが内容は出力しません。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const a = process.argv.slice(2);
const opt = n => { const i = a.indexOf("--" + n); return i >= 0 ? a[i + 1] : undefined; };
const base = opt("base"), local = opt("local");
if (!base || !local) { console.error("--base と --local が必要です"); process.exit(2); }
const files = (opt("files") || "index.html,app.js,logic.js,styles.css,customer-seed.js,version.json,firebase-config.js").split(",");
const sha = b => crypto.createHash("sha256").update(b).digest("hex");
const norm = b => Buffer.from(b.toString("utf8").replace(/\r\n/g, "\n"), "utf8"); // 改行差のみは同一扱い
const rows = []; let different = 0;
for (const f of files) {
  const lp = path.join(local, f); const L = fs.existsSync(lp) ? norm(fs.readFileSync(lp)) : null;
  let R = null, status = "";
  try { const r = await fetch(new URL(f, base.endsWith("/") ? base : base + "/"), { method: "GET", redirect: "follow", headers: { "cache-control": "no-cache" } });
    const ct = r.headers.get("content-type") || "";
    if (r.ok && !(ct.includes("text/html") && f !== "index.html")) R = norm(Buffer.from(await r.arrayBuffer())); // SPA rewriteでhtmlが返る場合は「無い」扱い
  } catch (e) { status = `取得失敗: ${e.message}`; }
  const s = status || (!L && !R ? "BOTH_MISSING" : !L ? "LOCAL_MISSING" : !R ? "REMOTE_MISSING" : sha(L) === sha(R) ? "SAME" : "DIFFERENT");
  if (s === "DIFFERENT" || s === "LOCAL_MISSING" || s === "REMOTE_MISSING") different++;
  rows.push({ file: f, status: s, local: L ? { sha: sha(L).slice(0, 12), bytes: L.length } : null, remote: R ? { sha: sha(R).slice(0, 12), bytes: R.length } : null });
}
console.log(JSON.stringify({ base, rows, differentCount: different, note: "DIFFERENT/MISSINGがある場合、保存版は現行と一致しません。移行・店舗側改修の前に現行ソースを入手してください。" }, null, 2));
process.exit(different ? 1 : 0);
