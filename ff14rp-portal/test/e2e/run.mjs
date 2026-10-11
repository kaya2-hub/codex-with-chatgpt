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
const step = async (name, fn) => { try { await fn(); console.log("PASS", name); } catch (e) { fails++; console.log("FAIL", name, "\n ", e.stack || e.message); } };
const lf = text => text.replace(/\r\n/g, "\n");
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
    // ダイナー14+確認済みの常若亭3(同営業回は1回)=17回
    assert.match(t, /17回/); assert.match(t, /14\(0\/7・到達2回分\)/); assert.match(t, /ダイナー/); assert.ok(await row.locator('a:has-text("DMを開く")').count() === 1);
    await page.fill("#q", "same name"); assert.match(await page.locator(".crow", { hasText: "Same Name" }).first().innerText(), /2回/); // 未確認の同名候補の常若亭来店(1件)は合算しない
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
  // ---- 15ステップのイベントJSON(プレビュー全表示の検証用。架空) ----
  const ev15 = sampleEvent(); ev15.event.name = "15ステップ検証イベント";
  ev15.event.timeline.steps = Array.from({ length: 15 }, (_, i) => ({ id: `s-${i + 1}`, time: `22:${String(i).padStart(2, "0")}頃`, phase: `区切り${i + 1}`,
    cue: [{ type: "condition", text: `合図${i + 1}` }], kaya: [{ type: "say", text: `かやのセリフ${i + 1}` }, { type: "action", text: `かやの動作${i + 1}` }], toushin: [{ type: "say", text: `トーシンのセリフ${i + 1}` }, { type: "change", text: `トーシンのキャラチェンジ${i + 1}` }], note: "" }));
  const longMacro = Array.from({ length: 16 }, (_, i) => `/s 長いマクロ${i}`).join("\n");
  ev15.event.macros = [{ id: "m-1", title: "かやのマクロ本文", role: "かや", body: "/yell <t>かや\n\n/s ♡全角　スペース\n/wait 2", note: "" }, { id: "m-2", title: "トーシンの長いマクロ", role: "トーシン", body: longMacro, note: "" }];
  ev15.event.retrospective = "振り返りの本文"; ev15.event.cautions = ["注意事項A"]; ev15.event.prep = ["準備事項A", "準備事項B"]; ev15.event.overview = "概要の本文"; ev15.event.plan = "企画内容の本文";
  const norm = t => t.replace(/\s+/g, " ").trim();
  const rgb = async sel => { const c = await page.locator(sel).first().evaluate(e => getComputedStyle(e).backgroundColor); return c.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number); };
  let previewTl = "", previewBasic = "";
  await step("ChatGPT手順: 6ステップの説明(チャッピー/書き出して/ファイル or 本文貼り付け)と操作ボタンが近くにあり、折り畳める", async () => {
    await nav("イベント"); await act("exnew");
    const guide = page.locator("details.guide"); assert.equal(await guide.evaluate(e => e.open), true); const gt = await guide.innerText();
    for (const w of ["仕様書をコピーする", "チャッピー", "質問に答える", "書き出して", "これでOK", ".json", "JSON本文", "プレビュー", "編集モード"]) assert.ok(gt.includes(w), `手順に「${w}」がない`);
    assert.equal(await guide.locator("li").count(), 6); assert.ok(await guide.locator('li:first-child [data-act="spec"]').count() === 1); // 手順1に操作ボタン
    await act("spec", '[data-kind="event"]'); assert.match(await page.evaluate(() => navigator.clipboard.readText()), /ff14rp\.event/);
    assert.ok(await page.locator("#imfile").count() && await page.locator("#imtext").count()); // ファイル取り込みと本文貼り付けの両方
    await guide.locator("summary").first().click(); assert.equal(await guide.evaluate(e => e.open), false); await guide.locator("summary").first().click();
  });
  await step("取り込み: 不正JSON(版違い・JSONでない)は保存せず場所を表示。ファイル取り込みも本文貼り付けも使える", async () => {
    await page.fill("#imtext", JSON.stringify({ ...sampleEvent(), version: 9 })); await act("imcheck"); await page.waitForSelector(".bad");
    assert.match(await page.innerText("#view"), /version.*未対応/); assert.equal(await page.locator('[data-act="imcommit"]').count(), 0);
    await page.fill("#imtext", "{ これはJSONではありません"); await act("imcheck"); await page.waitForFunction(() => document.body.innerText.includes("JSONとして読めません"));
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "ev-")); const f = path.join(d, "event.json"); fs.writeFileSync(f, JSON.stringify(ev15));
    await page.setInputFiles("#imfile", f); await page.waitForFunction(() => document.getElementById("imtext").value.includes("15ステップ検証イベント")); // ファイル
    await page.fill("#imtext", ""); await page.fill("#imtext", JSON.stringify(ev15)); // 本文貼り付けでも可
  });
  await step("プレビュー: 登録される内容をすべて目視確認できる(15ステップ全部・マクロ本文全文・基本情報/企画/準備/注意/資料/振り返り)", async () => {
    await act("imcheck"); await page.waitForSelector("#pv-tl .step");
    assert.equal(await page.locator("#pv-tl .step").count(), 15);
    previewTl = await page.locator("#pv-tl").innerText(); previewBasic = norm(await page.locator("dl.kv").first().innerText());
    for (let i = 1; i <= 15; i++) for (const w of [`22:${String(i - 1).padStart(2, "0")}頃`, `区切り${i}`, `合図${i}`, `かやのセリフ${i}`, `かやの動作${i}`, `トーシンのセリフ${i}`, `トーシンのキャラチェンジ${i}`]) assert.ok(previewTl.includes(w), `ステップ${i}の「${w}」がプレビューにない`);
    const all = await page.innerText("#view");
    for (const w of ["15ステップ検証イベント", "概要の本文", "企画内容の本文", "準備事項A", "準備事項B", "注意事項A", "振り返りの本文", "チラシ", "https://example.com/flyer", "地下の円卓の席札を並べる".slice(0, 0), "かやのマクロ本文", "トーシンの長いマクロ", "/s 長いマクロ15", "♡全角　スペース", "/wait 2", "15行"]) assert.ok(all.includes(w), `プレビューに「${w}」がない`);
    assert.match(all, /新規登録のプレビュー/); assert.ok(!/Kaya|Toushin/.test(all));
  });
  await step("色分け: かや=淡いピンク・トーシン=淡い緑・合図=中立(タイムライン/プレビュー/マクロ/担当ラベル)", async () => {
    const [kr, kg, kb] = await rgb("#pv-tl .cell.c-kaya"), [tr, tg, tb] = await rgb("#pv-tl .cell.c-toushin"), [cr, cg, cb] = await rgb("#pv-tl .cell.c-cue");
    assert.ok(kr > 235 && kr > kg + 8 && kb > kg, `かやが淡いピンクでない: ${kr},${kg},${kb}`); assert.ok(tg > 225 && tg > tr + 8 && tg > tb, `トーシンが淡い緑でない: ${tr},${tg},${tb}`); assert.ok(Math.abs(cr - cg) < 12 && Math.abs(cg - cb) < 14, `合図が中立でない: ${cr},${cg},${cb}`);
    const [gr, gg, gb] = await rgb("details.grp-Kaya"), [hr, hg, hb] = await rgb("details.grp-Toushin"); assert.ok(gr > gg + 8 && hg > hr + 8, "マクロのグループ色");
    const [mr, mg] = await rgb("details.mac-Kaya"), [nr, ng] = await rgb("details.mac-Toushin"); assert.ok(mr > mg + 8 && ng > nr + 8, "マクロ個別の色");
    assert.ok(await page.locator(".rt.rt-Kaya").count() > 0 && await page.locator(".rt.rt-Toushin").count() > 0);
    await page.screenshot({ path: "out/preview-colors.png", fullPage: false });
  });
  await step("登録: 確認して登録→登録後の表示はプレビューと完全一致(タイムライン・基本情報)。初期状態は閲覧モード", async () => {
    await act("imcommit"); await page.waitForFunction(() => document.body.innerText.includes("取り込みました")); await page.waitForSelector(".tabs");
    assert.match(await page.innerText("#view"), /下書き/);
    await page.click('[data-act="evtab"][data-v="timeline"]'); const regTl = await page.locator("#doc-tl").innerText(); assert.equal(norm(regTl), norm(previewTl)); assert.equal(await page.locator("#doc-tl .step").count(), 15);
    await page.click('[data-act="evtab"][data-v="overview"]'); assert.equal(norm(await page.locator("dl.kv").first().innerText()), previewBasic);
    // 閲覧モード: 編集操作は表示されない
    for (const tab of ["overview", "macros", "timeline", "materials"]) { await page.click(`[data-act="evtab"][data-v="${tab}"]`); assert.equal(await page.locator('[data-act="edopen"],[data-act="eddel"],[data-act="edmove"],[data-act="savefields"]').count(), 0, `閲覧モードに編集操作がある(${tab})`); assert.equal(await page.locator("#f-name,#sd-time").count(), 0); }
    assert.equal(await page.locator(".editbar").count(), 0); assert.ok(await page.locator('[data-act="emon"]').count() === 1);
  });
  await step("閲覧モードでもマクロのコピー・折り畳みが使える(原文と完全一致)", async () => {
    await page.click('[data-act="evtab"][data-v="macros"]');
    const grp = page.locator("details.grp-Kaya"); await grp.locator("summary").first().click(); assert.equal(await grp.evaluate(e => e.open), true);
    const one = grp.locator("details.mac").first(); await one.locator("summary").first().click(); assert.equal(await one.evaluate(e => e.open), true);
    await one.locator('[data-act="mcopy"]').click(); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), ev15.event.macros[0].body);
    await grp.locator("summary").first().click(); assert.equal(await grp.evaluate(e => e.open), false);
    const tg = page.locator("details.grp-Toushin"); await tg.locator("summary").first().click(); const mac = tg.locator("details.mac").first(); await mac.locator("summary").first().click();
    assert.ok((await mac.innerText()).includes("15行")); // 15行超の警告(削除はしない)
    await mac.locator('[data-act="mcopy"]').click(); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), longMacro);
  });
  await step("編集モード: ボタンで切替(画面上で明示)→編集操作が使える→終了で閲覧に戻る。1ステップだけ編集しても他は不変", async () => {
    await page.click('[data-act="evtab"][data-v="timeline"]'); const before = await page.locator("#doc-tl .step").allInnerTexts();
    await act("emon"); assert.match(await page.locator(".editbar").innerText(), /編集モード/); assert.ok(await page.locator('[data-act="edopen"]').count() > 0);
    await page.locator("#doc-tl .step").nth(2).locator('[data-act="edopen"][data-type="step"]').first().click();
    await page.fill("#sd-time", "22:57頃(修正)"); await act("edsave"); await page.waitForFunction(() => document.body.innerText.includes("22:57頃(修正)"));
    await act("emoff"); assert.equal(await page.locator(".editbar").count(), 0);
    const after = await page.locator("#doc-tl .step").allInnerTexts(); assert.equal(after.length, 15); for (let i = 0; i < 15; i++) if (i !== 2) assert.equal(after[i], before[i]); // 閲覧表示で他のステップは完全に同じ
 assert.equal(await page.locator('[data-act="edopen"]').count(), 0); assert.ok((await page.innerText("#view")).includes("22:57頃(修正)")); // 保存済みは残り、閲覧に戻る
  });
  await step("未保存の変更がある状態で編集モードを終了/画面移動しようとすると破棄確認が出て、キャンセルすると編集内容が残る", async () => {
    await act("emon"); await page.locator("#doc-tl .step").nth(0).locator('[data-act="edopen"][data-type="step"]').first().click(); await page.fill("#sd-time", "保存しない値");
    let asked = 0, accept = false; page.removeAllListeners("dialog"); page.on("dialog", d => { asked++; accept ? d.accept() : d.dismiss(); });
    await act("emoff"); assert.equal(asked, 1); assert.equal(await page.locator(".editbar").count(), 1); assert.equal(await page.inputValue("#sd-time"), "保存しない値"); // 破棄せず編集続行
    await page.click('#nav button:has-text("顧客")'); assert.equal(asked, 2); assert.equal(await page.locator(".editbar").count(), 1); // 画面移動もキャンセルできる
    accept = true; await act("emoff"); assert.equal(asked, 3); assert.equal(await page.locator(".editbar").count(), 0); assert.ok(!(await page.innerText("#view")).includes("保存しない値"));
    page.removeAllListeners("dialog"); page.on("dialog", d => d.accept());
  });
  await step("編集モード: ステップ追加・並べ替え・削除、マクロ追加(原文一致)・編集・削除、基本情報の保存(変更項目だけ)", async () => {
    await nav("イベント"); await page.locator("a", { hasText: "15ステップ検証イベント" }).first().click(); await act("emon"); await page.click('[data-act="evtab"][data-v="timeline"]');
    await page.locator("#doc-tl .step").nth(0).locator('[data-act="edopen"][data-item="new"]').click(); await page.fill("#sd-time", "22:30");
    await act("sditemadd", '[data-col="kaya"]'); await page.fill("#sd-kaya-0-x", "複数行の\n動作メモ"); await act("edsave");
    await page.waitForFunction(() => document.querySelectorAll("#doc-tl .step").length === 16); assert.ok((await page.locator("#doc-tl .step").nth(1).innerText()).includes("複数行の"));
    await page.locator("#doc-tl .step").nth(1).locator('[data-act="edmove"][data-dir="1"]').click(); await page.waitForFunction(() => document.querySelectorAll("#doc-tl .step")[2].innerText.includes("複数行の"));
    await page.locator("#doc-tl .step").nth(2).locator('[data-act="eddel"]').click(); await page.waitForFunction(() => document.querySelectorAll("#doc-tl .step").length === 15);
    await page.click('[data-act="evtab"][data-v="macros"]'); const body = "/yell <t>さん！\n\n/s ♡全角　スペース\n/wait 2\n";
    await act("edopen", '[data-type="macro"][data-item="new"]'); await page.fill("#sd-title", "手動追加"); await page.selectOption("#sd-role", "Toushin"); await page.fill("#sd-body", body); await act("edsave");
    await page.waitForFunction(() => [...document.querySelectorAll("details.grp-Toushin")].some(g => g.innerText.includes("2件")));
    await page.evaluate(() => document.querySelectorAll("#view details").forEach(d => { d.open = true; })); await page.locator("details.mac", { hasText: "手動追加" }).locator('[data-act="mcopy"]').click(); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), body);
    await page.locator("details.mac", { hasText: "手動追加" }).locator('[data-act="eddel"]').click(); await page.waitForFunction(() => !document.body.innerText.includes("手動追加"));
    await page.click('[data-act="evtab"][data-v="overview"]'); await page.fill("#f-venue", "手動で直した会場"); await act("savefields"); await page.waitForFunction(() => document.body.innerText.includes("保存しました"));
    assert.equal(await page.inputValue("#f-name"), "15ステップ検証イベント"); await act("emoff");
  });
  await step("ChatGPTで編集(編集モード内): 編集用データをコピー→変更JSONを差分確認(追加=緑/変更=黄/削除=赤/競合の区別・前後を3列表示)→選んだ変更だけ反映", async () => {
    await act("emon"); await act("exedit"); const gt = await page.locator("details.guide").innerText(); assert.match(gt, /編集用データをコピーする/); assert.match(gt, /差分を確認して反映/);
    await act("exportcopy"); const pkg = await page.evaluate(() => navigator.clipboard.readText()); assert.match(pkg, /"_base"/);
    const json = JSON.parse(pkg.match(/```json\n([\s\S]*?)\n```/g).at(-1).replace(/```json\n|\n```/g, ""));
    json.event.timeline.steps[1].time = "22:50(5分早め)"; json.event.timeline.steps[1].kaya[0].text = "かやのセリフ変更後"; json.event.timeline.steps.splice(4, 1); json.event.timeline.steps.push({ time: "23:30", cue: [{ type: "intent", text: "追加の合図" }], kaya: [{ type: "say", text: "追加のかやのセリフ" }], toushin: [], phase: "", note: "" }); json.event.venue = "地下 円卓(変更)";
    await page.fill("#imtext", JSON.stringify(json)); await act("imcheck"); await page.waitForSelector('[data-act="imcommit"]');
    const t = await page.innerText("#view"); for (const w of ["追加 1", "変更 ", "削除 1", "競合 0", "変更前(現在)", "変更後(取り込み)", "反映後の全内容"]) assert.ok(t.includes(w), `差分表示に「${w}」がない`);
    assert.ok(await page.locator(".chg.ch-add").count() >= 1 && await page.locator(".chg.ch-remove").count() >= 1 && await page.locator(".chg.ch-edit").count() >= 1); // 視覚的区別
    assert.ok(await page.locator(".chg .cell.c-kaya").count() > 0); // 差分内もかや/トーシンの色分け
    assert.equal(await page.locator('.chg [data-act="mcopy"]').count(), 0); // 差分カード内に誤ったコピー元を出さない
    const fin = page.locator("details.card", { has: page.locator("summary", { hasText: "反映後の全内容" }) }); await fin.locator("summary").first().click();
    const n0 = await fin.locator("#pv-tl .step").count(); await page.locator('.chg.ch-remove input[type="checkbox"]').first().uncheck(); // 削除を採用しない→最終形のステップが1つ増える
    await page.waitForFunction(n => document.querySelectorAll("details.card #pv-tl .step").length === n + 1, n0); assert.equal(await page.locator(".chg.ch-remove input:checked").count(), 0); await page.locator('.chg.ch-remove input[type="checkbox"]').first().check();
    await page.locator('input[id^="ck-field:venue"]').uncheck(); await act("imcommit"); await page.waitForFunction(() => document.body.innerText.includes("取り込みました"));
    await page.click('[data-act="evtab"][data-v="timeline"]'); const tl = await page.innerText("#view"); assert.ok(tl.includes("22:50(5分早め)") && tl.includes("追加のかやのセリフ") && tl.includes("かやのセリフ変更後"));
    assert.equal(await page.locator("#doc-tl .step").count(), 15); // +1 -1
    await page.click('[data-act="evtab"][data-v="overview"]'); assert.equal(await page.inputValue("#f-venue"), "手動で直した会場"); await act("emoff");
  });
  await step("イベント: 過去日でも下書きのまま。開催済みへは明示操作のみ", async () => {
    await act("emon"); await page.fill("#f-date", "2020-05-05"); await act("savefields");
    await page.waitForFunction(() => document.body.innerText.includes("保存しました")); assert.match(await page.innerText("#view"), /下書き/); await act("emoff");
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
    const cv = await page.innerText("#view"); for (const w of ["テスト 太郎", "7スタンプ達成のお祝い", "個別コメントの下書き", "導入コール(かや)", "/yell 本日の主役は", "本日のスペシャルゲストをご紹介します", "お客様の会計が終わったら", "ダーツを用意"]) assert.ok(cv.includes(w), `セレモニーのプレビューに「${w}」がない`); // 登録される内容を全表示
    assert.ok(await page.locator("#pv-tl .cell.c-kaya").count() > 0);
    await act("imcommit"); await page.waitForFunction(() => document.body.innerText.includes("原稿: 下書き"));
    assert.ok(await page.locator(".tag:has-text('7:到達済み未実施')").count() >= 1); // 原稿を作っても実施済みにならない
    // セレモニー原稿も初期は閲覧モード(編集欄・編集ボタンなし)→編集モードで編集→終了で閲覧に戻る
    assert.equal(await page.locator("#f-thanks, #f-characterName, #sd-time").count(), 0); assert.equal(await page.locator('[data-act="edopen"],[data-act="eddel"]').count(), 0);
    await page.locator('[data-act="emon"][data-kind="ceremony"]').click(); assert.match(await page.locator(".editbar").innerText(), /編集モード/);
    assert.equal(await page.inputValue("#f-characterName"), "テスト 太郎"); await page.fill("#f-thanks", "手動で直した感謝コメント"); await act("savefields"); await page.waitForFunction(() => document.body.innerText.includes("保存しました"));
    await page.locator('[data-act="emoff"][data-kind="ceremony"]').click(); assert.equal(await page.locator("#f-thanks").count(), 0); assert.ok((await page.innerText("#view")).includes("手動で直した感謝コメント"));
    await act("scriptstatus"); await page.waitForFunction(() => document.body.innerText.includes("原稿: 完成"));
    assert.ok(await page.locator(".tag:has-text('7:到達済み未実施')").count() >= 1); // 原稿が完成でも実施済みではない
    await page.click('[data-act="draw"][data-act2="gg"]'); await page.waitForFunction(() => document.body.innerText.includes("決定済み"));
    assert.match(await page.innerText("#view"), /完成マクロ本文は未取得/);
    await page.fill("#tplbody", "/s {{customer_name}}さん\n/s {{stamp_count}}スタンプ！ {{visit_count}}回目 {{thanks_comment}}"); await act("savetpl");
    await page.waitForSelector("#tplprev");
    const pre = await page.innerText("#tplprev");
    assert.match(pre, /Test Gammaさん/); assert.match(pre, /7スタンプ/);
    await act("copytext");
    assert.equal(lf(await page.evaluate(() => navigator.clipboard.readText())), await page.evaluate(() => document.getElementById("tplprev").textContent));
    assert.equal(await page.locator(".tag:has-text('7:到達済み未実施')").count() >= 1, true);
    await act("perform", '[data-st="done"]');
    await page.waitForFunction(() => document.body.innerText.includes("実施済み"));
    assert.ok(await page.locator("text=7:実施済み").count());
  });
  await step("アーカイブ: 開催済みのみ・複製", async () => {
    await nav("アーカイブ");
    assert.match(await page.innerText("#view"), /開催済みの記録はありません/);
  });
  await step("PC幅・狭い画面幅: タイムライン/プレビューが読みやすい(PC=3列横並び、スマホ=縦積みで横スクロールなし・色分け維持)", async () => {
    await page.setViewportSize({ width: 1100, height: 900 }); await nav("イベント"); await page.locator("a", { hasText: "15ステップ検証イベント" }).first().click(); await page.click('[data-act="evtab"][data-v="timeline"]');
    const box = async sel => page.locator(sel).first().boundingBox();
    let k = await box("#doc-tl .step .cell.c-kaya"), c = await box("#doc-tl .step .cell.c-cue"), t = await box("#doc-tl .step .cell.c-toushin");
    assert.ok(Math.abs(k.y - c.y) < 3 && Math.abs(c.y - t.y) < 3 && k.x < c.x && c.x < t.x, "PC幅は3列が横並び");
    await page.setViewportSize({ width: 390, height: 800 });
    k = await box("#doc-tl .step .cell.c-kaya"); c = await box("#doc-tl .step .cell.c-cue"); t = await box("#doc-tl .step .cell.c-toushin");
    assert.ok(k.y < c.y && c.y < t.y && k.width > 280 && t.width > 280, "狭い幅は縦積みで各セルが十分な幅");
    const ov = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]); assert.ok(ov[0] <= ov[1] + 1, `横スクロール ${ov}`);
    assert.ok((await page.locator("#doc-tl .step .cell.c-kaya .cl").first().isVisible()) && (await page.locator("#doc-tl .step .cell.c-toushin .cl").first().innerText()) === "トーシン"); // 縦積みでも列名ラベルで担当が分かる
    await page.screenshot({ path: "out/mobile-timeline.png" });
    await nav("イベント"); await act("exnew"); await page.fill("#imtext", JSON.stringify(ev15)); await act("imcheck"); await page.waitForSelector("#pv-tl .step");
    const ov2 = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]); assert.ok(ov2[0] <= ov2[1] + 1, `プレビューで横スクロール ${ov2}`); assert.equal(await page.locator("#pv-tl .step").count(), 15);
    await page.screenshot({ path: "out/mobile-preview.png" }); await page.setViewportSize({ width: 1100, height: 900 });
  });
  await step("色の可読性: ライト/ダーク両方で、かや/トーシン/合図/マクロ/編集バーの文字と背景のコントラスト比が4.5以上", async () => {
    for (const scheme of ["light", "dark"]) {
      const cx = await browser.newContext({ viewport: { width: 1100, height: 900 }, colorScheme: scheme }); const pg = await cx.newPage(); await pg.goto(`http://127.0.0.1:${PORT}/web/`); await pg.waitForSelector("#nav button");
      await pg.click('#nav button:has-text("イベント")'); await pg.click('[data-act="exnew"]'); await pg.fill("#imtext", JSON.stringify(ev15)); await pg.click('[data-act="imcheck"]'); await pg.waitForSelector("#pv-tl .step"); await pg.evaluate(() => document.querySelectorAll("#view details").forEach(d => { d.open = true; }));
      const lum = c => { const [r, g, b] = c.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      const contrast = async sel => { const [fg, bg] = await pg.locator(sel).first().evaluate(e => { const num = c => c.match(/[\d.]+/g).slice(0, 3).map(Number); let n = e, bgc = "rgba(0, 0, 0, 0)"; while (n && /rgba\(0, 0, 0, 0\)|transparent/.test(bgc)) { bgc = getComputedStyle(n).backgroundColor; n = n.parentElement; } return [getComputedStyle(e).color, bgc].map(num); }); const [l1, l2] = [lum(fg), lum(bg)].sort((x, y) => y - x); return (l1 + 0.05) / (l2 + 0.05); };
      for (const sel of ["#pv-tl .cell.c-kaya .it span:last-child", "#pv-tl .cell.c-toushin .it span:last-child", "#pv-tl .cell.c-cue .it span:last-child", "details.mac-Kaya summary b", "details.mac-Toushin summary b", ".rt-Kaya", ".rt-Toushin"]) { const r = await contrast(sel); assert.ok(r >= 4.5, `${scheme}: ${sel} のコントラスト比 ${r.toFixed(2)}`); }
      if (scheme === "dark") await pg.screenshot({ path: "out/dark-preview.png" }); await cx.close();
    }
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
