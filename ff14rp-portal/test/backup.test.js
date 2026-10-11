import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import * as B from "../tools/backup-lib.js";
import { assertDemoEmulator } from "../tools/safety.js";

// 全型を含む架空バックアップを生成(圧縮JSONL+manifest+checksums)
export function makeBackup(root, { tamper = false } = {}) {
  const dir = fs.mkdtempSync(path.join(root, "bk-"));
  const docs = [];
  for (let i = 0; i < 12; i++) docs.push({ path: `colA/d${i}`, fields: { s: { stringValue: `架空${i}` }, n: { integerValue: String(i) }, f: { doubleValue: i + 0.5 }, one: { doubleValue: 1 }, b: { booleanValue: i % 2 === 0 }, nul: { nullValue: null }, t: { timestampValue: "2026-08-07T01:02:03.123456Z" }, by: { bytesValue: "AQID" }, g: { geoPointValue: { latitude: 35.1, longitude: 139.2 } }, arr: { arrayValue: { values: [{ integerValue: "1" }, { stringValue: "x" }] } }, m: { mapValue: { fields: { k: { stringValue: "v" }, deep: { mapValue: { fields: { z: { integerValue: "9" } } } } } } }, r: { referenceValue: `projects/demo-restore/databases/(default)/documents/colB/x${i}` } } });
  for (let i = 0; i < 3; i++) docs.push({ path: `colB/x${i}`, fields: { name: { stringValue: "あ" } } });
  docs.push({ path: "colB/x0/sub/s1", fields: { q: { integerValue: "1" } } });
  const file = path.join(dir, "data.jsonl.gz");
  fs.writeFileSync(file, zlib.gzipSync(docs.map(d => JSON.stringify(d)).join("\n") + "\n"));
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ documents: docs.length }));
  const sum = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  fs.writeFileSync(path.join(dir, "checksums.sha256"), `${sum}  data.jsonl.gz\n`);
  if (tamper) fs.appendFileSync(file, "x");
  return { dir, docs };
}

test("ROL-01(部品) 型付き値の正規化: int/double・タイムスタンプ精度・参照のプロジェクト差を区別/無視", () => {
  assert.equal(B.sameFields({ a: { integerValue: "1" } }, { a: { doubleValue: 1 } }), false);          // 型差を検出
  assert.equal(B.sameFields({ a: { timestampValue: "2026-01-01T00:00:00.1Z" } }, { a: { timestampValue: "2026-01-01T00:00:00.100000Z" } }), true);
  assert.equal(B.sameFields({ a: { timestampValue: "2026-01-01T00:00:00.1Z" } }, { a: { timestampValue: "2026-01-01T00:00:00.2Z" } }), false);
  assert.equal(B.sameFields({ a: { referenceValue: "projects/p1/databases/(default)/documents/c/d" } }, { a: { referenceValue: "projects/demo-x/databases/(default)/documents/c/d" } }), true);
  assert.deepEqual(B.diffFields({ a: { integerValue: "1" } }, { a: { doubleValue: 1 } }), ["a: int→double(型差)"]);
  assert.throws(() => B.canonValue({ weirdValue: 1 }));
});
test("ROL-01(部品) 形式不明な行は推測せず例外 / checksum改ざん検出 / 重複パス検出", () => {
  assert.throws(() => B.parseDocLine('{"foo":1}'), /未知の行形式/);
  assert.throws(() => B.parseDocLine('{"path":"a/b","fields":{"x":"plain"}}'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bkt-"));
  const { dir } = makeBackup(tmp); assert.equal(B.verifyChecksums(dir).bad.length, 0);
  const t = makeBackup(tmp, { tamper: true }); assert.deepEqual(B.verifyChecksums(t.dir).bad, ["data.jsonl.gz"]);
  const dup = fs.mkdtempSync(path.join(tmp, "dup-")); fs.writeFileSync(path.join(dup, "a.jsonl"), '{"path":"c/1","fields":{}}\n{"path":"c/1","fields":{}}\n');
  assert.deepEqual(B.loadBackup(dup).duplicates, ["c/1"]);
  const p = B.probe(dir); assert.equal(p[0].lines, 16); assert.ok(!JSON.stringify(p).includes("架空"));
});
test("SEC-01 安全ガード: 本番ID・非demo・非localhostは拒否", () => {
  assert.throws(() => assertDemoEmulator("pixies-diner", { FIRESTORE_EMULATOR_HOST: "127.0.0.1:8089" }), /禁止/);
  assert.throws(() => assertDemoEmulator("tokowakatei-receipt", { FIRESTORE_EMULATOR_HOST: "127.0.0.1:8089" }), /禁止/);
  assert.throws(() => assertDemoEmulator("my-real", { FIRESTORE_EMULATOR_HOST: "127.0.0.1:8089" }), /demo-/);
  assert.throws(() => assertDemoEmulator("demo-x", {}), /localhost/);
  assert.throws(() => assertDemoEmulator("demo-x", { FIRESTORE_EMULATOR_HOST: "firestore.googleapis.com:443" }), /localhost/);
  assert.equal(assertDemoEmulator("demo-x", { FIRESTORE_EMULATOR_HOST: "localhost:8089" }), "localhost:8089");
});
test("ROL-01 エミュレータへ全型を復元し全件一致/CLIがPASS、改ざんはFAIL(エミュレータ必須)", { skip: !process.env.FIRESTORE_EMULATOR_HOST }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bkv-"));
  const good = makeBackup(tmp);
  const run = (dir, proj) => spawnSync("node", ["tools/backup-verify.mjs", "verify", "--dir", dir, "--project", proj, "--expect-docs", "16", "--expect-collections", "2"], { encoding: "utf8" });
  const r = run(good.dir, "demo-restore-ok"); const rep = JSON.parse(r.stdout);
  assert.equal(rep.verdict, "PASS", r.stdout + r.stderr); assert.equal(rep.restore.matched, 16); assert.equal(rep.sourceUnchanged, true);
  const bad = makeBackup(tmp, { tamper: true });
  const r2 = run(bad.dir, "demo-restore-bad"); assert.notEqual(r2.status, 0);
  const prod = spawnSync("node", ["tools/backup-verify.mjs", "verify", "--dir", good.dir, "--project", "pixies-diner"], { encoding: "utf8" });
  assert.notEqual(prod.status, 0); assert.match(prod.stderr, /禁止/);
});
