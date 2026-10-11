import { bootstrap, loadAll } from "./data.js";
import { MASTER as M } from "../core/collections.js";
import { norm } from "../core/util.js";
import * as Op from "../core/identity-ops.js";
import * as Ev from "../core/events.js";
import * as Ce from "../core/ceremony.js";
import { personStats, STAMP_UNIT } from "../core/aggregate.js";
import { buildHistory } from "../core/history.js";
import { detectDrift } from "../core/drift.js";
import { renderMacro, analyzeMacro, copyText } from "../core/macro.js";
import { parseTimeline, finalizeTimeline } from "../core/timeline.js";

const $ = s => document.querySelector(s);
const safeUrl = u => /^https?:\/\/\S+$/i.test(String(u ?? "").trim()) ? String(u).trim() : "";
const h = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const S = { boot: null, d: null, view: "home", edit: false, pid: null, q: "", evId: null, evTab: "overview", tl: null, cer: {}, arch: {} };
const NAV = [["home", "HOME"], ["customers", "顧客"], ["candidates", "照合候補"], ["events", "イベント"], ["ceremony", "セレモニー"], ["archive", "アーカイブ"]];
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
function vCustomers() {
  if (S.pid) return vPerson();
  const list = finder(S.q);
  return `<div class="card"><input type="search" id="q" placeholder="検索" value="${h(S.q)}" data-act="custq"></div>
  <div class="card">${list.map(p => `<div class="row"><a href="#" data-act="openp" data-id="${h(p.id)}">${h(nameOf(p))}</a>${nameTags(p.id)}</div>`).join("") || '<p class="mut">該当なし</p>'}</div>`;
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
  ${myChanges.length ? `<div class="card"><h3>変更履歴</h3>${myChanges.map(c => `<div class="row"><span class="mut">${h(c.at.slice(0, 16))}</span>${h(c.kind)} <span class="mut">${h(c.label)}</span>${c.undone ? '<span class="tag">取り消し済み</span>' : ed ? `<button class="b" data-act="undo" data-id="${h(c.id)}">取り消す</button>` : ""}</div>`).join("")}</div>` : ""}`;
}

// ---------- 照合候補 ----------
function vCandidates() {
  const cands = S.d.links.filter(l => l.linkStatus !== "confirmed");
  if (!cands.length) return '<div class="card"><p>未確認の候補はありません</p></div>';
  return `<div class="card mut">名前の一致は候補にすぎません。自動では統合されません。確認するまで集計に含まれません。</div>` + cands.map(l => {
    const pids = l.candidatePersonIds?.length ? l.candidatePersonIds : [l.personId];
    const tokoName = S.boot.tokoNames?.[l.sourceId] || l.sourceId;
    return `<div class="card"><div class="row"><span class="tag toko">常若亭</span><b>${h(tokoName)}</b><span class="tag ${l.linkStatus === "unresolved" ? "" : "warn"}">${l.linkStatus === "unresolved" ? "保留中" : "未確認"}</span>${l.basis === "ambiguous-name" ? '<span class="tag warn">候補が複数(曖昧)</span>' : ""}</div>
    <div class="row"><label>ダイナー側の候補人物<select id="cp-${h(l.id)}">${pids.map(pid => { const p = S.d.persons.find(x => x.id === pid); return p && !p.mergedInto ? `<option value="${h(pid)}">${h(nameOf(p))}</option>` : ""; }).join("")}</select></label>
    <label>この常若亭の客のキャラ名<input type="text" id="cn-${h(l.id)}" value="${h(tokoName)}"></label></div>
    <div class="row"><button class="b pri" data-act="candconfirm" data-id="${h(l.id)}">同じ人物の別キャラとして確定</button><button class="b" data-act="candreject" data-id="${h(l.id)}">別人として確定(独立登録)</button><button class="b" data-act="candhold" data-id="${h(l.id)}">保留</button></div></div>`;
  }).join("");
}

// ---------- イベント ----------
const cur = () => S.d.occs.find(o => o.id === S.evId);
function vEvents() {
  if (S.evId && cur()) return vOcc(cur());
  return `<div class="card"><h2>イベントマスター</h2>${S.d.masters.map(m => `<div class="row"><b>${h(m.name)}</b><span class="tag ${h(m.store)}">${h(m.store || "共通")}</span><input type="date" id="od-${h(m.id)}" style="max-width:160px"><button class="b" data-act="mkocc" data-id="${h(m.id)}">開催回を作成(マスターから複製)</button></div>`).join("") || '<p class="mut">まだありません</p>'}
   <div class="row"><input type="text" id="mname" placeholder="＋イベント名" style="max-width:260px"><select id="mstore" style="max-width:140px"><option value="">共通</option><option value="diner">ダイナー</option><option value="toko">常若亭</option></select><button class="b pri" data-act="mkmaster">イベント追加</button></div></div>
  <div class="card"><h2>開催回</h2>${S.d.occs.filter(o => o.status !== "held").sort((a, b) => (b.date || "9999").localeCompare(a.date || "9999")).map(o => `<div class="row"><a href="#" data-act="openev" data-id="${h(o.id)}">${h(o.name)}</a><span class="mut">${h(o.date || "日付未定")}</span><span class="tag">${STATUS_JA[o.status]}</span>${Ev.isPastDate(o, today()) ? '<span class="tag warn">日付経過(状態は未変更)</span>' : ""}</div>`).join("") || '<p class="mut">なし</p>'}</div>`;
}
function vOcc(o) {
  const tabs = [["overview", "概要"], ["macros", "マクロ"], ["timeline", "タイムライン"], ["materials", "資料"]];
  const next = { draft: ["scheduled", "cancelled"], scheduled: ["held", "postponed", "cancelled", "draft"], postponed: ["scheduled", "cancelled"], cancelled: ["draft"], held: [] }[o.status];
  return `<div class="row"><a href="#" data-act="openev" data-id="">← 一覧</a></div>
  <div class="card"><h2>${h(o.name)} <span class="tag">${STATUS_JA[o.status]}</span> <span class="tag ${h(o.store)}">${h(o.store || "共通")}</span></h2>
   <div class="row"><label>開催日<input type="date" id="odate" value="${h(o.date || "")}"></label><button class="b" data-act="setdate" data-id="${h(o.id)}" data-rev="${o.revision}">日付保存</button>
   ${next.map(s => `<button class="b" data-act="status" data-id="${h(o.id)}" data-rev="${o.revision}" data-to="${s}">→ ${STATUS_JA[s]}</button>`).join("")}<button class="b" data-act="dup" data-id="${h(o.id)}">複製して新しい下書きを作る</button></div>
   ${o.status === "held" ? '<p class="mut">開催済み: 編集した場合は編集前の内容が履歴に残ります</p>' : ""}${o.copiedFrom ? '<p class="mut">過去の開催回から複製</p>' : ""}</div>
  <div class="tabs">${tabs.map(([k, t]) => `<button class="b" role="tab" data-act="evtab" data-v="${k}" aria-selected="${S.evTab === k}">${t}</button>`).join("")}</div>
  ${S.evTab === "overview" ? `<div class="card"><textarea id="ovtext" style="white-space:pre-wrap;font-family:inherit">${h(o.overview)}</textarea><button class="b pri" data-act="saveov" data-id="${h(o.id)}" data-rev="${o.revision}">概要を保存</button>
     <h3>メモ・反省点</h3><textarea id="memo" style="white-space:pre-wrap;font-family:inherit">${h(o.memo)}</textarea><button class="b" data-act="savememo" data-id="${h(o.id)}" data-rev="${o.revision}">メモ保存</button></div>` : ""}
  ${S.evTab === "macros" ? vMacros(o) : ""}${S.evTab === "timeline" ? vTimeline(o) : ""}${S.evTab === "materials" ? vMaterials(o) : ""}`;
}
function vMacros(o) {
  const grp = r => o.macros.map((m, i) => ({ m, i })).filter(x => x.m.role === r);
  const block = r => `<div class="card"><h3>${r}</h3>${grp(r).map(({ m, i }) => { const a = analyzeMacro(m.body); return `<div><b>${h(m.title)}</b> <button class="b pri" data-act="copymacro" data-id="${h(o.id)}" data-i="${i}">コピー</button> <button class="b dng" data-act="delmacro" data-id="${h(o.id)}" data-rev="${o.revision}" data-i="${i}">削除</button><pre class="macro">${h(m.body)}</pre>${a.warnings.map(w => `<div class="warn mut">⚠ ${h(w)}</div>`).join("")}</div>`; }).join("") || '<p class="mut">なし</p>'}</div>`;
  return block("Kaya") + block("Toushin") + `<div class="card"><h3>マクロ追加(原文のまま保存)</h3><div class="row"><input type="text" id="mtitle" placeholder="題名" style="max-width:240px"><select id="mrole" style="max-width:140px"><option>Kaya</option><option>Toushin</option></select></div><textarea id="mbody" placeholder="/yell … ※改行・<t>・記号をそのまま貼り付け"></textarea><button class="b pri" data-act="addmacro" data-id="${h(o.id)}" data-rev="${o.revision}">追加</button></div>`;
}
function tlView(t) {
  return `<div class="cols3"><div class="h">Kaya</div><div class="h">タイミング・合図・共通条件</div><div class="h">Toushin</div>${t.rows.map(r => `${r.phase ? `<div class="mut" style="grid-column:1/-1">▼ ${h(r.phase)}</div>` : ""}<div class="cell">${h(r.kaya)}</div><div class="cell">${h(r.cue)}</div><div class="cell">${h(r.toushin)}</div>`).join("")}</div>${t.unclassified?.length ? `<p class="warn">未分類 ${t.unclassified.length}行: ${t.unclassified.map(u => h(u.text)).join(" / ")}</p>` : ""}`;
}
function vTimeline(o) {
  const d = S.tl;
  return `<div class="card"><h3>現在のタイムライン</h3>${o.timeline.rows.length || o.timeline.unclassified?.length ? tlView(o.timeline) : '<p class="mut">未登録</p>'}</div>
  <div class="card"><h3>自由文から3列に整理</h3><p class="mut">「Kaya:」「Toushin:」「共通:」「[00:30]」「Kaya｜合図｜Toushin」形式を認識します。認識できない行は未分類に残し、補完しません。</p>
  <textarea id="tlsrc" style="white-space:pre-wrap">${h(d?.sourceText ?? o.timeline.sourceText ?? "")}</textarea><button class="b" data-act="tlparse">プレビュー</button>
  ${d ? `<h3>プレビュー(編集できます)</h3>${d.rows.map((r, i) => `<div class="cols3" style="margin-bottom:6px"><input type="text" id="tk-${i}" value="${h(r.kaya)}"><input type="text" id="tc-${i}" value="${h(r.cue)}"><input type="text" id="tt-${i}" value="${h(r.toushin)}"></div>`).join("")}
   ${d.unclassified.length ? `<h3 class="warn">未分類(${d.unclassified.length}行)</h3>${d.unclassified.map((u, i) => `<div class="row"><span class="grow">${h(u.text)}</span><select id="ua-${i}"><option value="">未分類のまま</option><option value="kaya">Kayaへ</option><option value="cue">中央へ</option><option value="toushin">Toushinへ</option></select></div>`).join("")}` : ""}
   <button class="b pri" data-act="tlsave" data-id="${h(o.id)}" data-rev="${o.revision}">保存</button>` : ""}</div>`;
}
function vMaterials(o) {
  return `<div class="card">${o.materials.map((m, i) => `<div class="row"><b>${h(m.label)}</b>${safeUrl(m.url) ? `<a href="${h(safeUrl(m.url))}" target="_blank" rel="noopener noreferrer">${h(m.url)}</a>` : h(m.url)}<span class="mut">${h(m.note || "")}</span><button class="b dng" data-act="delmat" data-id="${h(o.id)}" data-rev="${o.revision}" data-i="${i}">削除</button></div>`).join("") || '<p class="mut">なし</p>'}
  <div class="row"><input type="text" id="matl" placeholder="名前" style="max-width:160px"><input type="text" id="matu" placeholder="URL(チラシ/Notion等)"><button class="b" data-act="addmat" data-id="${h(o.id)}" data-rev="${o.revision}">追加</button></div><p class="mut">リンクは失効することがあります。重要な資料は別途保管してください。</p></div>`;
}

// ---------- セレモニー ----------
function ceremonyTargets() {
  return active().map(p => { const st = stats(p.id); const recs = S.d.records; return { person: p, st, units: st.diner?.linked ? Ce.ceremonyStatus({ personId: p.id, verStamps: st.diner.verStamps, aliasIds: (p.mergedFrom || []).map(x => x.personId) }, recs) : [] }; }).filter(t => t.units.length);
}
function vCeremony() {
  const t = ceremonyTargets();
  const sel = S.cer.pid && t.find(x => x.person.id === S.cer.pid);
  let html = `<div class="card"><h2>対象者(Verスタンプ ${STAMP_UNIT}到達ごと)</h2><p class="mut">来店回数ではなくダイナーのVerスタンプ数(保存済み♥)から判定。単位は仮設定: ${STAMP_UNIT}(運用者確認事項)。</p>
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
   <h3>ダーツの結果(${h(date)}・${shop === "diner" ? "ダイナー" : "常若亭"})</h3>
   ${draw ? `<p>この営業回の演目は <b>${h(Ce.ACTS[draw.act].name)}</b> に決定済み(最初の対象者: ${h(S.d.persons.find(p => p.id === draw.decidedFor) ? nameOf(S.d.persons.find(p => p.id === draw.decidedFor)) : draw.decidedFor)})。後続の対象者は同じ演目です。 <button class="b dng" data-act="cleardraw">結果を取り消す</button></p>`
     : `<div class="row"><button class="b" data-act="draw" data-act2="gg" data-p="${h(sel.person.id)}">GGコール</button><button class="b" data-act="draw" data-act2="monster" data-p="${h(sel.person.id)}">魔物ショー</button><span class="mut">その営業回で最初の対象者の結果のみ登録できます</span></div>`}
   ${act ? `<h3>${h(Ce.ACTS[act].name)}のマクロ</h3>${Ce.ACTS[act].state !== "complete" ? '<p class="warn">この演目は未完成の進行案段階です。本番利用の前に完成版を登録してください。</p>' : ""}
     ${tpl ? `<label>個別の感謝コメント<textarea id="cthanks" style="min-height:60px;white-space:pre-wrap" data-act="cerset">${h(c.thanks || "")}</textarea></label>
       <pre class="macro">${h(r.text)}</pre>${r.missing.length ? `<p class="warn">未入力の変数: ${r.missing.map(h).join(", ")}(置換されていません)</p>` : ""}${analyzeMacro(r.text).warnings.map(w => `<div class="warn mut">⚠ ${h(w)}</div>`).join("")}
       <button class="b pri" data-act="copytext">マクロをコピー</button> <span class="mut">コピーしても実施済みにはなりません</span>`
       : `<p class="warn">${act === "gg" ? "GGコールの完成マクロ本文は未取得です。" : "この演目のマクロは未登録です。"}完成版をお持ちの場合は下に貼り付けて登録してください(創作・補完はしません)。</p>`}
     <h3>テンプレート登録/差し替え</h3><textarea id="tplbody" placeholder="{{customer_name}} {{visit_count}} {{stamp_count}} {{thanks_comment}} が使えます">${h(tpl?.body || "")}</textarea><button class="b" data-act="savetpl" data-a="${act}">${tpl ? "テンプレートを更新" : "テンプレートを登録"}</button>
     <h3>実施記録</h3><div class="row"><button class="b pri" data-act="perform" data-p="${h(sel.person.id)}" data-v="${sv}" data-a="${act}" data-st="done" ${pend.length ? "" : "disabled"}>実施済みとして記録</button><button class="b" data-act="perform" data-p="${h(sel.person.id)}" data-v="${sv}" data-a="${act}" data-st="carried" ${pend.length ? "" : "disabled"}>持ち越しにする</button></div>` : ""}</div>`;
  return html;
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
  if (S.lastKey === key) document.querySelectorAll("#view [id]").forEach(el => { if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !S.clear?.has(el.id)) typed[el.id] = el.value; });
  S.lastKey = key; S.clear = null;
  renderNav(); $("#banner").textContent = S.boot.banner;
  const v = { home: vHome, customers: vCustomers, candidates: vCandidates, events: vEvents, ceremony: vCeremony, archive: vArchive }[S.view];
  const keep = document.activeElement?.id, pos = document.activeElement?.selectionStart;
  $("#view").innerHTML = v();
  for (const [id, v_] of Object.entries(typed)) { const el = document.getElementById(id); if (el && el.value !== v_ && !(el.tagName === "SELECT" && ![...el.options].some(o => o.value === v_))) el.value = v_; }
  if (keep) { const el = document.getElementById(keep); if (el && el.tagName !== "SELECT") { el.focus(); try { el.setSelectionRange(pos, pos); } catch {} } }
}
const L = () => ({ label: label() });
const setOcc = async (id, rev, patch) => Ev.editOccurrence(S.boot.store, id, Number(rev), patch, L());

const ACTIONS = {
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
  setdate: d => run(() => setOcc(d.id, d.rev, { date: val("odate") || null }), "日付を保存しました"),
  dup: d => run(async () => { S.evId = await Ev.duplicateOccurrence(S.boot.store, d.id); S.view = "events"; S.evTab = "overview"; }, "複製しました(新しい下書き)"),
  saveov: d => run(() => setOcc(d.id, d.rev, { overview: val("ovtext") }), "保存しました"),
  savememo: d => run(() => setOcc(d.id, d.rev, { memo: val("memo") }), "保存しました"),
  addmacro: d => run(async () => { const o = S.d.occs.find(x => x.id === d.id); if (!val("mtitle").trim() || !val("mbody")) throw new Error("題名と本文が必要です"); await setOcc(d.id, d.rev, { macros: [...o.macros, { title: val("mtitle"), role: val("mrole"), body: val("mbody") }] }); }, "追加しました", ["mtitle", "mbody"]),
  delmacro: d => confirm("マクロを削除しますか?") && run(async () => { const o = S.d.occs.find(x => x.id === d.id); await setOcc(d.id, d.rev, { macros: o.macros.filter((_, i) => i !== Number(d.i)) }); }, "削除しました"),
  copymacro: d => copy(S.d.occs.find(x => x.id === d.id).macros[Number(d.i)].body),
  copytext: () => copy(document.querySelector("pre.macro").textContent),
  addmat: d => run(async () => { const o = S.d.occs.find(x => x.id === d.id); await setOcc(d.id, d.rev, { materials: [...o.materials, { label: val("matl") || val("matu"), url: val("matu") }] }); }, "追加しました", ["matl", "matu"]),
  delmat: d => run(async () => { const o = S.d.occs.find(x => x.id === d.id); await setOcc(d.id, d.rev, { materials: o.materials.filter((_, i) => i !== Number(d.i)) }); }, "削除しました"),
  tlparse: () => { S.tl = parseTimeline(val("tlsrc")); render(); },
  tlsave: d => run(async () => {
    const t = S.tl; const rows = t.rows.map((r, i) => ({ ...r, kaya: val("tk-" + i), cue: val("tc-" + i), toushin: val("tt-" + i) }));
    const rest = [];
    t.unclassified.forEach((u, i) => { const a = val("ua-" + i); if (a) rows.push({ phase: u.phase, kaya: "", cue: "", toushin: "", [a]: u.text, line: u.line, source: "manual", uncertain: true }); else rest.push(u); });
    const f = finalizeTimeline({ rows, unclassified: rest, sourceText: t.sourceText }, { acceptUnclassified: true });
    await setOcc(d.id, d.rev, { timeline: f.timeline }); S.tl = null;
  }, "タイムラインを保存しました"),
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

document.addEventListener("click", e => { const t = e.target.closest("[data-act]"); if (!t || t.matches("input,select,textarea")) return; e.preventDefault(); const f = ACTIONS[t.dataset.act]; if (f) f({ ...t.dataset }); });
let composing = false;
document.addEventListener("compositionstart", () => { composing = true; });
document.addEventListener("compositionend", e => { composing = false; if (e.target.matches?.("input[type=search][data-act]")) ACTIONS[e.target.dataset.act]({}); });
document.addEventListener("input", e => { if (composing) return; const t = e.target; if (t.matches("input[type=search][data-act]")) ACTIONS[t.dataset.act]({}); });
document.addEventListener("change", e => { const t = e.target; if (t.matches("select[data-act],input[type=date][data-act],textarea[data-act]")) ACTIONS[t.dataset.act]({}); });

(async () => {
  try {
    S.boot = await bootstrap();
    S.boot.tokoNames = {};
    try { for (const p of await S.boot.src.toko.list("customerProfiles")) S.boot.tokoNames[p.id] = p.name; } catch {}
    await refresh();
  } catch (e) { console.error(e); $("#view").innerHTML = `<div class="card bad">起動に失敗しました: ${h(e.message)}</div>`; }
})();
