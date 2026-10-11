#!/usr/bin/env node
/**
 * ff14rp-portal 配下(作業ツリーとgit履歴の両方)に、機密/顧客データが混入していないかを検査する。
 *   node tools/secret-scan.mjs        → 問題なしなら終了コード0。違反は ファイル名+種別 のみ表示(内容は出さない)
 */
import { execFileSync } from "node:child_process"; import fs from "node:fs"; import path from "node:path";
const repo = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim(); const rel = path.relative(repo, process.cwd()).replace(/\\/g, "/") || ".";
const git = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8", maxBuffer: 1 << 28 });
const BAD_NAME = [/\.(zip|7z|jsonl|jsonl\.gz|pem|p12|key)$/i, /(^|\/)\.env/, /(^|\/)portal-config\.js$/, /customer-seed/i, /(^|\/)(private|backups?)\//i, /firebase-config\.js$/];
const BAD_CONTENT = [["Google APIキー形式", /AIza[0-9A-Za-z_-]{30,}/], ["秘密鍵ブロック", /-----BEGIN [A-Z ]*PRIVATE KEY-----/], ["サービスアカウント", /"private_key_id"\s*:/], ["GitHubトークン", /gh[pousr]_[0-9A-Za-z]{30,}/], ["Notionトークン", /secret_[0-9A-Za-z]{40,}/], ["X(旧Twitter)のDMリンク実URL", /https?:\/\/(x|twitter)\.com\/(messages|i\/chat|[A-Za-z0-9_]{3,15}\b)(?!\/dm\/(alpha|beta|gamma|e|f|new))/]];
const problems = [];
const names = new Set([...git("ls-files", "--", rel).split("\n"), ...git("log", "--all", "--name-only", "--format=", "--", rel).split("\n")].filter(Boolean));
for (const n of names) { if (/(^|\/)portal-config\.example\.js$/.test(n) || /\/fixtures\/|\/test\//.test(n)) { if (!/portal-config\.js$|\.zip$|\.jsonl/.test(n)) continue; } for (const re of BAD_NAME) if (re.test(n)) problems.push(`ファイル名: ${n}`); }
const hist = git("log", "--all", "-p", "--format=", "--", rel);
for (const [label, re] of BAD_CONTENT) { if (label.startsWith("X(")) continue; if (re.test(hist)) problems.push(`履歴内容: ${label}`); }
for (const f of git("ls-files", "--", rel).split("\n").filter(Boolean)) { const t = fs.existsSync(path.join(repo, f)) ? fs.readFileSync(path.join(repo, f), "utf8") : ""; for (const [label, re] of BAD_CONTENT) { if (label.startsWith("X(") && /\/(fixtures|test)\/|portal-config\.example|app\.js$|README|docs\//.test(f)) continue; if (re.test(t)) problems.push(`作業ツリー内容: ${f} (${label})`); } }
console.log(JSON.stringify({ scope: rel, filesChecked: names.size, problems }, null, 2)); process.exit(problems.length ? 1 : 0);
