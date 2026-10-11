#!/usr/bin/env node
/**
 * ff14rp-portal 配下(作業ツリー=追跡/未追跡、git履歴)に、機密・顧客データ・バックアップ・設定の実体が混入していないか検査する。
 *   node tools/secret-scan.mjs        → 問題なしなら終了コード0。違反は ファイル名+種別 のみ表示(内容は出さない)
 * 架空データ(fixtures/test)でも禁止拡張子(zip/jsonl等)や秘密鍵形式は許可しない。許可するのは架空ドメイン x.example のDM URLのみ。
 */
import { execFileSync } from "node:child_process"; import fs from "node:fs"; import path from "node:path";
const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const rel = (path.relative(top, process.cwd()).replace(/\\/g, "/")) || ".";
const git = (...a) => execFileSync("git", a, { cwd: top, encoding: "utf8", maxBuffer: 1 << 28 });
const gitz = (...a) => git(...a).split("\0").filter(Boolean);
const scope = rel === "." ? [] : ["--", rel];
const BAD_NAME = [/\.(zip|7z|jsonl|gz|pem|p12|pfx|key)$/i, /(^|\/)\.env/, /(^|\/)portal-config\.js$/, /(^|\/)master-config\.js$/, /customer-seed/i, /(^|\/)(private|backups?)\//i, /(^|\/)firebase-config\.js$/, /serviceAccount/i];
const BAD_CONTENT = [
  ["Google APIキー形式", /AIza[0-9A-Za-z_-]{30,}/], ["秘密鍵ブロック", /-----BEGIN [A-Z ]*PRIVATE KEY-----/], ["サービスアカウント", /"private_key_id"\s*:/],
  ["GitHubトークン", /(gh[pousr]_[0-9A-Za-z]{30,}|github_pat_[0-9A-Za-z_]{30,})/], ["Notionトークン", /(secret_[0-9A-Za-z]{40,}|ntn_[0-9A-Za-z]{30,})/], ["Anthropic/OpenAI鍵", /sk-(ant-)?[0-9A-Za-z_-]{30,}/],
  ["実在形式のX/TwitterユーザーURL", /https?:\/\/(?:www\.)?(?:x|twitter)\.com\/(?!intent\b|i\/|home\b|messages\b)[A-Za-z0-9_]{2,15}(?:[/?#]|\b)(?<!\/dm\/[a-z]+)/i]
];
const problems = []; const add = m => { if (!problems.includes(m)) problems.push(m); };
const tracked = gitz("ls-files", "-z", ...scope), untracked = gitz("ls-files", "-z", "-o", "--exclude-standard", ...scope);
const histNames = gitz("log", "--all", "--name-only", "--format=", "-z", ...scope);
for (const n of new Set([...tracked, ...untracked, ...histNames])) for (const re of BAD_NAME) if (re.test(n)) add(`ファイル名: ${n}`);
const scanText = (label, t) => { for (const [kind, re] of BAD_CONTENT) { if (re.test(t)) add(`${label}: ${kind}`); } };
for (const f of new Set([...tracked, ...untracked])) { const fp = path.join(top, f); if (fs.existsSync(fp) && fs.statSync(fp).isFile() && fs.statSync(fp).size < 5e6) scanText(`作業ツリー ${f}`, fs.readFileSync(fp, "utf8")); }
scanText("git履歴", git("log", "--all", "-p", "--format=", ...scope));
console.log(JSON.stringify({ scope: rel, filesChecked: new Set([...tracked, ...untracked, ...histNames]).size, problems }, null, 2)); process.exit(problems.length ? 1 : 0);
