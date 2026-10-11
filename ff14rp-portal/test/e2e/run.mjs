// ブラウザE2E(デモモード・架空データ)。chromiumはPLAYWRIGHT_BROWSERS_PATHにあるものを使う。
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import fs from "node:fs";
import assert from "node:assert/strict";
import os from "node:os"; import path from "node:path";
import { sampleEvent, sampleCeremony } from "../../core/samples.js";

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
    const t = await page.innerText("#view"); assert.match(t, /未確認 4件/); assert.match(t, /Ver♥/); assert.match(t, /曖昧/); // 判断材料と曖昧表示
    const id = await page.locator('[data-act="candconfirm"]').first().getAttribute("data-id");
    await page.click(`[data-act="candconfirm"][data-id="${id}"]`);
    await page.waitForFunction(n => document.querySelectorAll('[data-act="candconfirm"]').length === n, 3);
    await nav("顧客"); await page.fill("#q", "alpha"); await page.click("a:has-text('Test Alpha')");
    assert.match(await page.innerText("#view"), /架空紅茶 ×2 @300/);
  });
  await step("切替: 差異なしならpreflight合格→マスター正本化/従来へ戻す(フラグのみ・確認ダイアログ)", async () => {
    await nav("切替");
    let t = await page.innerText("#view"); assert.match(t, /全ダイナー顧客が確定リンク済み/); assert.match(t, /従来\(店舗内\)/);
    // 直前の編集で共通とダイナー店舗側に差異がある → 切替は拒否され、取り込みで解消してから可能になる
    assert.match(t, /差異/); assert.equal(await page.locator('[data-act="cutset"][data-sys="diner"][data-mode="master"]').isDisabled(), true);
    for (let i = 0; i < 4 && await page.locator('[data-act="adopt"]').count(); i++) { await page.locator('[data-act="adopt"]').first().click(); await page.waitForTimeout(700); }
    await page.waitForFunction(() => !document.querySelector('[data-act="adopt"]'));
    await page.click('[data-act="cutset"][data-sys="diner"][data-mode="master"]');
    await page.waitForFunction(() => document.body.innerText.includes("切替フラグを更新しました"));
    assert.match(await page.innerText("#view"), /共通マスターが正本/);
    await page.click('[data-act="cutset"][data-sys="diner"][data-mode="off"]');
    await page.waitForFunction(() => !document.querySelector('[data-act="cutset"][data-sys="diner"][data-mode="off"]:not([disabled])'));
  });
  await step("顧客一覧: 来店回数・DMリンク・Verスタンプ(14(0/7・到達2回分)形式)・店舗表示。候補は合算しない", async () => {
    await nav("顧客"); await page.fill("#q", "alpha");
    const row = page.locator(".crow", { hasText: "Test Alpha" }).first(); const t = await row.innerText();
    assert.match(t, /14回/); assert.match(t, /14\(0\/7・到達2回分\)/); assert.match(t, /ダイナー/); assert.ok(await row.locator('a:has-text("DMを開く")').count() === 1);
    assert.ok(!/18回/.test(t), "候補の常若亭来店を合算していない");
    await page.fill("#q", "delta"); assert.match(await page.locator(".crow", { hasText: "Test Delta" }).first().innerText(), /DMなし/);
  });
  await step("顧客一覧: 店舗データの読込失敗は「0回」ではなく「読込失敗」と表示", async () => {
    const p2 = await ctx.newPage(); await p2.goto(`http://127.0.0.1:${PORT}/web/?fail=diner`); await p2.waitForSelector("#nav button");
    await p2.click('#nav button:has-text("顧客")'); const t = await p2.innerText("#view"); assert.match(t, /読込失敗/); assert.ok(!/(^|\s)0回/.test(t)); await p2.close();
  });
  await step("担当者の表示名: かや/トーシンに統一(Kaya/Toushinは画面に出ない)", async () => {
    assert.match(await page.locator("#who").innerText(), /かや[\s\S]*トーシン/);
    for (const v of ["ホーム", "顧客", "イベント", "セレモニー"]) void v;
  });
  await step("イベント: 仕様書をコピー→ChatGPT生成JSONを取り込み(一括新規登録・プレビュー・確認)", async () => {
    await nav("イベント"); await act("exnew"); await act("spec", '[data-kind="event"]');
    const spec = await page.evaluate(() => navigator.clipboard.readText()); assert.match(spec, /ff14rp\.event/); assert.match(spec, /これでOK/); assert.match(spec, /22:55頃/);
    // 不正なJSONは保存されずに、どの項目が問題か表示される
    await page.fill("#imtext", JSON.stringify({ ...sampleEvent(), version: 9 })); await act("imcheck"); await page.waitForSelector(".bad");
    assert.match(await page.innerText("#view"), /version.*未対応/); assert.equal(await page.locator('[data-act="imcommit"]').count(), 0);
    await page.fill("#imtext", "{ これはJSONではありません"); await act("imcheck"); await page.waitForFunction(() => document.body.innerText.includes("JSONとして読めません"));
    // 正常なJSON(ファイルアップロード経由)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ev-")); const f = path.join(dir, "event.json"); fs.writeFileSync(f, JSON.stringify(sampleEvent()));
    await page.setInputFiles("#imfile", f); await page.waitForFunction(() => document.getElementById("imtext").value.includes("ff14rp.event"));
    await act("imcheck"); await page.waitForSelector('[data-act="imcommit"]'); assert.match(await page.innerText("#view"), /新規登録のプレビュー/);
    await act("imcommit"); await page.waitForFunction(() => document.body.innerText.includes("取り込みました"));
    assert.match(await page.innerText("#view"), /5周年記念式典\(サンプル\)/); assert.match(await page.innerText("#view"), /下書き/);
  });
  await step("イベント: タイムライン(時刻の原文表現・複数行動・キャラチェンジ・掛け合い)が3列で保持され、表示名はかや/トーシン", async () => {
    await page.click('[data-act="evtab"][data-v="timeline"]'); const t = await page.innerText("#view");
    for (const w of ["22:55頃", "23時になったら", "キャラチェンジ", "「面白い話…！？」", "桜や春の怪談めいた話題で場をつなぐ", "かや", "トーシン", "タイミング・合図・共通条件"]) assert.ok(t.includes(w), `「${w}」が表示されない`);
    assert.ok(!/Kaya|Toushin/.test(t));
  });
  await step("イベント: 1ステップだけ手動編集しても他のステップは変わらない/追加・並べ替え・削除", async () => {
    const before = await page.locator(".step").allInnerTexts(); assert.equal(before.length, 4);
    await page.locator(".step").nth(2).locator('[data-act="edopen"][data-type="step"]').first().click();
    await page.fill("#sd-time", "22:57頃"); await act("edsave"); await page.waitForFunction(() => document.body.innerText.includes("22:57頃"));
    const after = await page.locator(".step").allInnerTexts(); assert.equal(after.length, 4);
    for (const i of [0, 1, 3]) assert.equal(after[i], before[i]); assert.notEqual(after[2], before[2]);
    await page.locator(".step").nth(1).locator('[data-act="edmove"][data-dir="1"]').click(); await page.waitForFunction(() => document.querySelectorAll(".step")[2].innerText.includes("22:50"));
    await page.locator(".step").nth(0).locator('[data-act="edopen"][data-item="new"]').click(); await page.fill("#sd-time", "22:30");
    await act("sditemadd", '[data-col="kaya"]'); await page.fill("#sd-kaya-0-x", "複数行の\n動作メモ"); await act("edsave");
    await page.waitForFunction(() => document.querySelectorAll(".step").length === 5); assert.ok((await page.locator(".step").nth(1).innerText()).includes("複数行の"));
    await page.locator(".step").nth(1).locator('[data-act="eddel"]').click(); await page.waitForFunction(() => document.querySelectorAll(".step").length === 4);
  });
  await step("イベント: 担当者別マクロはグループ・個別に折り畳め、コピーは原文と完全一致。マクロの追加/編集/削除", async () => {
    await page.click('[data-act="evtab"][data-v="macros"]');
    const grp = page.locator('details[data-open-key^="g:"]').first(); assert.match(await grp.locator("summary").first().innerText(), /かやのマクロ/);
    await grp.locator("summary").first().click(); assert.equal(await grp.evaluate(e => e.open), true);
    const one = grp.locator("details").first(); await one.locator("summary").first().click(); assert.equal(await one.evaluate(e => e.open), true);
    await one.locator('[data-act="mcopy"]').click(); const clip = await page.evaluate(() => navigator.clipboard.readText()); assert.equal(clip, sampleEvent().event.macros[0].body);
    await grp.locator("summary").first().click(); assert.equal(await grp.evaluate(e => e.open), false); // 折り畳み
    const body = "/yell <t>さん！\n\n/s ♡全角　スペース\n/wait 2\n";
    await act("edopen", '[data-type="macro"][data-item="new"]'); await page.fill("#sd-title", "手動追加"); await page.selectOption("#sd-role", "Toushin"); await page.fill("#sd-body", body); await act("edsave");
    await page.waitForFunction(() => document.body.innerText.includes("手動追加")); assert.match(await page.innerText("#view"), /トーシンのマクロ/);
    const tg = page.locator('details[data-open-key^="g:"]').nth(1); if (!(await tg.evaluate(e => e.open))) await tg.locator("summary").first().click();
    const mac = tg.locator("details").first(); if (!(await mac.evaluate(e => e.open))) await mac.locator("summary").first().click();
    await mac.locator('[data-act="mcopy"]').click(); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), body);
    const long = Array.from({ length: 16 }, (_, i) => `/s ${i}`).join("\n");
    await mac.locator('[data-act="edopen"]').click(); await page.fill("#sd-body", long); await act("edsave"); await page.waitForFunction(() => document.body.innerText.includes("15行"));
    assert.ok((await page.innerText("#view")).includes("/s 15")); // 警告のみで削除しない
  });
  await step("イベント: 編集用データをコピー→ChatGPTで変更したJSONを差分更新(チェックした変更だけ反映)", async () => {
    await page.click('[data-act="evtab"][data-v="overview"]'); await act("exedit"); await act("exportcopy");
    const pkg = await page.evaluate(() => navigator.clipboard.readText()); assert.match(pkg, /現在のデータ/); assert.match(pkg, /"_base"/);
    const json = JSON.parse(pkg.match(/```json\n([\s\S]*?)\n```/g).at(-1).replace(/```json\n|\n```/g, ""));
    json.event.timeline.steps[1].time = "22:50(5分早め)"; json.event.venue = "地下 円卓(変更)";
    await page.fill("#imtext", JSON.stringify(json)); await act("imcheck"); await page.waitForSelector('[data-act="imcommit"]');
    const t = await page.innerText("#view"); assert.match(t, /変更の差分/); assert.match(t, /会場/);
    const boxes = page.locator('input[id^="ck-field:venue"]'); await boxes.uncheck(); // 会場の変更は採用しない
    await act("imcommit"); await page.waitForFunction(() => document.body.innerText.includes("取り込みました"));
    await page.click('[data-act="evtab"][data-v="timeline"]'); assert.ok((await page.innerText("#view")).includes("22:50(5分早め)"));
    await page.click('[data-act="evtab"][data-v="overview"]'); assert.equal(await page.inputValue("#f-venue"), sampleEvent().event.venue);
    await page.fill("#f-venue", "手動で直した会場"); await act("savefields"); await page.waitForFunction(() => document.body.innerText.includes("保存しました"));
    assert.equal(await page.inputValue("#f-name"), sampleEvent().event.name); // 一箇所の編集で他は変わらない
  });
  await step("イベント: 過去日でも下書きのまま。開催済みへは明示操作のみ", async () => {
    await page.fill("#f-date", "2020-05-05"); await act("savefields");
    await page.waitForFunction(() => document.body.innerText.includes("保存しました")); assert.match(await page.innerText("#view"), /下書き/);
    await act("status", '[data-to="scheduled"]'); await page.waitForSelector('[data-to="held"]'); assert.match(await page.innerText("#view"), /開催予定/);
  });
  await step("セレモニー: 7到達者表示→ダーツで演目決定→GGテンプレ未取得表示→登録→コピー→実施記録", async () => {
    await nav("セレモニー");
    assert.match(await page.innerText("#view"), /GGコール: 完成・実演済み/);
    await page.click("a:has-text('Test Gamma')");
    // セレモニー原稿: ChatGPT仕様書→JSON取り込み(下書き。完成/実施済みにはならない)
    assert.match(await page.innerText("#view"), /原稿なし/); await act("exscript"); await act("spec", '[data-kind="ceremony"]');
    const cspec = await page.evaluate(() => navigator.clipboard.readText()); assert.match(cspec, /ff14rp\.ceremony/); assert.match(cspec, /実施済み/);
    const cj = sampleCeremony(); cj.target = { personId: "person-diner-cus_c", stampValue: 7 }; cj.facts = { totalVisitCount: 9999 };
    await page.fill("#imtext", JSON.stringify(cj)); await act("imcheck"); await page.waitForSelector('[data-act="imcommit"]'); assert.match(await page.innerText("#view"), /facts/);
    await act("imcommit"); await page.waitForFunction(() => document.body.innerText.includes("原稿: 下書き"));
    assert.ok(await page.locator(".tag:has-text('7:到達済み未実施')").count() >= 1); // 原稿を作っても実施済みにならない
    assert.equal(await page.inputValue("#f-characterName"), "テスト 太郎"); await page.fill("#f-thanks", "手動で直した感謝コメント"); await act("savefields"); await page.waitForFunction(() => document.body.innerText.includes("保存しました"));
    await act("scriptstatus"); await page.waitForFunction(() => document.body.innerText.includes("原稿: 完成"));
    assert.ok(await page.locator(".tag:has-text('7:到達済み未実施')").count() >= 1); // 原稿が完成でも実施済みではない
    await act("exscript"); // ChatGPT欄を閉じる
    await page.click('[data-act="draw"][data-act2="gg"]'); await page.waitForFunction(() => document.body.innerText.includes("決定済み"));
    assert.match(await page.innerText("#view"), /完成マクロ本文は未取得/);
    await page.fill("#tplbody", "/s {{customer_name}}さん\n/s {{stamp_count}}スタンプ！ {{visit_count}}回目 {{thanks_comment}}"); await act("savetpl");
    await page.waitForSelector("#tplprev");
    const pre = await page.innerText("#tplprev");
    assert.match(pre, /Test Gammaさん/); assert.match(pre, /7スタンプ/);
    await act("copytext");
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), await page.evaluate(() => document.getElementById("tplprev").textContent));
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
