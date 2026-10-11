#!/usr/bin/env node
/**
 * 店舗保存版ソースに「共通マスター連携ブリッジ」を適用した“別フォルダ”を生成する(元ソースは変更しない)。
 *   node store-patches/apply.mjs --system diner|toko --src <保存版dir> --out <出力dir> [--master-config <json>] [--allow-unknown-version]
 * - 元ファイルのSHA256が想定版と違えば停止(--allow-unknown-versionでアンカー検査のみで続行)。
 * - 出力に bridge/ と core/ の必要ファイルを同梱。常若亭は master-config.js (共通マスターのFirebase Web設定)を生成。
 * - 切替フラグ(rpMigrationBatches/cutover)がmasterでない限り、パッチ済みアプリも従来どおり動作する。
 */
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { applyEdits, sha256 } from "./patch-lib.js";
import { dinerEdits, DINER_EXPECTED_SHA256, DINER_FILE } from "./diner-edits.js";
import { tokoEdits, TOKO_EXPECTED_SHA256, TOKO_FILE } from "./toko-edits.js";

const a = process.argv.slice(2); const opt = n => { const i = a.indexOf("--" + n); return i >= 0 ? a[i + 1] : undefined; };
const system = opt("system"), src = opt("src"), out = opt("out");
if (!["diner", "toko"].includes(system) || !src || !out) { console.error("--system diner|toko --src <dir> --out <dir> が必要です"); process.exit(2); }
if (path.resolve(src) === path.resolve(out)) { console.error("出力先は元ソースと別のフォルダにしてください"); process.exit(2); }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cfg = system === "diner" ? { file: DINER_FILE, edits: dinerEdits, sha: DINER_EXPECTED_SHA256 } : { file: TOKO_FILE, edits: tokoEdits, sha: TOKO_EXPECTED_SHA256 };
const srcText = fs.readFileSync(path.join(src, cfg.file), "utf8");
if (sha256(srcText) !== cfg.sha && !a.includes("--allow-unknown-version")) { console.error(`${cfg.file} のSHA256が想定版(保存版)と異なります。現行ソースとの差分確認(hosting-diff)後、--allow-unknown-version でアンカー検査のみ実施できます`); process.exit(3); }
const { text, applied } = applyEdits(srcText, cfg.edits);
fs.cpSync(src, out, { recursive: true, filter: s => !/[\\/]\.firebase([\\/]|$)/.test(s) });
fs.writeFileSync(path.join(out, cfg.file), text);
fs.cpSync(path.join(root, "bridge"), path.join(out, "bridge"), { recursive: true });
fs.mkdirSync(path.join(out, "core"), { recursive: true });
for (const f of ["collections.js", "identity-plan.js", "util.js"]) fs.copyFileSync(path.join(root, "core", f), path.join(out, "core", f));
if (system === "toko") {
  const mc = opt("master-config");
  const conf = mc ? JSON.parse(fs.readFileSync(mc, "utf8")) : null;
  fs.writeFileSync(path.join(out, "master-config.js"), `// 共通顧客マスター(rp*コレクション)を置くFirebaseプロジェクトのWeb設定(公開用設定。秘密鍵ではない)\nexport const masterFirebaseConfig = ${JSON.stringify(conf ?? { apiKey: "SET_ME", authDomain: "SET_ME", projectId: "SET_ME", appId: "SET_ME" }, null, 2)};\n`);
}
console.log(JSON.stringify({ system, output: "(指定のout)", appliedEdits: applied, note: "元ソースは未変更。本番へはデプロイしていません。切替前にportalの『切替前チェック』を通すこと。" }, null, 2));
