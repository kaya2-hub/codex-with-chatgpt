import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

test("hosting-diff: GETのみ・SAME/DIFFERENT/MISSING判定・SPAのhtml rewriteを欠落扱い", async () => {
  const methods = new Set();
  const srv = http.createServer((req, res) => {
    methods.add(req.method);
    if (req.url === "/index.html") { res.setHeader("content-type", "text/html"); return res.end("<h1>v1</h1>\r\n"); }
    if (req.url === "/app.js") { res.setHeader("content-type", "text/javascript"); return res.end("changed"); }
    res.setHeader("content-type", "text/html"); res.end("<h1>v1</h1>"); // rewrite
  }).listen(0, "127.0.0.1");
  await new Promise(r => srv.on("listening", r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hd-"));
  fs.writeFileSync(path.join(dir, "index.html"), "<h1>v1</h1>\n"); fs.writeFileSync(path.join(dir, "app.js"), "orig"); fs.writeFileSync(path.join(dir, "logic.js"), "x");
  const r = await new Promise(res => execFile("node", ["tools/hosting-diff.mjs", "--base", `http://127.0.0.1:${srv.address().port}`, "--local", dir, "--files", "index.html,app.js,logic.js"], { encoding: "utf8" }, (err, stdout) => res({ stdout, status: err ? err.code : 0 })));
  srv.close();
  const out = JSON.parse(r.stdout); const st = Object.fromEntries(out.rows.map(x => [x.file, x.status]));
  assert.deepEqual(st, { "index.html": "SAME", "app.js": "DIFFERENT", "logic.js": "REMOTE_MISSING" });
  assert.deepEqual([...methods], ["GET"]); assert.equal(r.status, 1);
});
