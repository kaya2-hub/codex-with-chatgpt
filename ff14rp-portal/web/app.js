import { bootstrap, loadAll } from "./data.js";
import { MASTER as M } from "../core/collections.js";
import { norm } from "../core/util.js";
import * as Op from "../core/identity-ops.js";
import * as Ev from "../core/events.js";
import * as Ce from "../core/ceremony.js";
import { personStats, STAMP_UNIT } from "../core/aggregate.js";
import { buildHistory } from "../core/history.js";
import { detectDrift } from "../core/drift.js";
import { preflight, setCutover } from "../core/cutover.js";
import { adoptDinerInfo, adoptDinerName, appendLegacyTokoNote, rescanPlan, candidateSummary } from "../core/adopt.js";
import { applyPlan } from "../tools/migrate-lib.js";
import { renderMacro, analyzeMacro, copyText } from "../core/macro.js";
import { roleJa } from "../core/roles.js";
import { exportDoc } from "../core/exchange.js";
import { ceremonyFacts, scriptId, setScriptStatus, createBlankDoc } from "../core/exchange-store.js";
import { createDocUI } from "./ui-docs.js";

const $ = s => document.querySelector(s);
const safeUrl = u => /^https?:\/\/\S+$/i.test(String(u ?? "").trim()) ? String(u).trim() : "";
const h = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const S = { boot: null, d: null, view: "home", edit: false, pid: null, q: "", evId: null, evTab: "overview", cer: {}, arch: {}, open: new Set(), ed: null, imp: null, exOpen: null };
const NAV = [["home", "HOME"], ["customers", "顧客"], ["candidates", "照合候補"], ["cutover", "切替"], ["events", "イベント"], ["ceremony", "セレモニー"], ["archive", "アーカイブ"]];
const label = () => $("#who").value;
const val = id => document.getElementById(id)?.value ?? "";
const STATUS_JA = { draft: "下書き", scheduled: "開催予定", postponed: "延期", cancelled: "中止", held: "開催済み" };

function toast(msg, bad = false) { const t = $("#toast"); t.textContent = msg; t.style.background = bad ? "#8a1c14" : "#333"; t.classList.add("on"); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("on"), bad ? 6000 : 2500); }
// 失敗時は入力内容を消さない(競合のときだけ最新を読み直す)
async function run(fn, okMsg, clearIds = []) { S.clear = new Set(clearIds); try { await fn(); if (okMsg) toast(okMsg); await refresh(); } catch (e) { console.warn(e); const conflict = e.code === "conflict"; toast(conflict ? `競合: ${e.message}(最新を読み込みました。内容を確認して再度保存してください)` : `失敗: ${e.message}`, true); if (conflict) { try { await refresh(); } catch {} } } }
async function refresh() { S.d = await loadAll(S.boot); render(); }

const chars = pid => S.d.characters.filter(c => c.personId === pid);
const nameOf = p => { const c = S.d.characters.find(x => x.id === p.primaryCharacterId) || chars(p.id)[0]; return c ? c.currentName : "(名前なし)"; };
const entryOf = pid => S.d.index.get(pid);
const stats = pid => personStats(entryOf(pid), S.d.shop);
const searchKeys = p => chars(p.id).flatMap(c => [c.currentName, ...c.previousNames, ...c.legacyNameCandidates]);
const active = () => S.d.persons.filter(p => !p.mergedInto);
const finder = q => { const k = norm(q); return active().filter(p => !k || searchKeys(p).some(n => norm(n).includes(k))); };
const nameTags = pid => { const e = entryOf(pid); const sys = new Set(e.links.map(l => l.sourceSystem)); return `${sys.has("diner") ? '<span class="tag diner">ダイナー</span>' : ""}${sys.has("toko") ? '<span class="tag toko">常若亭</span>' : ""}${e.candidateLinks.length ? `<span class="tag warn">候補${e.candidateLinks.length}</span>` : ""}`; };
const shopLink = (k, t) => S.boot.links[k] && S.boot.links[k] !== "#" ? `<a class="b" href="${h(S.boot.links[k])}" target="_blank" rel="noopener">${t}</a>` : `<span class="tag">${t}(リンク未設定)</span>`;

function renderNav() { $("#nav").innerHTML = NAV.map(([k, t]) => `<button data-act="nav" data-v="${k}" ${S.view === k ? 'aria-current="page"' : ""}>${t}</button>`).join(""); }

// ---------- HOME ----------
function vHome() {
  const res = S.q ? finder(S.q).slice(0, 12) : [];
  const occ = Ev.todaysOccurrences(S.d.occs, today());
  const targets = ceremonyTargets().filter(t => t.units.some(u => u.status !== "done"));
  return `<div class="card"><input type="search" id="q" placeholder="キャラ名・現在名・旧名で検索" value="${h(S.q)}" data-act="homeq">
    ${res.map(p => `<div class="row"><a href="#" data-act="openp" data-id="${h(p.id)}">${h(nameOf(p))}</a>${nameTags(p.id)}</div>`).join("")}
    ${S.q && !res.length ? '<p class="mut">該当なし</p>' : ""}</div>
  <div class="card row"><b>店舗システム</b>${shopLink("diner", "Pixies' DINER")}${shopLink("toko", "妖精食堂 -常若亭-")}</div>
  <div class="card"><h2>本日(${today()})の営業・イベント</h2>${occ.length ? occ.map(o => `<div class="row"><span class="tag ${h(o.store)}">${h(o.store || "-")}</span><a href="#" data-act="openev" data-id="${h(o.id)}">${h(o.name)}</a><span class="tag">${STATUS_JA[o.status]}</span><a href="#" data-act="openev" data-id="${h(o.id)}" data-tab="timeline">タイムラインへ</a></div>`).join("") : '<p class="mut">予定未登録(営業日は推定しません。イベント画面から登録できます)</p>'}</div>
  ${targets.length ? `<div class="card"><h2>セレモニー</h2>${targets.map(t => `<div class="row"><a href="#" data-act="cerpick" data-id="${h(t.person.id)}">${h(nameOf(t.person))}</a>${t.units.filter(u => u.status !== "done").map(u => `<span class="tag warn">${u.stampValue}到達・${u.status === "carried" ? "持越" : "未実施"}</span>`).join("")}</div>`).join("")}</div>` : ""}`;
}

// ---------- 顧客 ----------
const verText = st => (st.diner === null ? "読込失敗" : st.diner.linked ? `${st.diner.verStamps}(${st.diner.verStamps % STAMP_UNIT}/${STAMP_UNIT}・到達${Math.floor(st.diner.verStamps / STAMP_UNIT)}回分)` : "—");
const visitsText = st => (st.total != null ? `${st.total}回` : st.diner === null || st.toko === null ? "読込失敗" : "不明");
const dmText = p => (safeUrl(p.xDmUrl) ? `<a href="${h(safeUrl(p.xDmUrl))}" target="_blank" rel="noopener noreferrer">DMを開く</a>` : p.xDmUrl ? '<span class="warn">DM形式不正</span>' : '<span class="mut">DMなし</span>');
function vCustomers() {
  if (S.pid) return vPerson();
  const list = finder(S.q);
  return `<div class="card"><input type="search" id="q" placeholder="検索(名前・旧名)" value="${h(S.q)}" data-act="custq"></div>
  <div class="card clist"><div class="crow head"><span>顧客名</span><span>店舗</span><span>総合来店回数</span><span>XのDM</span><span>Verスタンプ(保存済み♥)</span></div>
  ${list.map(p => { const st = stats(p.id); return `<div class="crow"><span><a href="#" data-act="openp" data-id="${h(p.id)}"><b>${h(nameOf(p))}</b></a></span><span>${nameTags(p.id)}</span><span data-l="総合来店回数">${h(visitsText(st))}</span><span data-l="XのDM">${dmText(p)}</span><span data-l="Verスタンプ">${h(verText(st))}</span></div>`; }).join("") || '<p class="mut">該当なし</p>'}</div>`;
}
function vPerson() {
  const p = S.d.persons.find(x => x.id === S.pid); if (!p) return "<p>人物が見つかりません</p>";
  const e = entryOf(p.id); if (!e) return `<p>この人物は統合済みです。<a href="#" data-act="openp" data-id="${h(p.mergedInto)}">統合先へ</a></p>`;
  const st = stats(p.id), hist = buildHistory(e, S.d.shop), drift = detectDrift(e, S.d.shop.diner?.customers) || [];
  const ed = S.edit;
  const num = v => v == null ? "不明" : v;
  const involved = new Set([p.id, ...e.characters.map(c => c.id), ...e.links.map(l => l.id)]);
  const myChanges = S.d.changes.filter(c => c.diffs.some(d => involved.has(d.id))).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 8);
  return `<div class="row"><a href="#" data-act="openp" data-id="">← 一覧</a><span class="grow"></span><button class="b ${ed ? "pri" : ""}" data-act="toggleedit">${ed ? "編集モード中(閲覧へ)" : "編集モード"}</button></div>
  <div class="card"><h2>${h(nameOf(p))} ${nameTags(p.id)}</h2>
  ${e.characters.map(c => `<div><b>${h(c.currentName)}</b> ${c.previousNames.length ? `<span class="mut">旧名: ${c.previousNames.map(h).join(", ")}</span>` : ""}
    ${c.legacyNameCandidates.map(n => `<span class="tag warn">旧名候補(未分類): ${h(n)}</span>${ed ? ` <button class="b" data-act="legacy" data-c="${h(c.id)}" data-n="${h(n)}" data-d="rename">改名前の名前</button><button class="b" data-act="legacy" data-c="${h(c.id)}" data-n="${h(n)}" data-d="separate">別キャラ</button><button class="b" data-act="legacy" data-c="${h(c.id)}" data-n="${h(n)}" data-d="ignore">無視</button>` : ""}`).join(" ")}
    ${ed ? `<input type="text" id="rn-${h(c.id)}" placeholder="新しい名前" style="width:160px"><button class="b" data-act="rename" data-c="${h(c.id)}">改名</button>${e.characters.length > 1 ? `<button class="b dng" data-act="split" data-c="${h(c.id)}">人物から分離</button>` : ""}` : ""}</div>`).join("")}
  ${ed ? `<div class="row"><input type="text" id="newchar" placeholder="別キャラを追加(同一人物)" style="max-width:260px"><button class="b" data-act="addchar" data-id="${h(p.id)}">追加</button></div>` : ""}</div>
  <div class="card"><h3>来店・スタンプ(別指標)</h3><table>
   <tr><th></th><th>来店回数</th><th>Verスタンプ(保存済み♥)</th><th>注記</th></tr>
   <tr><td><span class="tag diner">ダイナー</span></td><td>${st.diner ? num(st.diner.visits) : "読込失敗"}</td><td>${st.diner?.linked ? `${st.diner.verStamps}(${st.diner.verStamps % STAMP_UNIT}/${STAMP_UNIT}・到達${Math.floor(st.diner.verStamps / STAMP_UNIT)}回分)` : "-"}</td><td class="mut">${st.diner && !st.diner.linked ? "リンクなし" : ""}</td></tr>
   <tr><td><span class="tag toko">常若亭</span></td><td>${st.toko ? num(st.toko.visits) : "読込失敗"}</td><td>-</td><td class="mut">${st.toko?.unverifiableCount ? `営業回ID無し ${st.toko.unverifiableCount}件を含む` : ""}</td></tr>
   <tr><td><b>総合</b></td><td><b>${num(st.total)}</b></td><td></td><td class="mut">店舗合算(同一営業回は1回)</td></tr></table>
   ${st.notes.map(n => `<div class="warn mut">⚠ ${h(n)}</div>`).join("")}</div>
  ${drift.length ? `<div class="card"><h3 class="warn">ダイナー側の備考/DMが共通と異なります</h3><p class="mut">店舗画面が共通正本に切り替わるまで、ダイナー画面で編集した内容はここへ自動反映されません(自動同期・上書きはしません)。違う項目: ${[...new Set(drift.flatMap(d => d.missing ? ["元顧客が見つからない"] : d.fields.map(f => f === "xDmUrl" ? "DMリンク" : "備考")))].join("・")}</p></div>` : ""}
  ${e.candidateLinks.length ? `<div class="card"><h3>未確認の照合候補</h3>${e.candidateLinks.map(l => `<div class="row"><span class="tag warn">候補</span>${h(l.sourceSystem)}:${h(l.sourceId)}<a href="#" data-act="nav" data-v="candidates">確認へ</a></div>`).join("")}</div>` : ""}
  <div class="card"><h3>共通備考・XのDMリンク</h3>${(p.mergedFrom || []).map(m => `<details><summary class="mut">統合元の備考/DM(統合前の値・自動では合成しません)</summary><div style="white-space:pre-wrap">${h(m.customerNote) || "(備考なし)"}</div><div class="mut">${h(m.xDmUrl) || "DMなし"}</div></details>`).join("")}
   ${ed ? `<textarea id="note" style="white-space:pre-wrap;font-family:inherit">${h(p.customerNote)}</textarea><input type="text" id="dm" placeholder="https://x.com/…" value="${h(p.xDmUrl)}"><div class="row"><button class="b pri" data-act="saveinfo" data-id="${h(p.id)}" data-rev="${p.revision}">保存</button><span class="mut">DMリンクを変えても過去のVerスタンプ判定は変わりません(店舗データには書き込みません)</span></div>`
     : `<div style="white-space:pre-wrap">${h(p.customerNote) || '<span class="mut">備考なし</span>'}</div><div>${safeUrl(p.xDmUrl) ? `<a href="${h(safeUrl(p.xDmUrl))}" target="_blank" rel="noopener noreferrer">XのDMを開く</a>` : p.xDmUrl ? '<span class="warn">DMリンクの形式が不正です(編集モードで修正してください)</span>' : '<span class="mut">DMリンクなし</span>'}</div>`}</div>
  ${ed ? `<div class="card"><h3>人物の統合(誤登録の整理)</h3><div class="row"><select id="mergeinto" style="max-width:260px">${active().filter(x => x.id !== p.id).map(x => `<option value="${h(x.id)}">${h(nameOf(x))}(${h(x.id.slice(-8))}・${[...new Set(entryOf(x.id).links.map(l => l.sourceSystem === "diner" ? "ダ" : "常"))].join("")}・来店${stats(x.id).total ?? "?"})</option>`).join("")}</select><button class="b dng" data-act="merge" data-from="${h(p.id)}">この人物を選んだ人物へ統合</button></div><p class="mut">元データは消えません。履歴から取り消せます。</p></div>` : ""}
  <div class="card"><h3>来店・注文履歴(読み取り専用)</h3><table>${hist.map(r => `<tr><td>${h(r.date)}</td><td><span class="tag ${r.shop}">${r.shop === "diner" ? "ダイナー" : "常若亭"}</span></td><td>${h(r.name)}</td><td>${h(r.text)} ${r.ver ? h(r.ver) : ""}</td></tr>`).join("") || '<tr><td class="mut">履歴なし</td></tr>'}</table>
  <p class="mut">注文・来店の編集はそれぞれの店舗システムで行います。</p></div>
  ${myChanges.length ? `<div class="card"><h3>変更履歴</h3>${myChanges.map(c => `<div class="row"><span class="mut">${h(c.at.slice(0, 16))}</span>${h(c.kind)} <span class="mut">${h(roleJa(c.label))}</span>${c.undone ? '<span class="tag">取り消し済み</span>' : ed ? `<button class="b" data-act="undo" data-id="${h(c.id)}">取り消す</button>` : ""}</div>`).join("")}</div>` : ""}`;
}

// ---------- 照合候補 ----------
function vCandidates() {
  const cands = S.d.links.filter(l => l.linkStatus !== "confirmed");
  const held = cands.filter(l => l.linkStatus === "unresolved").length;
  if (!cands.length) return '<div class="card"><p>未確認の候補はありません</p></div>';
  const show = v => v ?? "-";
  return `<div class="card"><b>未確認 ${cands.length}件(うち保留 ${held}件)</b><p class="mut">名前の一致は候補にすぎません。自動では統合されません。確認するまで集計・共通備考には接続されません。<br>本人かどうかの判断材料: 来店日・来店数・旧名・備考/DMの有無(内容は表示しません)。分からなければ「保留」のままで構いません。</p></div>` + cands.map(l => {
    const sm = candidateSummary(l, S.d, S.d.shop, S.d.shop.toko?.profiles);
    return `<div class="card"><div class="row"><span class="tag toko">常若亭</span><b>${h(sm.toko.name)}</b><span class="mut">来店${sm.toko.visits}件・最終${h(show(sm.toko.lastVisit))}${sm.toko.hasLegacyNote ? "・旧備考あり" : ""}</span><span class="tag ${l.linkStatus === "unresolved" ? "" : "warn"}">${l.linkStatus === "unresolved" ? "保留中" : "未確認"}</span>${sm.ambiguous ? '<span class="tag warn">候補が複数(曖昧)</span>' : ""}</div>
    <table><tr><th>ダイナー側の候補</th><th>旧名</th><th>来店</th><th>Ver♥</th><th>最終来店</th><th>備考/DM</th></tr>${sm.candidates.map(c => `<tr><td><b>${h(c.name)}</b></td><td>${c.previousNames.map(h).join(", ") || "-"}</td><td>${c.dinerVisits}</td><td>${c.verStamps}</td><td>${h(show(c.lastVisit))}</td><td>${c.hasNote ? "備考" : ""} ${c.hasDm ? "DM" : ""}</td></tr>`).join("")}</table>
    <div class="row"><label>確定先の人物<select id="cp-${h(l.id)}">${sm.candidates.map(c => `<option value="${h(c.personId)}">${h(c.name)}</option>`).join("")}</select></label>
    <label>この常若亭の客のキャラ名<input type="text" id="cn-${h(l.id)}" value="${h(sm.toko.name)}"></label></div>
    <div class="row"><button class="b pri" data-act="candconfirm" data-id="${h(l.id)}">同じ人物の別キャラとして確定</button><button class="b" data-act="candreject" data-id="${h(l.id)}">別人として確定(独立登録)</button><button class="b" data-act="candhold" data-id="${h(l.id)}">保留</button></div></div>`;
  }).join("");
}

// ---------- 切替(備考・DMの正本一本化) ----------
function preInputs() { return { persons: S.d.persons, links: S.d.links, characters: S.d.characters, dinerCustomers: S.d.shop.diner?.customers ?? null, tokoProfiles: S.d.shop.toko?.profiles ?? null }; }
function driftRows() {
  const out = []; const dc = S.d.shop.diner?.customers; if (!dc) return out;
  for (const c of dc) {
    const l = S.d.links.find(x => x.sourceSystem === "diner" && x.sourceId === c.id && x.linkStatus === "confirmed"); if (!l) continue;
    let p = S.d.persons.find(x => x.id === l.personId); let n = 0; while (p?.mergedInto && n++ < 5) p = S.d.persons.find(x => x.id === p.mergedInto); if (!p) continue;
    const ch = S.d.characters.find(x => x.id === l.characterId);
    const fields = []; if (String(c.customerNote ?? "").replace(/\r\n/g, "\n").trim() !== String(p.customerNote ?? "").trim()) fields.push("customerNote"); if (String(c.xDmUrl ?? "").trim() !== String(p.xDmUrl ?? "").trim()) fields.push("xDmUrl");
    const nameDiff = ch && c.customerName !== ch.currentName && !ch.previousNames.includes(c.customerName);
    if (fields.length || nameDiff) out.push({ c, p, ch, fields, nameDiff });
  }
  return out;
}
function vCutover() {
  const cut = S.d.cutover || {}; const modeJa = m => m === "master" ? "共通マスターが正本" : "従来(店舗内)";
  const sec = sys => {
    const pre = preflight(preInputs(), sys);
    return `<div class="card"><h2>${sys === "diner" ? "ダイナー" : "常若亭"} <span class="tag ${(cut[sys + "Mode"] || "off") === "master" ? "warn" : ""}">${modeJa(cut[sys + "Mode"])}</span></h2>
    ${pre.checks.map(c => `<div>${c.ok ? "✅" : c.blocking ? "❌" : "⚠️"} ${h(c.label)} <span class="mut">${h(c.detail)}</span></div>`).join("")}
    <div class="row"><button class="b pri" data-act="cutset" data-sys="${sys}" data-mode="master" ${pre.ok && (cut[sys + "Mode"] || "off") !== "master" ? "" : "disabled"}>共通マスターを正本にする</button><button class="b" data-act="cutset" data-sys="${sys}" data-mode="off" ${(cut[sys + "Mode"] || "off") === "master" ? "" : "disabled"}>従来に戻す(旧フィールドは凍結のまま保持)</button></div>
    <p class="mut">フラグだけを切り替えます。店舗アプリは「連携版」を配信するまで従来のまま動きます(手順は MIGRATION_RUNBOOK)。</p></div>`;
  };
  const rows = driftRows();
  const legacy = (S.d.shop.toko?.profiles || []).filter(p => String(p.notes ?? "").trim()).map(p => ({ p, l: S.d.links.find(x => x.sourceSystem === "toko" && x.sourceId === p.id && x.linkStatus === "confirmed") })).filter(x => x.l);
  return `<div class="card mut">備考・DMリンクの正本を共通マスターに一本化するための画面です。切替前にダイナー側/常若亭側の既存値を失わないよう、差異を確認して取り込み/維持を選びます。店舗側の元フィールドは削除・上書きしません。</div>
  ${sec("diner")}${sec("toko")}
  <div class="card"><h3>店舗の新規客を共通マスターへ追加(再スキャン)</h3><p class="mut">移行後に店舗で増えた顧客/プロフィールだけを追加します(既存は上書きしません・同名は候補として追加され自動統合しません)。</p><button class="b" data-act="rescan">再スキャンを実行</button></div>
  <div class="card"><h3>ダイナー側と共通で違う項目(${rows.length}件)</h3>${rows.map(r => `<div class="row"><b>${h(r.ch?.currentName ?? r.c.customerName)}</b>
    ${r.fields.includes("customerNote") ? `<span class="tag warn">備考が違う</span>` : ""}${r.fields.includes("xDmUrl") ? `<span class="tag warn">DMが違う</span>` : ""}${r.nameDiff ? `<span class="tag warn">名前が違う(ダイナー: ${h(r.c.customerName)})</span>` : ""}
    ${r.fields.map(f => `<button class="b" data-act="adopt" data-c="${h(r.c.id)}" data-f="${f}" data-p="${h(r.p.id)}" data-rev="${r.p.revision}">${f === "xDmUrl" ? "DM" : "備考"}をダイナー側の値で共通へ取り込む${String(r.c[f] ?? "").trim() === "" ? "(共通が空になります)" : ""}</button>`).join("")}
    ${r.nameDiff ? `<button class="b" data-act="adoptname" data-ch="${h(r.ch.id)}" data-n="${h(r.c.customerName)}">名前を改名として取り込む</button>` : ""}</div>
    ${r.fields.length ? `<details><summary class="mut">値を比較</summary><table><tr><th></th><th>ダイナー店舗側</th><th>共通(現在)</th></tr>${r.fields.map(f => `<tr><td>${f === "xDmUrl" ? "DM" : "備考"}</td><td style="white-space:pre-wrap">${h(r.c[f])}</td><td style="white-space:pre-wrap">${h(r.p[f])}</td></tr>`).join("")}</table></details>` : ""}`).join("") || '<p class="mut">差異なし</p>'}
    <p class="mut">「共通を維持」の場合は何もしなくて構いません(店舗側の値は凍結され、切替後は共通の値が表示されます)が、切替前チェックは差異が残っている間は通りません。差異を残したまま切り替えたい場合は、先に取り込みで揃えてください。</p></div>
  <div class="card"><h3>常若亭の旧備考(確認済みの人物のみ・参照用)</h3>${legacy.map(x => `<div class="row"><b>${h(x.p.name)}</b><details><summary class="mut">旧備考を見る</summary><div style="white-space:pre-wrap">${h(x.p.notes)}</div></details><button class="b" data-act="applegacy" data-id="${h(x.l.personId)}" data-n="${h(x.p.id)}">共通備考の末尾へ追記</button></div>`).join("") || '<p class="mut">該当なし</p>'}<p class="mut">常若亭の旧備考は自動では取り込まれません。必要なものだけ明示的に追記します(元の旧備考は削除されません)。</p></div>`;
}

// ---------- イベント ----------
const ui = createDocUI({ S, h, label, run, toast, copy, val, safeUrl, refresh: () => refresh(), today });
const cur = () => S.d.occs.find(o => o.id === S.evId);
function vEvents() {
  if (S.evId && cur()) return vOcc(cur());
  const list = S.d.occs.filter(o => o.status !== "held").sort((a, b) => (b.date || "9999").localeCompare(a.date || "9999"));
  return `<div class="card"><h2>イベント</h2><div class="row"><button class="b pri" data-act="exnew">ChatGPTで新規作成</button><input type="text" id="nename" placeholder="イベント名(手動で作る場合)" style="max-width:260px"><button class="b" data-act="newevent">＋手動で新規作成</button></div></div>
  ${S.exOpen === "new" ? ui.vExchange("event", null) : ""}
  <div class="card"><h3>開催回</h3>${list.map(o => `<div class="row"><a href="#" data-act="openev" data-id="${h(o.id)}">${h(o.name)}</a><span class="mut">${h(o.date || "日付未定")}</span><span class="tag ${h(o.store)}">${h(o.store === "diner" ? "ダイナー" : o.store === "toko" ? "常若亭" : "共通")}</span><span class="tag">${STATUS_JA[o.status]}</span>${Ev.isPastDate(o, today()) ? '<span class="tag warn">日付経過(状態は未変更)</span>' : ""}</div>`).join("") || '<p class="mut">まだありません。上のボタンから作成できます</p>'}</div>
  <details class="card"><summary class="mut">旧: イベントマスター(従来の複製元。既存データの互換のため残しています)</summary>${S.d.masters.map(m => `<div class="row"><b>${h(m.name)}</b><input type="date" id="od-${h(m.id)}" style="max-width:160px"><button class="b" data-act="mkocc" data-id="${h(m.id)}">開催回を作成(複製)</button></div>`).join("") || '<p class="mut">なし</p>'}</details>`;
}
function vOcc(o) {
  const { doc } = ui.docOf("event", o.id);
  const tabs = [["overview", "基本情報"], ["macros", "マクロ"], ["timeline", "タイムライン"], ["materials", "担当・資料・準備"]];
  const next = { draft: ["scheduled", "cancelled"], scheduled: ["held", "postponed", "cancelled", "draft"], postponed: ["scheduled", "cancelled"], cancelled: ["draft"], held: [] }[o.status];
  return `<div class="row"><a href="#" data-act="openev" data-id="">← 一覧</a></div>
  <div class="card"><h2>${h(doc.name)} <span class="tag">${STATUS_JA[o.status]}</span> <span class="tag ${h(o.store)}">${h(o.store === "diner" ? "ダイナー" : o.store === "toko" ? "常若亭" : "共通")}</span></h2>
   <div class="row"><button class="b pri" data-act="exedit" data-id="${h(o.id)}">ChatGPTで編集</button>${next.map(s => `<button class="b" data-act="status" data-id="${h(o.id)}" data-rev="${o.revision}" data-to="${s}">→ ${STATUS_JA[s]}</button>`).join("")}<button class="b" data-act="dup" data-id="${h(o.id)}">複製して新しい下書きを作る</button></div>
   ${o.status === "held" ? '<p class="mut">開催済み: 編集した場合は編集前の内容が履歴に残ります</p>' : ""}${o.copiedFrom ? '<p class="mut">過去の開催回から複製</p>' : ""}${o.timelineLegacy ? '<p class="mut">旧形式のタイムラインは新形式へ変換済み(元の内容は退避して保持しています)</p>' : ""}</div>
  ${S.exOpen === o.id ? ui.vExchange("event", o.id) : ""}
  <div class="tabs">${tabs.map(([k, t]) => `<button class="b" role="tab" data-act="evtab" data-v="${k}" aria-selected="${S.evTab === k}">${t}</button>`).join("")}</div>
  ${S.evTab === "overview" ? ui.vFields("event", o.id, doc, ["name", "store", "date", "startTime", "endTime", "venue", "overview", "plan", "memo"]) : ""}
  ${S.evTab === "macros" ? ui.vMacros("event", o.id, doc) : ""}${S.evTab === "timeline" ? ui.vTimeline("event", o.id, doc) : ""}
  ${S.evTab === "materials" ? ui.vStaff("event", o.id, doc) + ui.vMaterials("event", o.id, doc) + ui.vFields("event", o.id, doc, ["prep", "cautions"]) : ""}`;
}

// ---------- セレモニー ----------
function ceremonyTargets() {
  return active().map(p => { const st = stats(p.id); const recs = S.d.records; return { person: p, st, units: st.diner?.linked ? Ce.ceremonyStatus({ personId: p.id, verStamps: st.diner.verStamps, aliasIds: (p.mergedFrom || []).map(x => x.personId) }, recs) : [] }; }).filter(t => t.units.length);
}
function vCeremony() {
  const t = ceremonyTargets();
  const sel = S.cer.pid && t.find(x => x.person.id === S.cer.pid);
  let html = `<div class="card"><h2>対象者(Verスタンプ ${STAMP_UNIT}到達ごと)</h2><p class="mut">来店回数ではなくダイナーのVerスタンプ数(保存済み♥)から判定します。${STAMP_UNIT}スタンプごとに到達です(確定仕様)。到達・原稿の完成・実施済み・持ち越しはそれぞれ別に管理します。</p>
   ${t.map(x => `<div class="row"><a href="#" data-act="cerpick" data-id="${h(x.person.id)}">${h(nameOf(x.person))}</a>スタンプ ${x.st.diner.verStamps} ${x.units.map(u => `<span class="tag ${u.status === "done" ? "" : "warn"}">${u.stampValue}:${{ done: "実施済み", carried: "持越", reached_pending: "到達済み未実施" }[u.status]}</span>`).join("")}</div>`).join("") || '<p class="mut">対象者なし</p>'}</div>
   <div class="card"><h3>演目の状態</h3>${Object.values(Ce.ACTS).map(a => `<span class="tag ${a.state === "complete" ? "" : "warn"}">${h(a.name)}: ${h(a.note)}</span>`).join(" ")}</div>`;
  if (!sel) return html;
  const pend = sel.units.filter(u => u.status !== "done");
  const c = S.cer, date = c.date || today(), shop = c.shop || "diner";
  const draw = S.d.draws.find(d => d.id === `${shop}__${date}`);
  const act = draw?.act || null;
  const tpl = act ? S.d.templates.find(x => x.act === act) : null;
  const sv = Number(c.stamp || pend[0]?.stampValue || 0);
  const cname = c.cname || nameOf(sel.person);
  const total = sel.st.total;
  const vars = { customer_name: cname, visit_count: total == null ? undefined : total, stamp_count: sv, thanks_comment: c.thanks || "" };
  const r = tpl ? renderMacro(tpl.body, vars) : null;
  html += `<div class="card"><h2>${h(nameOf(sel.person))}さんのセレモニー準備</h2>
   <div class="row"><label>達成スタンプ<select id="cstamp" data-act="cerset">${pend.map(u => `<option value="${u.stampValue}" ${u.stampValue === sv ? "selected" : ""}>${u.stampValue}(${u.status === "carried" ? "持越" : "未実施"})</option>`).join("") || "<option>なし</option>"}</select></label>
   <label>当日使う呼称<select id="cname" data-act="cerset">${chars(sel.person.id).flatMap(ch => [ch.currentName, ...ch.previousNames]).map(n => `<option ${n === cname ? "selected" : ""}>${h(n)}</option>`).join("")}</select></label>
   <label>店舗<select id="cshop" data-act="cerset"><option value="diner" ${shop === "diner" ? "selected" : ""}>ダイナー</option><option value="toko" ${shop === "toko" ? "selected" : ""}>常若亭</option></select></label>
   <label>営業日<input type="date" id="cdate" value="${h(date)}" data-act="cerset"></label></div>
   <p>来店回数(人物・確認済み): <b>${total == null ? "不明(自動入力しません)" : total}</b> / Verスタンプ: <b>${sel.st.diner.verStamps}</b> ${sel.st.notes.map(n => `<span class="warn mut">⚠ ${h(n)}</span>`).join("")}</p>
   <p class="mut">この達成の原稿は下の「セレモニー原稿」で作成・編集します。原稿を作っても実施済みにはなりません。</p>
   <h3>ダーツの結果(${h(date)}・${shop === "diner" ? "ダイナー" : "常若亭"})</h3>
   ${draw ? `<p>この営業回の演目は <b>${h(Ce.ACTS[draw.act].name)}</b> に決定済み(最初の対象者: ${h(S.d.persons.find(p => p.id === draw.decidedFor) ? nameOf(S.d.persons.find(p => p.id === draw.decidedFor)) : draw.decidedFor)})。後続の対象者は同じ演目です。 <button class="b dng" data-act="cleardraw">結果を取り消す</button></p>`
     : `<div class="row"><button class="b" data-act="draw" data-act2="gg" data-p="${h(sel.person.id)}">GGコール</button><button class="b" data-act="draw" data-act2="monster" data-p="${h(sel.person.id)}">魔物ショー</button><span class="mut">その営業回で最初の対象者の結果のみ登録できます</span></div>`}
   ${act ? `<h3>${h(Ce.ACTS[act].name)}のマクロ</h3>${Ce.ACTS[act].state !== "complete" ? '<p class="warn">この演目は未完成の進行案段階です。本番利用の前に完成版を登録してください。</p>' : ""}
     ${tpl ? `<label>個別の感謝コメント<textarea id="cthanks" style="min-height:60px;white-space:pre-wrap" data-act="cerset">${h(c.thanks || "")}</textarea></label>
       <pre class="macro" id="tplprev">${h(r.text)}</pre>${r.missing.length ? `<p class="warn">未入力の変数: ${r.missing.map(h).join(", ")}(置換されていません)</p>` : ""}${analyzeMacro(r.text).warnings.map(w => `<div class="warn mut">⚠ ${h(w)}</div>`).join("")}
       <button class="b pri" data-act="copytext">マクロをコピー</button> <span class="mut">コピーしても実施済みにはなりません</span>`
       : `<p class="warn">${act === "gg" ? "GGコールの完成マクロ本文は未取得です。" : "この演目のマクロは未登録です。"}完成版をお持ちの場合は下に貼り付けて登録してください(創作・補完はしません)。</p>`}
     <h3>テンプレート登録/差し替え</h3><textarea id="tplbody" placeholder="{{customer_name}} {{visit_count}} {{stamp_count}} {{thanks_comment}} が使えます">${h(tpl?.body || "")}</textarea><button class="b" data-act="savetpl" data-a="${act}">${tpl ? "テンプレートを更新" : "テンプレートを登録"}</button>
     <h3>実施記録</h3><div class="row"><button class="b pri" data-act="perform" data-p="${h(sel.person.id)}" data-v="${sv}" data-a="${act}" data-st="done" ${pend.length ? "" : "disabled"}>実施済みとして記録</button><button class="b" data-act="perform" data-p="${h(sel.person.id)}" data-v="${sv}" data-a="${act}" data-st="carried" ${pend.length ? "" : "disabled"}>持ち越しにする</button></div>` : ""}</div>`;
  if (sv) html += vScript(sel, sv, cname, total, act);
  return html;
}

// ---------- セレモニー原稿(ChatGPT連携・手動編集) ----------
function factsFor(sel, sv, act) {
  const names = [...new Set(chars(sel.person.id).flatMap(c => [c.currentName, ...c.previousNames]))];
  const st = sel.units.find(u => u.stampValue === sv)?.status;
  return ceremonyFacts({ names, total: sel.st.total, verStamps: sel.st.diner?.verStamps, stampValue: sv, act: act ? Ce.ACTS[act].name : null, performance: { done: "実施済み", carried: "持ち越し", reached_pending: "到達済み・未実施" }[st] ?? "未到達(準備中)" });
}
function vScript(sel, sv, cname, total, act) {
  const pid = sel.person.id, id = scriptId(pid, sv), f = ui.docOf("ceremony", id), target = { personId: pid, stampValue: sv };
  S.cerCtx = { sel, sv, act };
  if (!f) return `<div class="card"><h2>セレモニー原稿(${sv}スタンプ) <span class="tag">原稿なし</span></h2><div class="row"><button class="b pri" data-act="exscript" data-key="new:${h(id)}">ChatGPTで作成</button><button class="b" data-act="scriptnew" data-p="${h(pid)}" data-v="${sv}">＋手動で原稿を作る</button></div></div>${S.exOpen === `new:${id}` ? ui.vExchange("ceremony", null, { target, scope: id }) : ""}`;
  const { doc, raw } = f;
  return `<div class="card"><h2>セレモニー原稿(${sv}スタンプ) <span class="tag ${raw.scriptStatus === "complete" ? "" : "warn"}">原稿: ${raw.scriptStatus === "complete" ? "完成" : "下書き"}</span></h2>
    <div class="row"><button class="b pri" data-act="exscript" data-key="${h(id)}">ChatGPTで編集</button><button class="b" data-act="scriptstatus" data-id="${h(id)}" data-to="${raw.scriptStatus === "complete" ? "draft" : "complete"}">${raw.scriptStatus === "complete" ? "下書きに戻す" : "原稿を完成にする"}</button></div>
    <p class="mut">「原稿の完成」は実施済みとは別です。実施済みは上の「実施記録」で記録した時だけになります。</p></div>
  ${S.exOpen === id ? ui.vExchange("ceremony", id, { target }) : ""}
  ${ui.vFields("ceremony", id, doc, ["characterName", "content", "thanks", "postNote", "prep"])}${ui.vStaff("ceremony", id, doc)}
  <div class="card"><h3>進行タイムライン</h3>${ui.vTimeline("ceremony", id, doc)}</div><div class="card"><h3>マクロ</h3>${ui.vMacros("ceremony", id, doc)}</div>`;
}

// ---------- アーカイブ ----------
function vArchive() {
  const a = S.arch;
  const res = Ev.searchArchive(S.d.occs, { store: a.store || undefined, name: a.name || undefined, year: a.year || undefined });
  return `<div class="card row"><select id="astore"><option value="">全店舗</option><option value="diner" ${a.store === "diner" ? "selected" : ""}>ダイナー</option><option value="toko" ${a.store === "toko" ? "selected" : ""}>常若亭</option></select><input type="text" id="aname" placeholder="イベント名" value="${h(a.name || "")}"><input type="text" id="ayear" placeholder="年(例 2026)" value="${h(a.year || "")}" style="max-width:120px"><button class="b" data-act="asearch">検索</button></div>
  <div class="card">${res.map(o => `<div class="row"><b>${h(o.name)}</b><span class="mut">${h(o.date || "")}</span><span class="tag ${h(o.store)}">${h(o.store || "共通")}</span><a href="#" data-act="openev" data-id="${h(o.id)}">開く</a><button class="b" data-act="dup" data-id="${h(o.id)}">次回の下書きに複製</button></div>`).join("") || '<p class="mut">開催済みの記録はありません</p>'}</div>`;
}

// ---------- 描画/イベント ----------
const viewKey = () => [S.view, S.pid, S.evId, S.evTab].join("|");
function render() {
  // 同じ画面の再描画では、入力中の値(未保存を含む)を保持する。画面が変わったら破棄。
  const key = viewKey(), typed = {};
  if (S.lastKey === key) document.querySelectorAll("#view [id]").forEach(el => { if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !S.clear?.has(el.id) && !/^(sd-|imfile)/.test(el.id)) typed[el.id] = el.value; });
  S.lastKey = key; S.clear = null;
  renderNav(); $("#banner").textContent = S.boot.banner;
  const v = { home: vHome, customers: vCustomers, candidates: vCandidates, cutover: vCutover, events: vEvents, ceremony: vCeremony, archive: vArchive }[S.view];
  const keep = document.activeElement?.id, pos = document.activeElement?.selectionStart;
  $("#view").innerHTML = v();
  for (const [id, v_] of Object.entries(typed)) { const el = document.getElementById(id); if (el && el.value !== v_ && !(el.tagName === "SELECT" && ![...el.options].some(o => o.value === v_))) el.value = v_; }
  if (keep) { const el = document.getElementById(keep); if (el && el.tagName !== "SELECT") { el.focus(); try { el.setSelectionRange(pos, pos); } catch {} } }
}
const L = () => ({ label: label() });
const setOcc = async (id, rev, patch) => Ev.editOccurrence(S.boot.store, id, Number(rev), patch, L());

const ACTIONS = {
  ...ui.actions,
  exnew: () => { S.exOpen = S.exOpen === "new" ? null : "new"; S.imp = null; render(); },
  exedit: d => { S.exOpen = S.exOpen === d.id ? null : d.id; S.imp = null; render(); },
  exscript: d => { S.exOpen = S.exOpen === d.key ? null : d.key; S.imp = null; render(); },
  newevent: () => run(async () => { S.evId = await createBlankDoc(S.boot.store, "event", { name: val("nename") }, L()); S.evTab = "overview"; }, "作成しました(下書き)", ["nename"]),
  scriptnew: d => run(async () => { await createBlankDoc(S.boot.store, "ceremony", { personId: d.p, stampValue: Number(d.v), characterName: S.cerCtx ? val("cname") : "" }, L()); }, "原稿(下書き)を作りました"),
  scriptstatus: d => run(() => setScriptStatus(S.boot.store, d.id, d.to, L()), d.to === "complete" ? "原稿を完成にしました(実施済みではありません)" : "下書きに戻しました"),
  nav: d => { S.view = d.v; S.pid = null; S.evId = null; S.q = ""; render(); },
  homeq: () => { S.q = val("q"); render(); }, custq: () => { S.q = val("q"); render(); },
  openp: d => { S.view = "customers"; S.pid = d.id || null; S.edit = false; render(); },
  toggleedit: () => { S.edit = !S.edit; render(); },
  saveinfo: d => run(() => Op.editPersonInfo(S.boot.store, d.id, Number(d.rev), { customerNote: val("note"), xDmUrl: val("dm") }, L()), "保存しました"),
  rename: d => run(() => Op.renameCharacter(S.boot.store, d.c, val("rn-" + d.c), L()), "改名しました(旧名は検索できます)", ["rn-" + d.c]),
  addchar: d => run(() => Op.addCharacter(S.boot.store, d.id, val("newchar"), L()), "別キャラを追加しました", ["newchar"]),
  legacy: d => run(() => Op.classifyLegacyName(S.boot.store, d.c, d.n, d.d, L()), "分類しました"),
  split: d => confirm("このキャラを別の人物として分離しますか?(履歴から取り消せます)") && run(() => Op.splitCharacter(S.boot.store, d.c, L()), "分離しました"),
  merge: d => { const sel = document.getElementById("mergeinto"); const from = S.d.persons.find(x => x.id === d.from); return confirm(`「${nameOf(from)}」を「${sel.options[sel.selectedIndex].text}」へ統合します。元データは残り、履歴から取り消せます。よろしいですか?`) && run(async () => { const into = val("mergeinto"); await Op.mergePersons(S.boot.store, d.from, into, L()); S.pid = into; }, "統合しました"); },
  undo: d => confirm("この操作を取り消しますか?") && run(() => Op.undoChange(S.boot.store, d.id, L()), "取り消しました"),
  candconfirm: d => confirm("同じ人物の別キャラとして確定します。よろしいですか?(履歴から取り消せます)") && run(() => Op.resolveCandidate(S.boot.store, d.id, "confirm", { targetPersonId: val("cp-" + d.id), characterName: val("cn-" + d.id), ...L() }), "確定しました"),
  candreject: d => confirm("別人として確定します(独立した人物として登録)。よろしいですか?") && run(() => Op.resolveCandidate(S.boot.store, d.id, "reject", { characterName: val("cn-" + d.id), ...L() }), "別人として登録しました"),
  candhold: d => run(() => Op.resolveCandidate(S.boot.store, d.id, "hold", L()), "保留にしました"),
  mkmaster: () => run(async () => { if (!val("mname").trim()) throw new Error("イベント名が必要です"); await Ev.createMaster(S.boot.store, { name: val("mname"), store: val("mstore") || null }); }, "追加しました", ["mname"]),
  mkocc: d => run(async () => { S.evId = await Ev.createOccurrence(S.boot.store, d.id, { date: val("od-" + d.id) || null }); S.evTab = "overview"; }, "開催回を作成しました"),
  openev: d => { S.view = "events"; S.evId = d.id || null; S.evTab = d.tab || "overview"; S.tl = null; render(); },
  evtab: d => { S.evTab = d.v; render(); },
  status: d => run(() => Ev.setStatus(S.boot.store, d.id, d.to, Number(d.rev), L()), "状態を変更しました"),
  dup: d => run(async () => { S.evId = await Ev.duplicateOccurrence(S.boot.store, d.id); S.view = "events"; S.evTab = "overview"; }, "複製しました(新しい下書き)"),
  copytext: () => copy(document.getElementById("tplprev").textContent),
  cutset: d => confirm(d.mode === "master" ? "共通マスターを正本にします(フラグのみの切替。店舗アプリが連携版でなければ従来のままです)。よろしいですか?" : "従来(店舗内)に戻します。よろしいですか?") && run(async () => { await refresh(); await setCutover(S.boot.store, d.sys, d.mode, preflight(preInputs(), d.sys), L()); }, "切替フラグを更新しました"),
  adopt: d => confirm("ダイナー店舗側の値を共通へ取り込みます(共通の現在値は上書きされます。履歴から取り消せます)。よろしいですか?") && run(() => adoptDinerInfo(S.boot.store, d.p, Number(d.rev), S.d.shop.diner.customers.find(x => x.id === d.c), d.f.split(","), L()), "取り込みました"),
  adoptname: d => confirm("ダイナー側の名前に改名として更新します(旧名は保持)。よろしいですか?") && run(() => adoptDinerName(S.boot.store, d.ch, d.n, L()), "改名として取り込みました"),
  applegacy: d => confirm("旧備考を共通備考の末尾へ追記します(元の旧備考は残ります)。よろしいですか?") && run(async () => { const p = S.d.persons.find(x => x.id === d.id); const prof = S.d.shop.toko.profiles.find(x => x.id === d.n); await appendLegacyTokoNote(S.boot.store, d.id, p.revision, prof.notes, L()); }, "追記しました"),
  rescan: () => run(async () => { const sh = S.d.shop; const plan = rescanPlan({ dinerCustomers: sh.diner?.customers ?? [], tokoProfiles: sh.toko?.profiles ?? [] }, `rescan-${Date.now().toString(36)}`); const r = await applyPlan(S.boot.store, plan); toast(`追加 ${r.created}件(既存で内容が違うため触れなかったもの ${r.skippedDiffering.length}件)`); }),
  asearch: () => { S.arch = { store: val("astore"), name: val("aname"), year: val("ayear") }; render(); },
  cerpick: d => { S.view = "ceremony"; S.cer = { pid: d.id }; render(); },
  cerset: () => { S.cer = { ...S.cer, stamp: val("cstamp"), cname: val("cname"), shop: val("cshop"), date: val("cdate"), thanks: document.getElementById("cthanks") ? val("cthanks") : S.cer.thanks }; render(); },
  draw: d => confirm(`${Ce.ACTS[d.act2].name}で確定します。この営業回(${val("cdate")})の全対象者に適用されます。よろしいですか?`) && run(() => Ce.recordDraw(S.boot.store, { storeId: val("cshop"), businessDate: val("cdate"), act: d.act2, personId: d.p, label: label() }), "ダーツの結果を登録しました"),
  savetpl: d => run(async () => { const ex = S.d.templates.find(t => t.act === d.a); if (!val("tplbody")) throw new Error("本文が空です"); if (ex) await S.boot.store.batch([{ op: "update", col: M.ceremonyTemplates, id: ex.id, expectedRevision: ex.revision, data: { body: val("tplbody") } }]); else await S.boot.store.batch([{ op: "create", col: M.ceremonyTemplates, id: "tpl-" + d.a, data: { act: d.a, body: val("tplbody") } }]); }, "テンプレートを保存しました"),
  cleardraw: () => confirm("この営業回のダーツ結果を取り消しますか?(実施/持越の記録がある場合は取り消せません)") && run(() => Ce.clearDraw(S.boot.store, { storeId: val("cshop"), businessDate: val("cdate") }), "ダーツ結果を取り消しました"),
  perform: d => confirm(d.st === "done" ? "実施済みとして記録します。よろしいですか?" : "持ち越しにします。よろしいですか?") && run(async () => {
    const p = S.d.persons.find(x => x.id === d.p); await Ce.recordPerformance(S.boot.store, { personId: d.p, characterId: p.primaryCharacterId, stampValue: Number(d.v), storeId: val("cshop"), businessDate: val("cdate"), act: d.a, label: label(), status: d.st });
  }, d.st === "done" ? "実施を記録しました" : "持ち越しにしました")
};
async function copy(text) { try { await navigator.clipboard.writeText(copyText(text)); toast("コピーしました"); } catch { const ta = document.createElement("textarea"); ta.value = text; document.body.append(ta); ta.select(); try { document.execCommand("copy"); toast("コピーしました"); } catch { toast("コピーに失敗しました。手動で選択してください", true); } ta.remove(); } }

S.render = render;
S.hooks = {
  skeleton: (pid, sv) => { const c = S.cerCtx; return { schema: "ff14rp.ceremony", version: 1, op: "create", target: { personId: pid, stampValue: sv }, facts: factsFor(c.sel, sv, c.act), ceremony: { characterName: "", content: "", thanks: "", staff: [], timeline: { version: 2, steps: [] }, macros: [], prep: [], postNote: "" } }; },
  exportCeremony: (raw, pid, sv) => exportDoc("ceremony", raw, { target: { personId: pid, stampValue: sv }, facts: factsFor(S.cerCtx.sel, sv, S.cerCtx.act) })
};
document.addEventListener("toggle", e => { const k = e.target?.dataset?.openKey; if (k) { if (e.target.open) S.open.add(k); else S.open.delete(k); } }, true);
document.addEventListener("click", e => { const t = e.target.closest("[data-act]"); if (!t || t.matches("input,select,textarea")) return; e.preventDefault(); const f = ACTIONS[t.dataset.act]; if (f) f({ ...t.dataset }); });
let composing = false;
document.addEventListener("compositionstart", () => { composing = true; });
document.addEventListener("compositionend", e => { composing = false; if (e.target.matches?.("input[type=search][data-act]")) ACTIONS[e.target.dataset.act]({}); });
document.addEventListener("input", e => { if (composing) return; const t = e.target; if (t.matches("input[type=search][data-act]")) ACTIONS[t.dataset.act]({}); });
document.addEventListener("change", e => { const t = e.target; if (t.matches("select[data-act],input[type=date][data-act],input[type=file][data-act],textarea[data-act]")) ACTIONS[t.dataset.act]({}); });

(async () => {
  try {
    S.boot = await bootstrap();
    S.boot.tokoNames = {};
    try { for (const p of await S.boot.src.toko.list("customerProfiles")) S.boot.tokoNames[p.id] = p.name; } catch {}
    await refresh();
  } catch (e) { console.error(e); $("#view").innerHTML = `<div class="card bad">起動に失敗しました: ${h(e.message)}</div>`; }
})();
