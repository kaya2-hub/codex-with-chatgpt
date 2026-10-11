#!/usr/bin/env node
/**
 * PC側で一度実行するGate確認の統合ランナー(読み取り専用・本番Firestore非接続)。
 *   node tools/pc-gate-check.mjs --diner-backup <dir> --toko-backup <dir> [--diner-url <url> --diner-src <dir>] [--toko-url <url> --toko-src <dir>] [--out out/gate-report.json]
 * 実行内容: (1) バックアップ隔離復元検証(エミュレータ・demo-プロジェクト)  (2) Ver基準値の確認  (3) 現行Hosting差分(GETのみ)
 * 判定: 与えた全ステップが合格なら "ALL_PASS"。未指定のステップは SKIPPED と明示し、1つでも SKIPPED/FAIL があれば ALL_PASS にならない。
 * 出力は件数・ID・判定のみ(氏名/備考/DMは出ません)。
 */
import { spawnSync } from "node:child_process"; import fs from "node:fs"; import path from "node:path"; import os from "node:os"; import { fileURLToPath } from "node:url"; import { shellArgs } from "./proc.js";
const a = process.argv.slice(2); const opt = n => { const i = a.indexOf("--" + n); return i >= 0 ? a[i + 1] : undefined; };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."); const win = process.platform === "win32";
const EXPECT = { diner: { docs: 821, cols: 3, ver: { counted: 186, notCountedWithReason: 449, overrideCounted: 6 } }, toko: { docs: 162, cols: 10 } };
// 既定値は資料記載の実測値(ダイナー821文書/3コレクション・Ver186/対象外理由449/手動上書きcounted 6、常若亭162文書/10コレクション)。テスト用に上書き可
for (const k of ["diner", "toko"]) { if (opt(`${k}-expect-docs`)) EXPECT[k].docs = Number(opt(`${k}-expect-docs`)); if (opt(`${k}-expect-collections`)) EXPECT[k].cols = Number(opt(`${k}-expect-collections`)); }
if (opt("ver-expect")) EXPECT.diner.ver = Object.fromEntries(opt("ver-expect").split(",").map(x => x.split(":")).map(([k, v]) => [k, Number(v)]));
const steps = [];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ff14gate-"));

function backupStep(key, dir) {
  const name = `backup:${key}`; if (!dir) return steps.push({ name, result: "SKIPPED", detail: "--" + key + "-backup 未指定" });
  const rep = path.join(tmp, `${key}.json`); const ver = path.join(tmp, `${key}-ver.json`); const proj = `demo-restore-${key}`;
  const env = { ...process.env, FF14_BACKUP_DIR: dir, FF14_RESTORE_PROJECT: proj, FF14_EXPECT_DOCS: String(EXPECT[key].docs), FF14_EXPECT_COLLECTIONS: String(EXPECT[key].cols), FF14_REPORT_OUT: rep, FF14_VER_OUT: ver };
  const r = spawnSync(win ? "npx.cmd" : "npx", shellArgs(["firebase", "emulators:exec", "--only", "firestore", "--project", proj, "node tools/backup-verify.mjs verify"]), { cwd: root, env, encoding: "utf8", shell: win });
  if (!fs.existsSync(rep)) return steps.push({ name, result: "FAIL", detail: `検証レポートが生成されませんでした(終了コード ${r.status})。形式不明なら probe を実行: ${(r.stderr || "").split("\n").filter(Boolean).slice(-2).join(" / ")}` });
  const j = JSON.parse(fs.readFileSync(rep, "utf8"));
  steps.push({ name, result: j.verdict === "PASS" ? "PASS" : "FAIL", detail: { documents: j.documents, rootCollections: j.rootCollections, restoreMatched: j.restore?.matched, mismatched: j.restore?.mismatched, missing: j.restore?.missing, checksumsPresent: j.checksums?.present, checksumOk: j.checksums?.ok, checksumBad: j.checksums?.bad?.length, duplicatePaths: j.duplicatePaths, sourceUnchanged: j.sourceUnchanged } });
  if (key === "diner") {
    const v = j.verSummary; const e = EXPECT.diner.ver;
    const ok = v && v.counted === e.counted && v.notCountedWithReason === e.notCountedWithReason && v.overrideCounted === e.overrideCounted && v.countedNonVer === 0;
    steps.push({ name: "ver-baseline:diner", result: v ? (ok ? "PASS" : "FAIL") : "FAIL", detail: { expected: e, actual: v ?? "pixiesVisitsなし" } });
    if (fs.existsSync(ver)) { const keep = opt("ver-snapshot-out"); if (keep) fs.copyFileSync(ver, keep); }
  }
}
function hostStep(key) {
  const url = opt(`${key}-url`), src = opt(`${key}-src`); const name = `hosting-diff:${key}`;
  if (!url || !src) return steps.push({ name, result: "SKIPPED", detail: `--${key}-url と --${key}-src が必要` });
  const r = spawnSync("node", ["tools/hosting-diff.mjs", "--base", url, "--local", src, "--profile", key], { cwd: root, encoding: "utf8" });
  let j; try { j = JSON.parse(r.stdout); } catch { return steps.push({ name, result: "FAIL", detail: (r.stderr || "出力を解釈できません").slice(0, 300) }); }
  steps.push({ name, result: r.status === 0 ? "PASS" : "FAIL", detail: j.rows.map(x => `${x.file}:${x.status}`) });
}
backupStep("diner", opt("diner-backup")); backupStep("toko", opt("toko-backup")); hostStep("diner"); hostStep("toko");
const verdict = steps.every(s => s.result === "PASS") ? "ALL_PASS" : steps.some(s => s.result === "FAIL") ? "FAIL" : "INCOMPLETE";
const report = { generatedAt: new Date().toISOString(), verdict, steps, note: "本番Firestoreへの接続・書込みは行っていません。ALL_PASS以外は、該当ステップを確認/再実行してください。" };
const out = opt("out") || path.join(root, "out", "gate-report.json"); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2)); process.exit(verdict === "ALL_PASS" ? 0 : verdict === "FAIL" ? 1 : 3);
