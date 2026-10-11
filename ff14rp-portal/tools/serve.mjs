#!/usr/bin/env node
// ローカル確認用の静的サーバ(依存なし)。http://localhost:5173/web/ を開く。
import http from "node:http"; import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json" };
http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const f = path.resolve(root, "." + (u.endsWith("/") ? u + "index.html" : u));
  if (!f.startsWith(root) || /\/(private|node_modules|test|out)\//.test(f) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end("not found"); }
  res.writeHead(200, { "content-type": types[path.extname(f)] || "application/octet-stream", "cache-control": "no-store" }); fs.createReadStream(f).pipe(res);
}).listen(Number(process.env.PORT || 5173), "127.0.0.1", () => console.log("http://127.0.0.1:" + (process.env.PORT || 5173) + "/web/"));
