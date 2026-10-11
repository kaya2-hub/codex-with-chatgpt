// イベント/セレモニー原稿に共通の画面部品: 項目単位の手動編集(マクロ・タイムライン・担当・資料)と、ChatGPT連携(仕様書コピー/書き出し/取り込み)。
import { KINDS, normalizeDoc, updateItem, moveItem, updateFields, newItemId } from "../core/docs.js";
import { ROLES, roleJa } from "../core/roles.js";
import { ITEM_TYPES, TYPE_JA } from "../core/timeline.js";
import { analyzeMacro } from "../core/macro.js";
import { exportDoc, SCHEMAS, SCHEMA_VERSION } from "../core/exchange.js";
import { previewImport, commitImport } from "../core/exchange-store.js";
import { buildSpec, buildEditPackage } from "../core/exchange-spec.js";
import { hashOf, clone } from "../core/util.js";
import { roleJa as rj } from "../core/roles.js";

const LISTKEY = { macro: "macros", step: "steps", staff: "staff", material: "materials" };
const COLS = [["kaya", "かや"], ["cue", "タイミング・合図・共通条件"], ["toushin", "トーシン"]];
const FIELD_LABEL = { name: "イベント名", store: "店舗", date: "開催日", startTime: "開始", endTime: "終了", venue: "会場・場所", overview: "概要", plan: "企画内容", memo: "振り返り・反省点・メモ", prep: "準備事項(1行に1件)", cautions: "注意事項(1行に1件)", characterName: "当日使う呼称", content: "今回のセレモニー内容", thanks: "個別の感謝コメント", postNote: "実施後メモ" };
const LONG = new Set(["overview", "plan", "memo", "content", "thanks", "postNote", "prep", "cautions"]);

export function createDocUI({ S, h, label, run, toast, copy, val, safeUrl, refresh, today }) {
  const store = () => S.boot.store;
  const docOf = (kind, id) => { const raw = (kind === "event" ? S.d.occs : S.d.scripts).find(x => x.id === id); return raw ? { raw, doc: normalizeDoc(kind, raw) } : null; };
  const roleOpts = sel => ROLES.map(r => `<option value="${r.id}" ${r.id === sel ? "selected" : ""}>${r.ja}</option>`).join("") + (sel && !ROLES.some(r => r.id === sel) ? `<option value="${h(sel)}" selected>${h(sel)}(旧データの担当・そのまま保持)</option>` : "");
  const opened = k => (S.open.has(k) ? "open" : "");

  // ---------- 編集用ドラフト(項目単位) ----------
  const itemRows = (col, items) => items.map((it, i) => `<div class="row" style="align-items:flex-start"><select id="sd-${col}-${i}-t" style="max-width:130px">${ITEM_TYPES.map(t => `<option value="${t}" ${t === it.type ? "selected" : ""}>${TYPE_JA[t]}</option>`).join("")}</select><textarea id="sd-${col}-${i}-x" class="grow" style="min-height:64px;font-family:inherit">${h(it.text)}</textarea><button class="b dng" data-act="sditemdel" data-col="${col}" data-i="${i}">削除</button></div>`).join("");
  function edForm(ed) {
    const d = ed.draft;
    const banner = ed.conflict ? `<div class="card bad"><b>他の人が先にこの項目を更新(または削除)しました。</b> あなたの入力はこの欄に残っています。<div class="row"><button class="b" data-act="edreload">最新の内容を読み込み直す(あなたの入力は破棄)</button><button class="b dng" data-act="edforce">あなたの内容で上書き保存できるようにする</button></div></div>` : "";
    if (ed.type === "macro") return `<div class="card">${banner}<div class="row"><input type="text" id="sd-title" placeholder="題名" value="${h(d.title)}"><select id="sd-role" style="max-width:140px">${roleOpts(d.role)}</select></div><textarea id="sd-body" placeholder="/yell … ※改行・&lt;t&gt;・記号をそのまま">${h(d.body)}</textarea><input type="text" id="sd-note" placeholder="メモ(任意)" value="${h(d.note)}"><div class="row"><button class="b pri" data-act="edsave">保存</button><button class="b" data-act="edcancel">キャンセル</button></div></div>`;
    if (ed.type === "staff") return `<div class="card">${banner}<div class="row"><select id="sd-role" style="max-width:140px">${roleOpts(d.role)}</select><input type="text" id="sd-duty" class="grow" placeholder="役割" value="${h(d.duty)}"></div><div class="row"><button class="b pri" data-act="edsave">保存</button><button class="b" data-act="edcancel">キャンセル</button></div></div>`;
    if (ed.type === "material") return `<div class="card">${banner}<div class="row"><input type="text" id="sd-label" placeholder="名前" value="${h(d.label)}"><input type="text" id="sd-url" class="grow" placeholder="URL(チラシ/資料)" value="${h(d.url)}"></div><input type="text" id="sd-note" placeholder="メモ(任意)" value="${h(d.note)}"><div class="row"><button class="b pri" data-act="edsave">保存</button><button class="b" data-act="edcancel">キャンセル</button></div></div>`;
    return `<div class="card">${banner}<div class="row"><input type="text" id="sd-time" placeholder="時刻(例 22:55頃 / 23時になったら)" value="${h(d.time)}"><input type="text" id="sd-phase" placeholder="区切り名(任意)" value="${h(d.phase)}"></div>
      ${COLS.map(([c, t]) => `<div><b>${t}</b>${itemRows(c, d[c])}<button class="b" data-act="sditemadd" data-col="${c}">＋項目を追加</button></div>`).join("")}
      <input type="text" id="sd-note" placeholder="ステップのメモ(任意)" value="${h(d.note)}"><div class="row"><button class="b pri" data-act="edsave">保存</button><button class="b" data-act="edcancel">キャンセル</button><span class="mut">この1ステップだけを保存します。他の項目は変わりません</span></div></div>`;
  }
  function readDraft() {
    const ed = S.ed; if (!ed) return; const d = ed.draft; const g = id => document.getElementById(id)?.value;
    if (ed.type === "macro") Object.assign(d, { title: g("sd-title") ?? d.title, role: g("sd-role") ?? d.role, body: g("sd-body") ?? d.body, note: g("sd-note") ?? d.note });
    else if (ed.type === "staff") Object.assign(d, { role: g("sd-role") ?? d.role, duty: g("sd-duty") ?? d.duty });
    else if (ed.type === "material") Object.assign(d, { label: g("sd-label") ?? d.label, url: g("sd-url") ?? d.url, note: g("sd-note") ?? d.note });
    else { d.time = g("sd-time") ?? d.time; d.phase = g("sd-phase") ?? d.phase; d.note = g("sd-note") ?? d.note; for (const [c] of COLS) d[c] = d[c].map((it, i) => ({ type: g(`sd-${c}-${i}-t`) ?? it.type, text: g(`sd-${c}-${i}-x`) ?? it.text })); }
  }
  const isEd = (kind, id, type, itemId) => S.ed && S.ed.kind === kind && S.ed.id === id && S.ed.type === type && S.ed.itemId === itemId;

  // ---------- 各部の表示 ----------
  function vMacros(kind, id, doc) {
    const groups = [...ROLES.map(r => [r.id, r.ja]), ["", "その他"]];
    return groups.map(([rid, ja]) => { const ms = doc.macros.filter(m => (rid ? m.role === rid : !ROLES.some(r => r.id === m.role))); if (!ms.length && !rid) return "";
      return `<details class="card" data-open-key="g:${h(id)}:${rid}" ${opened(`g:${id}:${rid}`)}><summary><b>${h(ja)}のマクロ</b> <span class="mut">${ms.length}件</span></summary>${ms.map(m => {
        const a = analyzeMacro(m.body); const key = `m:${id}:${m.id}`;
        if (isEd(kind, id, "macro", m.id)) return edForm(S.ed);
        return `<details data-open-key="${h(key)}" ${opened(key)} style="margin:6px 0"><summary><b>${h(m.title)}</b> <button class="b pri" data-act="mcopy" data-kind="${kind}" data-id="${h(id)}" data-item="${h(m.id)}">コピー</button> <button class="b" data-act="edopen" data-kind="${kind}" data-id="${h(id)}" data-type="macro" data-item="${h(m.id)}">編集</button> <button class="b dng" data-act="eddel" data-kind="${kind}" data-id="${h(id)}" data-type="macro" data-item="${h(m.id)}" data-hash="${hashOf(m)}">削除</button></summary><pre class="macro">${h(m.body)}</pre>${m.note ? `<div class="mut">${h(m.note)}</div>` : ""}${a.warnings.map(w => `<div class="warn mut">⚠ ${h(w)}</div>`).join("")}</details>`; }).join("") || '<p class="mut">なし</p>'}</details>`; }).join("")
      + (isEd(kind, id, "macro", "new") ? edForm(S.ed) : `<button class="b pri" data-act="edopen" data-kind="${kind}" data-id="${h(id)}" data-type="macro" data-item="new">＋マクロを追加</button>`);
  }
  const colItems = items => items.map(it => `<div class="it"><span class="tag it-${it.type}">${TYPE_JA[it.type]}</span> <span style="white-space:pre-wrap">${h(it.text)}</span></div>`).join("");
  function vTimeline(kind, id, doc) {
    const steps = doc.timeline.steps;
    return `<div class="cols3 sticky"><div class="h">かや</div><div class="h">タイミング・合図・共通条件</div><div class="h">トーシン</div></div>` + steps.map((s, i) => {
      if (isEd(kind, id, "step", s.id)) return edForm(S.ed);
      const ctl = `<button class="b" data-act="edopen" data-kind="${kind}" data-id="${h(id)}" data-type="step" data-item="${h(s.id)}">編集</button><button class="b" data-act="edmove" data-kind="${kind}" data-id="${h(id)}" data-key="steps" data-item="${h(s.id)}" data-dir="-1" ${i === 0 ? "disabled" : ""}>↑</button><button class="b" data-act="edmove" data-kind="${kind}" data-id="${h(id)}" data-key="steps" data-item="${h(s.id)}" data-dir="1" ${i === steps.length - 1 ? "disabled" : ""}>↓</button><button class="b" data-act="edopen" data-kind="${kind}" data-id="${h(id)}" data-type="step" data-item="new" data-after="${h(s.id)}">＋下に追加</button><button class="b dng" data-act="eddel" data-kind="${kind}" data-id="${h(id)}" data-type="step" data-item="${h(s.id)}" data-hash="${hashOf(s)}">削除</button>`;
      return `<div class="step"><div class="row"><b>${h(s.time || "(時刻未定)")}</b>${s.phase ? `<span class="tag">${h(s.phase)}</span>` : ""}${s.note ? `<span class="mut">${h(s.note)}</span>` : ""}<span class="grow"></span>${ctl}</div>
        <div class="cols3"><div class="cell"><div class="cl">かや</div>${colItems(s.kaya)}</div><div class="cell"><div class="cl">タイミング・合図・共通条件</div>${colItems(s.cue)}</div><div class="cell"><div class="cl">トーシン</div>${colItems(s.toushin)}</div></div></div>`; }).join("")
      + (isEd(kind, id, "step", "new") ? edForm(S.ed) : `<button class="b pri" data-act="edopen" data-kind="${kind}" data-id="${h(id)}" data-type="step" data-item="new">＋ステップを追加</button>`)
      + (doc.timelineLegacy || steps.length === 0 ? "" : "");
  }
  function vList(kind, id, doc, type, title, render) {
    const key = LISTKEY[type]; const items = doc[key];
    return `<div class="card"><h3>${title}</h3>${items.map(x => isEd(kind, id, type, x.id) ? edForm(S.ed) : `<div class="row">${render(x)}<span class="grow"></span><button class="b" data-act="edopen" data-kind="${kind}" data-id="${h(id)}" data-type="${type}" data-item="${h(x.id)}">編集</button><button class="b dng" data-act="eddel" data-kind="${kind}" data-id="${h(id)}" data-type="${type}" data-item="${h(x.id)}" data-hash="${hashOf(x)}">削除</button></div>`).join("") || '<p class="mut">なし</p>'}${isEd(kind, id, type, "new") ? edForm(S.ed) : `<button class="b" data-act="edopen" data-kind="${kind}" data-id="${h(id)}" data-type="${type}" data-item="new">＋追加</button>`}</div>`;
  }
  const vStaff = (kind, id, doc) => vList(kind, id, doc, "staff", "担当・役割", x => `<span class="tag">${h(roleJa(x.role))}</span> ${h(x.duty)}`);
  const vMaterials = (kind, id, doc) => vList(kind, id, doc, "material", "資料", x => `<b>${h(x.label || x.url)}</b> ${safeUrl(x.url) ? `<a href="${h(safeUrl(x.url))}" target="_blank" rel="noopener noreferrer">${h(x.url)}</a>` : h(x.url)} <span class="mut">${h(x.note)}</span>`);
  /** 基本情報フォーム。保存時は「変更した項目だけ」を書く。 */
  function vFields(kind, id, doc, fields) {
    const k = KINDS[kind]; const inp = f => {
      const v = Array.isArray(doc[f]) ? doc[f].join("\n") : doc[f] ?? "";
      if (f === "store") return `<label>${FIELD_LABEL[f]}<select id="f-store" data-o="${h(doc.store || "")}"><option value="" ${!doc.store ? "selected" : ""}>共通・未定</option><option value="diner" ${doc.store === "diner" ? "selected" : ""}>ダイナー</option><option value="toko" ${doc.store === "toko" ? "selected" : ""}>常若亭</option></select></label>`;
      if (f === "date") return `<label>${FIELD_LABEL[f]}<input type="date" id="f-date" data-o="${h(doc.date || "")}" value="${h(doc.date || "")}"></label>`;
      if (LONG.has(f)) return `<label class="grow" style="min-width:100%">${FIELD_LABEL[f]}<textarea id="f-${f}" data-o="${h(v)}" style="white-space:pre-wrap;font-family:inherit;min-height:80px">${h(v)}</textarea></label>`;
      return `<label class="grow">${FIELD_LABEL[f]}<input type="text" id="f-${f}" data-o="${h(v)}" value="${h(v)}"></label>`;
    };
    return `<div class="card"><div class="row">${fields.map(inp).join("")}</div><div class="row"><button class="b pri" data-act="savefields" data-kind="${kind}" data-id="${h(id)}" data-fields="${fields.join(",")}">保存(変更した項目だけ)</button></div></div>`;
  }

  // ---------- ChatGPT連携 ----------
  function vExchange(kind, id, extra = {}) {
    const tgt = extra.target ? `data-p="${h(extra.target.personId)}" data-v="${extra.target.stampValue}"` : "";
    const ex = S.imp && S.imp.kind === kind && S.imp.scope === (id ?? extra.scope ?? "new") ? S.imp : null;
    return `<div class="card"><h3>ChatGPTで${id ? "編集" : "作成"}</h3>
      <p class="mut">企画・進行表の相談はChatGPTで自由に。仕様書を貼ると、完成したJSONを出力してくれます。そのJSONをここへ取り込みます(外部APIは使いません)。</p>
      <div class="row"><button class="b pri" data-act="spec" data-kind="${kind}" ${tgt}>仕様書をコピー</button>
        ${id ? `<button class="b" data-act="exportcopy" data-kind="${kind}" data-id="${h(id)}" ${tgt}>編集用データをコピー(仕様書＋現在のデータ)</button><button class="b" data-act="exportjson" data-kind="${kind}" data-id="${h(id)}" ${tgt}>JSONを書き出す(ファイル)</button>` : `<button class="b" data-act="exportcopy" data-kind="${kind}" data-id="" ${tgt}>新規用の雛形つき仕様書をコピー</button>`}</div>
      <h4>完成したJSONを取り込む</h4>
      <div class="row"><input type="file" id="imfile" accept=".json,application/json" data-act="imfile"></div>
      <textarea id="imtext" placeholder="ChatGPTが出力したJSONをここに貼り付け(またはファイルを選択)" style="min-height:90px">${h(ex?.text ?? "")}</textarea>
      <button class="b" data-act="imcheck" data-kind="${kind}" data-scope="${h(id ?? extra.scope ?? "new")}">検証してプレビュー</button>
      ${ex ? vPreview(ex) : ""}</div>`;
  }
  const itemsTxt = (arr, l) => (arr ?? []).map(i => `${l}[${TYPE_JA[i.type] ?? i.type}] ${i.text}`).join("\n");
  const describe = v => { if (v == null) return "(なし)"; if (typeof v === "string") return v; if (Array.isArray(v)) return v.map(x => (typeof x === "string" ? x : x.id ?? JSON.stringify(x))).join("\n");
    if ("body" in v) return `[${rj(v.role)}] ${v.title}\n${v.body}`; if ("duty" in v) return `${rj(v.role)}: ${v.duty}`; if ("label" in v) return `${v.label} ${v.url} ${v.note}`.trim();
    if ("kaya" in v) return [`${v.time} ${v.phase}`.trim(), itemsTxt(v.kaya, "かや"), itemsTxt(v.cue, "合図"), itemsTxt(v.toushin, "トーシン"), v.note].filter(Boolean).join("\n"); return JSON.stringify(v); };
  const short = v => { const t = describe(v); return t.length > 600 ? t.slice(0, 600) + "…" : t; };
  const macroWarn = c => (c.area === "macros" && c.after ? analyzeMacro(c.after.body).warnings : []);
  function vPreview(ex) {
    const p = ex.preview;
    const errs = p.errors?.length ? `<div class="bad"><b>取り込めません(保存していません)</b><ul>${p.errors.map(e => `<li><code>${h(e.path)}</code> ${h(e.message)}</li>`).join("")}</ul></div>` : "";
    const warns = p.warnings?.length ? `<div class="warn">${p.warnings.map(e => `⚠ <code>${h(e.path)}</code> ${h(e.message)}`).join("<br>")}</div>` : "";
    if (!p.ok) return errs + warns;
    if (p.mode === "create") { const d = p.data; const mw = (d.macros ?? []).flatMap(m => analyzeMacro(m.body).warnings.map(w => `${m.title}: ${w}`)); return `${warns}${mw.map(w => `<div class="warn">⚠ ${h(w)}</div>`).join("")}<div class="card"><b>新規登録のプレビュー</b><p>${h(d.name ?? "(原稿)")} ・ ステップ ${d.steps?.length ?? 0} ・ マクロ ${d.macros?.length ?? 0} ・ 資料 ${d.materials?.length ?? 0}</p><p class="mut">下書きとして登録します(開催状態は「下書き」。取り込みだけで開催済み・実施済み・完成にはなりません)。</p><button class="b pri" data-act="imcommit">この内容で新規登録する</button></div>`; }
    const ch = p.plan.changes;
    return `${warns}<div class="card"><b>変更の差分(チェックした変更だけを反映)</b> <span class="mut">対象: ${h(p.raw?.name ?? p.raw?.characterName ?? p.raw?.id ?? "")}</span>${p.plan.notes.map(n => `<div class="mut">ℹ ${h(n)}</div>`).join("")}
      ${ch.map(c => `<div class="card" ${c.conflict ? 'style="border-color:var(--bad)"' : ""}><label><input type="checkbox" id="ck-${h(c.key)}" ${c.conflict || c.defaultOff ? "" : "checked"}> <b>${h(c.label)}</b> ${h(c.title ?? "")}</label>${c.defaultOff ? `<div class="warn">⚠ ${h(c.reason)}</div>` : ""}${c.conflict ? `<div class="bad">競合: ${h(c.reason ?? "現在の値と取り込み側の両方が変更されています")} — チェックすると<b>取り込み側を採用</b>、外すと現在の値を維持</div>` : ""}<details><summary class="mut">前後を見る</summary><div class="cols3" style="grid-template-columns:1fr 1fr">${macroWarn(c).map(w => `<div class="warn mut">⚠ ${h(w)}</div>`).join("")}<pre class="macro">現在: ${h(short(c.before))}</pre><pre class="macro">取り込み後: ${h(short(c.after))}</pre></div></details></div>`).join("") || '<p class="mut">差分はありません(現在のデータと同じ内容です)</p>'}
      ${ch.length ? '<button class="b pri" data-act="imcommit">チェックした変更を反映する</button>' : ""}</div>`;
  }

  const dirtyFields = () => [...document.querySelectorAll('#view [id^="f-"]')].some(el => "o" in el.dataset && el.value !== el.dataset.o);
  // ---------- 操作 ----------
  const L = () => ({ label: label() });
  const downloadJson = (name, obj) => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" })); a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); };
  const exportOf = (d) => { const f = docOf(d.kind, d.id); if (!f) { if (d.kind === "ceremony") return S.hooks.skeleton(d.p, Number(d.v)); return { schema: SCHEMAS.event, version: SCHEMA_VERSION, op: "create", event: { name: "", store: null, date: null } }; }
    return d.kind === "event" ? exportDoc("event", f.raw) : S.hooks.exportCeremony(f.raw, d.p, Number(d.v)); };
  const actions = {
    spec: d => copy(buildSpec(d.kind)),
    exportcopy: d => copy(buildEditPackage(d.kind, exportOf(d))),
    exportjson: d => downloadJson(`${d.kind}-${(d.id || "new").slice(0, 24)}.json`, exportOf(d)),
    imfile: () => { const f = document.getElementById("imfile").files[0]; if (!f) return; const r = new FileReader(); r.onload = () => { document.getElementById("imtext").value = String(r.result); toast("ファイルを読み込みました。「検証してプレビュー」を押してください"); }; r.onerror = () => toast("ファイルを読み込めませんでした", true); r.readAsText(f, "utf-8"); },
    imcheck: d => run(async () => { const text = val("imtext"); S.imp = { kind: d.kind, scope: d.scope, text, preview: await previewImport(store(), d.kind, text, d.scope) }; }),
    imcommit: () => { const ex = S.imp; if (!ex?.preview?.ok) return; const p = ex.preview;
      const decisions = {}; for (const c of p.plan?.changes ?? []) decisions[c.key] = !!document.getElementById(`ck-${c.key}`)?.checked;
      if (!confirm(p.mode === "create" ? "この内容で新規登録します(下書き)。よろしいですか?" : `チェックした ${Object.values(decisions).filter(Boolean).length} 件の変更を反映します。よろしいですか?`)) return;
      return run(async () => { const r = await commitImport(store(), ex.kind, p, decisions, L()); S.imp = null; if (r.mode === "create" && ex.kind === "event") { S.view = "events"; S.evId = r.id; S.evTab = "overview"; } }, "取り込みました"); },
    edopen: d => { if (S.ed) { readDraft(); if (hashOf(S.ed.draft) !== S.ed.initHash && !confirm("編集中の内容があります。破棄して別の項目を開きますか?")) return; }
      const f = docOf(d.kind, d.id); if (!f) return; const key = LISTKEY[d.type]; let draft, base; const cur = d.item === "new" ? null : f.doc[key === "steps" ? "timeline" : key]; 
      const list = key === "steps" ? f.doc.timeline.steps : f.doc[key]; const it = d.item === "new" ? null : list.find(x => x.id === d.item);
      draft = it ? clone(it) : ({ macro: { title: "", role: ROLES[0].id, body: "", note: "" }, staff: { role: ROLES[0].id, duty: "" }, material: { label: "", url: "", note: "" }, step: { time: "", phase: "", cue: [], kaya: [], toushin: [], note: "" } })[d.type];
      S.ed = { kind: d.kind, id: d.id, type: d.type, itemId: d.item, after: d.after, draft, initHash: hashOf(draft), baseHash: it ? hashOf(it) : undefined }; void cur; void base; S.render(); },
    edcancel: () => { S.ed = null; S.render(); },
    sditemadd: d => { readDraft(); S.ed.draft[d.col].push({ type: d.col === "cue" ? "condition" : "say", text: "" }); S.render(); },
    sditemdel: d => { readDraft(); S.ed.draft[d.col].splice(Number(d.i), 1); S.render(); },
    edsave: () => { readDraft(); const e = S.ed; const key = LISTKEY[e.type]; const d = { ...e.draft };
      if (e.type === "step") for (const [c] of COLS) d[c] = d[c].filter(x => x.text !== "");
      if (e.type === "macro" && (!d.title.trim() || !d.body.trim())) return toast("題名と本文が必要です", true);
      const itemId = e.itemId === "new" ? newItemId(key) : e.itemId;
      return run(async () => { try { await updateItem(store(), e.kind, e.id, key, itemId, d, { baseHash: e.baseHash, afterId: e.after, ...L() }); S.ed = null; } catch (err) { if (err.code === "conflict" && S.ed) S.ed.conflict = true; throw err; } }, "保存しました"); },
    edreload: () => { const e = S.ed; const f = docOf(e.kind, e.id); const key = LISTKEY[e.type]; const list = key === "steps" ? f.doc.timeline.steps : f.doc[key]; const it = list.find(x => x.id === e.itemId);
      if (!it) { S.ed = null; return S.render(); } e.draft = clone(it); e.initHash = hashOf(e.draft); e.baseHash = hashOf(it); e.conflict = false; S.render(); },
    edforce: () => { const e = S.ed; const f = docOf(e.kind, e.id); const key = LISTKEY[e.type]; const list = key === "steps" ? f.doc.timeline.steps : f.doc[key]; const it = list.find(x => x.id === e.itemId);
      e.baseHash = it ? hashOf(it) : undefined; e.conflict = false; toast("この内容で保存すると、他の人の変更を上書きします。よければ「保存」を押してください"); S.render(); },
    eddel: d => confirm("削除しますか?(変更履歴に記録されます。必要ならJSON書き出しで事前に保存できます)") && run(() => updateItem(store(), d.kind, d.id, LISTKEY[d.type], d.item, null, { baseHash: d.hash, ...L() }), "削除しました"),
    edmove: d => run(() => moveItem(store(), d.kind, d.id, d.key, d.item, Number(d.dir), L())),
    mcopy: d => { const f = docOf(d.kind, d.id); copy(f.doc.macros.find(m => m.id === d.item).body); },
    savefields: d => { const f = docOf(d.kind, d.id); const k = KINDS[d.kind]; const patch = {}, baseValues = {};
      for (const fld of d.fields.split(",")) { const el = document.getElementById(`f-${fld}`); if (!el) continue; const isList = k.lists.includes(fld);
        const next = isList ? el.value.split("\n").map(x => x.trim()).filter(Boolean) : (fld === "store" || fld === "date") ? (el.value || null) : el.value;
        if (el.value !== (el.dataset.o ?? "")) { patch[fld] = next; baseValues[fld] = f.doc[fld]; } } // 画面に表示した値から変えた項目だけ(触れていない項目は一切書かない)
      if (!Object.keys(patch).length) return toast("変更はありません");
      if ("name" in patch && !String(patch.name).trim()) return toast("イベント名は空にできません", true);
      return run(() => updateFields(store(), d.kind, d.id, patch, { baseValues, ...L() }), "保存しました"); }
  };
  return { vMacros, vTimeline, vStaff, vMaterials, vFields, vExchange, actions, docOf, opened, readDraft, dirtyFields };
}
