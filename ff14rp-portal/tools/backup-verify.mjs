#!/usr/bin/env node
/**
 * ローカルバックアップの隔離復元検証(ユーザーPCで1回実行する想定)。
 *   1) node tools/backup-verify.mjs probe   --dir <バックアップdir>            形式の構造だけ表示(値は出さない)
 *   2) node tools/backup-verify.mjs verify  --dir <dir> --project demo-restore-diner [--expect-docs 821] [--expect-collections 3]
 *      ※ Firestoreエミュレータを起動し FIRESTORE_EMULATOR_HOST を設定した状態で実行
 *         例: npx firebase emulators:exec --only firestore --project demo-restore "node tools/backup-verify.mjs verify --dir ... "
 * 本番接続なし: projectIdはdemo-のみ、ホストはlocalhostのみ。元ファイルは読み取りのみ(実行前後でSHA256比較)。
 * 出力は件数・差分種別のみ(顧客名/備考/DMは出力しない)。
 */
import fs from "node:fs";
import { assertDemoEmulator } from "./safety.js";
import * as B from "./backup-lib.js";

const a = process.argv.slice(2), cmd = a[0];
const opt = n => { const i = a.indexOf("--" + n); return i >= 0 ? a[i + 1] : undefined; };
// パス/件数は環境変数でも渡せる(日本語・空白を含むWindowsパスの引用符問題を避けるため)
const dir = opt("dir") || process.env.FF14_BACKUP_DIR;
if (!dir || !fs.existsSync(dir)) { console.error("--dir にバックアップフォルダを指定してください"); process.exit(2); }
if (cmd === "probe") { console.log(JSON.stringify(B.probe(dir), null, 2)); process.exit(0); }
if (cmd !== "verify") { console.error("コマンド: probe | verify"); process.exit(2); }

const project = opt("project") || process.env.FF14_RESTORE_PROJECT || "demo-restore";
const host = assertDemoEmulator(project);
const before = B.snapshotHashes(dir);
const report = { dir: "(非表示)", project, checksums: B.verifyChecksums(dir), checks: {} };
let backup;
try { backup = B.loadBackup(dir); }
catch (e) { console.error(`バックアップ形式を解釈できません: ${e.message}\n先に probe を実行し、出力の構造(値なし)を共有してください。形式を推測して復元は行いません。`); process.exit(3); }
const cols = new Set([...backup.docs.keys()].map(p => p.split("/")[0]));
report.documents = backup.docs.size; report.rootCollections = cols.size; report.duplicatePaths = backup.duplicates.length;
const exp = opt("expect-docs") || process.env.FF14_EXPECT_DOCS, expc = opt("expect-collections") || process.env.FF14_EXPECT_COLLECTIONS;
report.checks.expectedDocs = exp ? Number(exp) === backup.docs.size : "未指定";
report.checks.expectedCollections = expc ? Number(expc) === cols.size : "未指定";
const rest = new B.EmulatorRest(host, project);
await rest.clear();
await rest.put(backup.docs);
const v = await B.verifyRestore(rest, backup.docs);
report.restore = { expected: v.expected, matched: v.matched, mismatched: v.mismatched.length, missing: v.missing.length, mismatchDetail: v.mismatched.slice(0, 20) };
const after = B.snapshotHashes(dir);
report.sourceUnchanged = JSON.stringify(before) === JSON.stringify(after);
const pass = report.checksums.bad.length === 0 && report.checksums.missing.length === 0 && backup.duplicates.length === 0 && v.matched === v.expected && report.sourceUnchanged && report.checks.expectedDocs !== false && report.checks.expectedCollections !== false;
report.verdict = pass ? "PASS" : "FAIL";
report.note = "PASSは: SHA256一致・重複0・全文書(ID/型/値)が復元後に一致・元ファイル不変・本番接続なし。他店とのデータ混在は別々のdirで別projectへ復元して確認する。";
console.log(JSON.stringify(report, null, 2));
process.exit(pass ? 0 : 1);
