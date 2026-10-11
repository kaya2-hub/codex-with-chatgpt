#!/usr/bin/env node
// 使い方: node tools/migrate.mjs plan --demo | plan --input <dir>
//   --input の dir には dinerCustomers.json / tokoProfiles.json (任意で dinerVisits.json tokoVisits.json) を置く。
//   出力は件数レポートのみ(氏名/備考/DM URLは出力しない)。本番への書込みコマンドはこの版には存在しない。
import fs from "node:fs";
import path from "node:path";
import { syntheticShops } from "../fixtures/synthetic.js";
import { dryRun } from "./migrate-lib.js";

const args = process.argv.slice(2);
const cmd = args[0];
if (cmd !== "plan") { console.error("対応コマンド: plan (--demo | --input <dir> [--out <file>])"); process.exit(2); }
let inputs;
if (args.includes("--demo")) inputs = syntheticShops();
else {
  const dir = args[args.indexOf("--input") + 1];
  if (!dir) { console.error("--demo か --input <dir> が必要です"); process.exit(2); }
  const rd = f => { const p = path.join(dir, f); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : []; };
  inputs = { dinerCustomers: rd("dinerCustomers.json"), dinerVisits: rd("dinerVisits.json"), tokoProfiles: rd("tokoProfiles.json"), tokoVisits: rd("tokoVisits.json") };
}
const { report, errors } = dryRun(inputs, { batchId: `dry-${new Date().toISOString().slice(0, 10)}` });
const outFile = args.includes("--out") ? args[args.indexOf("--out") + 1] : null;
const text = JSON.stringify(report, null, 2);
if (outFile) fs.writeFileSync(outFile, text);
console.log(text);
if (errors.length) { console.error("不変条件違反:", errors.length); process.exit(1); }
