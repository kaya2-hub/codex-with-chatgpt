// ブラウザE2E(デモモード・架空データ)。chromiumはPLAYWRIGHT_BROWSERS_PATHにあるものを使う。
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import fs from "node:fs";
import assert from "node:assert/strict";

const PORT = 5199;
const srv = spawn("node", ["tools/serve.mjs"], { env: { ...process.env, PORT }, stdio: "ignore" });
await new Promise(r => setTimeout(r, 800));
const root = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
const dir = fs.readdirSync(root).find(d => d.startsWith("chromium")) ;
const exe = fs.existsSync(`${root}/chromium`) ? `${root}/chromium` : (fs.existsSync(`${root}/${dir}/chrome-linux/chrome`) ? `${root}/${dir}/chrome-linux/chrome` : undefined);
let browser, fails = 0;
const step = async (name, fn) => { try { await fn(); console.log("PASS", name); } catch (e) { fails++; console.log("FAIL", name, "\n ", e.message.split("\n")[0]); } };
try {
  browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", e => errors.push(e.message)); page.on("console", m => m.type() === "error" && !/portal-config\.js|404/.test(m.text() + (m.location()?.url || "")) && errors.push(m.text()));
  page.on("dialog", d => d.accept());
  await page.goto(`http://127.0.0.1:${PORT}/web/`);
  await page.waitForSelector("#nav button");
  const nav = t => page.click(`#nav button:has-text("${t}")`);
  const act = (a, extra = "") => page.click(`[data-act="${a}"]${extra}`);

  await step("HOME: 旧名でも検索でき、予定未登録が表示される", async () => {
    await page.fill("#q", "Old Gamma");
    assert.ok(await page.locator("text=Test Gamma").count());
    assert.ok(await page.locator("text=予定未登録").count());
  });
  await step("顧客: 来店/Ver/総合が別表示、候補は集計外の注記", async () => {
    await nav("顧客"); await page.fill("#q", "alpha"); await page.click("a:has-text('Test Alpha')");
    const body = await page.innerText("#view");
    assert.match(body, /Verスタンプ/); assert.match(body, /未確認の照合候補/); assert.match(body, /14/);
  });
  await step("編集: 備考保存→再表示で保持、DM不正URLは拒否", async () => {
    await act("toggleedit"); await page.fill("#note", "行1\n行2"); await page.fill("#dm", "javascript:x");
    await act("saveinfo"); await page.waitForSelector("#toast.on");
    assert.match(await page.innerText("#toast"), /失敗/);
    assert.equal(await page.inputValue("#note"), "行1\n行2"); // 失敗しても入力は消えない
    await page.fill("#dm", "https://x.example/dm/new"); await act("saveinfo");
    await page.waitForFunction(() => document.querySelector("#toast")?.textContent.includes("保存しました"));
    await act("toggleedit");
    assert.match(await page.innerText("#view"), /行1\s*行2/);
  });
  await step("照合候補: 確定すると常若亭来店/注文が履歴に現れる", async () => {
    await nav("照合候補");
    const before = await page.locator('[data-act="candconfirm"]').count(); assert.equal(before, 4);
    const id = await page.locator('[data-act="candconfirm"]').first().getAttribute("data-id");
    await page.click(`[data-act="candconfirm"][data-id="${id}"]`);
    await page.waitForFunction(n => document.querySelectorAll('[data-act="candconfirm"]').length === n, 3);
    await nav("顧客"); await page.fill("#q", "alpha"); await page.click("a:has-text('Test Alpha')");
    assert.match(await page.innerText("#view"), /架空紅茶 ×2 @300/);
  });
  await step("イベント: マスター作成→開催回→マクロ追加→コピーが原文一致", async () => {
    await nav("イベント"); await page.fill("#mname", "E2Eイベント"); await act("mkmaster");
    await page.waitForSelector('[data-act="mkocc"]'); await page.fill('input[type=date][id^="od-"]', "2020-05-05"); await act("mkocc");
    await page.waitForSelector('[data-act="evtab"]'); await page.click('[data-act="evtab"][data-v="macros"]');
    const body = "/yell <t>さん！\n\n/s ♡全角　スペース {{x}}\n";
    await page.fill("#mtitle", "開幕"); await page.fill("#mbody", body); await act("addmacro");
    await page.waitForSelector('[data-act="copymacro"]'); await act("copymacro");
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    assert.equal(clip, body);
  });
  await step("イベント: 過去日でも下書きのまま。開催済みへは明示操作のみ", async () => {
    assert.match(await page.innerText("#view"), /下書き/);
    await act("status", '[data-to="scheduled"]'); await page.waitForSelector('[data-to="held"]');
    assert.match(await page.innerText("#view"), /開催予定/);
  });
  await step("タイムライン: 自由文→プレビュー→未分類を保持して保存", async () => {
    await page.click('[data-act="evtab"][data-v="timeline"]');
    await page.fill("#tlsrc", "■導入\nKaya: 挨拶\nToushin: 返事\n[00:10]\n意味不明な行");
    await act("tlparse"); await page.waitForSelector("#tk-0");
    assert.match(await page.innerText("#view"), /未分類\(1行\)/);
    await act("tlsave"); await page.waitForFunction(() => document.querySelector("#toast")?.textContent.includes("タイムライン"));
    const t = await page.innerText("#view");
    assert.match(t, /挨拶/); assert.match(t, /未分類 1行/);
  });
  await step("セレモニー: 7到達者表示→ダーツで演目決定→GGテンプレ未取得表示→登録→コピー→実施記録", async () => {
    await nav("セレモニー");
    assert.match(await page.innerText("#view"), /GGコール: 完成・実演済み/);
    await page.click("a:has-text('Test Gamma')");
    await page.click('[data-act="draw"][data-act2="gg"]'); await page.waitForFunction(() => document.body.innerText.includes("決定済み"));
    assert.match(await page.innerText("#view"), /完成マクロ本文は未取得/);
    await page.fill("#tplbody", "/s {{customer_name}}さん\n/s {{stamp_count}}スタンプ！ {{visit_count}}回目 {{thanks_comment}}"); await act("savetpl");
    await page.waitForSelector("pre.macro");
    const pre = await page.innerText("pre.macro");
    assert.match(pre, /Test Gammaさん/); assert.match(pre, /7スタンプ/);
    await act("copytext");
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), await page.evaluate(() => document.querySelector("pre.macro").textContent));
    assert.equal(await page.locator(".tag:has-text('7:到達済み未実施')").count() >= 1, true);
    await act("perform", '[data-st="done"]');
    await page.waitForFunction(() => document.body.innerText.includes("実施済み"));
    assert.ok(await page.locator("text=7:実施済み").count());
  });
  await step("アーカイブ: 開催済みのみ・複製", async () => {
    await nav("アーカイブ");
    assert.match(await page.innerText("#view"), /開催済みの記録はありません/);
  });
  await step("スマホ幅: 横スクロールなし・3列は縦積み", async () => {
    await page.setViewportSize({ width: 390, height: 800 });
    await nav("HOME");
    const w = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    assert.ok(w[0] <= w[1] + 1, `横スクロール ${w}`);
    await page.screenshot({ path: "out/mobile-home.png" });
  });
  await step("コンソールエラーなし", async () => assert.deepEqual(errors, []));
} finally { await browser?.close(); srv.kill(); }
console.log(fails ? `E2E失敗: ${fails}` : "E2E 全PASS"); process.exit(fails ? 1 : 0);
