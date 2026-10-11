#!/usr/bin/env node
/**
 * Verスタンプ前後比較(来店ID単位)。
 *   1) スナップショット作成:  node tools/ver-compare.mjs snapshot --backup-dir <dir> --out before.json
 *                              node tools/ver-compare.mjs snapshot --json <visits.json> --out after.json   (visits.json: [{id,orderType,verCounted,...}])
 *   2) 比較:                  node tools/ver-compare.mjs compare --before before.json --after after.json [--expect-counted 186] [--expect-not-counted-with-reason 449] [--expect-override-counted 6]
 * 出力はID・件数のみ(氏名/備考/DMなし)。差異が1件でもあれば終了コード1。
 */
import fs from "node:fs";
import { loadBackup } from "./backup-lib.js";
import { snapshotFromTypedDocs, snapshotFromPlainVisits, summarize, compareVer } from "./ver-lib.js";
const a = process.argv.slice(2), cmd = a[0]; const opt = n => { const i = a.indexOf("--" + n); return i >= 0 ? a[i + 1] : undefined; };
if (cmd === "snapshot") {
  const snap = opt("backup-dir") ? snapshotFromTypedDocs(loadBackup(opt("backup-dir")).docs) : snapshotFromPlainVisits(JSON.parse(fs.readFileSync(opt("json"), "utf8")));
  fs.writeFileSync(opt("out"), JSON.stringify(snap)); console.log(JSON.stringify(summarize(snap), null, 2)); process.exit(0);
}
if (cmd === "compare") {
  const expect = {}; for (const [o, k] of [["expect-counted", "counted"], ["expect-not-counted-with-reason", "notCountedWithReason"], ["expect-override-counted", "overrideCounted"]]) if (opt(o)) expect[k] = Number(opt(o));
  const r = compareVer(JSON.parse(fs.readFileSync(opt("before"), "utf8")), JSON.parse(fs.readFileSync(opt("after"), "utf8")), expect);
  console.log(JSON.stringify({ ...r, verdict: r.ok ? "PASS" : "FAIL" }, null, 2)); process.exit(r.ok ? 0 : 1);
}
console.error("使い方: snapshot | compare (ファイル先頭のコメント参照)"); process.exit(2);
