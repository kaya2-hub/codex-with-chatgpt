#!/usr/bin/env node
// 配信用ビルド: web/ + core/ + store/ (+ デモ用 fixtures/tools) を dist/ へコピー。顧客生データ・設定秘密は含まない。
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), dist = path.join(root, "dist");
fs.rmSync(dist, { recursive: true, force: true });
for (const d of ["web", "core", "store", "fixtures"]) fs.cpSync(path.join(root, d), path.join(dist, d), { recursive: true, filter: s => !/portal-config\.js$/.test(s) || /example/.test(s) });
fs.mkdirSync(path.join(dist, "tools")); for (const f of ["migrate-lib.js"]) fs.copyFileSync(path.join(root, "tools", f), path.join(dist, "tools", f));
fs.writeFileSync(path.join(dist, "index.html"), '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=web/">');
console.log("dist/ を作成しました(portal-config.js は含めていません。公開前に必ず内容を確認してください)");
