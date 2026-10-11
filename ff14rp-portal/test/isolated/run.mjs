#!/usr/bin/env node
/**
 * 隔離E2E(保存版店舗アプリ+連携ブリッジ)の一括実行。保存版ソースは機密のためリポジトリに無く、環境変数で渡す:
 *   FF14RP_DINER_SRC=<ダイナー保存版dir> FF14RP_TOKO_SRC=<常若亭保存版dir> node test/isolated/run.mjs
 * 全てFirestoreエミュレータ(demo-*)とローカルshimのみ。本番へ接続しない。実顧客データは使わない(架空fixture)。
 */
import { spawnSync } from "node:child_process"; import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { build } from "esbuild"; import { shellArgs } from "../../tools/proc.js";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dSrc = process.env.FF14RP_DINER_SRC, tSrc = process.env.FF14RP_TOKO_SRC;
if (!dSrc || !tSrc) { console.error("FF14RP_DINER_SRC / FF14RP_TOKO_SRC を設定してください(保存版ソースのフォルダ)"); process.exit(2); }
fs.mkdirSync(path.join(root, "out"), { recursive: true });
await build({ entryPoints: [path.join(root, "test/isolated/shim-entry.js")], bundle: true, format: "esm", outfile: path.join(root, "out/shim-fb.js"), logLevel: "warning" });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ff14iso-")); const pd = path.join(tmp, "diner"), pt = path.join(tmp, "toko"), mc = path.join(tmp, "mc.json");
fs.writeFileSync(mc, JSON.stringify({ apiKey: "x", authDomain: "x", projectId: "pixies-diner", appId: "x" }));
const sh = (args, opts = {}) => spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", shellArgs(args), { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32", ...opts });
for (const [sys, src, out, extra] of [["diner", dSrc, pd, []], ["toko", tSrc, pt, ["--master-config", mc]]]) {
  const r = spawnSync("node", ["store-patches/apply.mjs", "--system", sys, "--src", src, "--out", out, ...extra], { cwd: root, encoding: "utf8" });
  if (r.status !== 0) { console.error(`パッチ適用に失敗(${sys}): ${r.stderr}`); process.exit(r.status || 1); }
}
let fail = 0;
for (const [label, script, ...args] of [["diner", "test/isolated/diner-scenarios.mjs", dSrc, pd], ["toko", "test/isolated/toko-scenarios.mjs", pt]]) {
  const r = sh(["firebase", "emulators:exec", "--only", "firestore", "--project", "demo-iso", `node ${script} ${args.map(a => JSON.stringify(a)).join(" ")}`]);
  const lines = (r.stdout || "").split("\n").filter(l => /^(PASS|FAIL|ISOLATED|   )/.test(l)); console.log(`== ${label} ==\n${lines.join("\n")}`);
  if (r.status !== 0) fail++;
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(fail ? `隔離E2E: 失敗 ${fail}` : "隔離E2E: 全PASS"); process.exit(fail ? 1 : 0);
