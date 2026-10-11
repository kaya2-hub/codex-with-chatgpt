// イベント/セレモニー原稿に共通の画面部品: 項目単位の手動編集(マクロ・タイムライン・担当・資料)と、ChatGPT連携(仕様書コピー/書き出し/取り込み)。
import { KINDS, normalizeDoc, updateItem, moveItem, updateFields, newItemId } from "../core/docs.js";
import { ROLES, roleJa } from "../core/roles.js";
import { ITEM_TYPES, TYPE_JA } from "../core/timeline.js";
import { analyzeMacro } from "../core/macro.js";
import { exportDoc, SCHEMAS, SCHEMA_VERSION, applyPlan, buildNewDoc } from "../core/exchange.js";
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
  const docOf = (kind, id) => { if (id === "__pv__") return S.imp?.previewDoc ? { raw: {}, doc: S.imp.previewDoc } : null; const raw = (kind === "event" ? S.d.occs : S.d.scripts).find(x => x.id === id); return raw ? { raw, doc: normalizeDoc(kind, raw) } : null; };
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

  // ---------- 各部の表示(閲覧モードが既定。編集モードのときだけ編集操作を表示) ----------
  const STORE_JA = { diner: "ダイナー", toko: "常若亭" };
  const FIELDS = { event: { basic: ["name", "store", "date", "startTime", "endTime", "venue", "overview", "plan", "memo"], extra: ["prep", "cautions"] }, ceremony: { basic: ["characterName", "content", "thanks", "postNote", "prep"], extra: [] } };
  const rtag = r => `<span class="rt rt-${h(r)}">${h(rj(r))}</span>`;
  const isOpen = (key, force) => force || S.open.has(key);
  const dirtyFields = () => [...document.querySelectorAll('#view [id^="f-"]')].some(el => "o" in el.dataset && el.value !== el.dataset.o);
  const isDirty = (kind, id) => { if (S.ed) readDraft(); return !!(S.ed && (kind === undefined || (S.ed.kind === kind && S.ed.id === id)) && hashOf(S.ed.draft) !== S.ed.initHash) || dirtyFields(); };
  const isEdit = (kind, id) => S.em.has(`${kind}:${id}`);

  function modeBar(kind, id, extra = "") {
    if (!isEdit(kind, id)) return `<div class="row"><button class="b" data-act="emon" data-kind="${kind}" data-id="${h(id)}">✎ 編集モード</button><span class="mut">いまは閲覧モードです(マクロのコピーや折り畳みは、このままできます)</span></div>`;
    return `<div class="editbar" role="status"><b>✎ 編集モード</b><span>変更は項目ごとに「保存」を押したとき保存されます</span><span class="grow"></span>${extra}<button class="b" data-act="emoff" data-kind="${kind}" data-id="${h(id)}">編集を終了(閲覧に戻る)</button></div>`;
  }
  function macroBlock(kind, id, m, edit, force, copyBtn = true) {
    const key = `m:${id}:${m.id}`; if (edit && isEd(kind, id, "macro", m.id)) return edForm(S.ed);
    const a = analyzeMacro(m.body);
    const ctl = (copyBtn ? `<button class="b pri" data-act="mcopy" data-kind="${kind}" data-id="${h(id)}" data-item="${h(m.id)}">コピー</button>` : "") + (edit ? ` <button class="b" data-act="edopen" data-kind="${kind}" data-id="${h(id)}" data-type="macro" data-item="${h(m.id)}">編集</button> <button class="b dng" data-act="eddel" data-kind="${kind}" data-id="${h(id)}" data-type="macro" data-item="${h(m.id)}" data-hash="${hashOf(m)}">削除</button>` : "");
    return `<details class="mac mac-${h(m.role)}" data-open-key="${h(key)}" ${isOpen(key, force) ? "open" : ""}><summary>${rtag(m.role)} <b>${h(m.title)}</b> ${ctl}</summary><pre class="macro">${h(m.body)}</pre>${m.note ? `<div class="mut">${h(m.note)}</div>` : ""}${a.warnings.map(w => `<div class="warn mut">⚠ ${h(w)}</div>`).join("")}</details>`;
  }
  function vMacros(kind, id, doc, edit = false, force = false) {
    const groups = [...ROLES.map(r => [r.id, r.ja]), ["", "その他"]];
    return groups.map(([rid, ja]) => { const ms = doc.macros.filter(m => (rid ? m.role === rid : !ROLES.some(r => r.id === m.role))); if (!ms.length && !rid) return ""; const gk = `g:${id}:${rid}`;
      return `<details class="card grp grp-${rid || "x"}" data-open-key="${h(gk)}" ${isOpen(gk, force) ? "open" : ""}><summary><b>${h(ja)}のマクロ</b> <span class="mut">${ms.length}件</span></summary>${ms.map(m => macroBlock(kind, id, m, edit, force)).join("") || '<p class="mut">なし</p>'}</details>`; }).join("")
      + (!edit ? "" : isEd(kind, id, "macro", "new") ? edForm(S.ed) : `<button class="b pri" data-act="edopen" data-kind="${kind}" data-id="${h(id)}" data-type="macro" data-item="new">＋マクロを追加</button>`);
  }
  const colItems = items => items.map(it => `<div class="it"><span class="tag it-${h(it.type)}">${TYPE_JA[it.type]}</span> <span style="white-space:pre-wrap">${h(it.text)}</span></div>`).join("");
  const stepBlock = (s, ctl = "") => `<div class="step"><div class="row"><b>${h(s.time || "(時刻未定)")}</b>${s.phase ? `<span class="tag">${h(s.phase)}</span>` : ""}${s.note ? `<span class="mut">${h(s.note)}</span>` : ""}<span class="grow"></span>${ctl}</div>
    <div class="cols3"><div class="cell c-kaya"><div class="cl">かや</div>${colItems(s.kaya)}</div><div class="cell c-cue"><div class="cl">タイミング・合図・共通条件</div>${colItems(s.cue)}</div><div class="cell c-toushin"><div class="cl">トーシン</div>${colItems(s.toushin)}</div></div></div>`;
  function vTimeline(kind, id, doc, edit = false) {
    const steps = doc.timeline.steps; const E = (act, extra) => `data-act="${act}" data-kind="${kind}" data-id="${h(id)}" ${extra}`;
    return `<div id="${id === "__pv__" ? "pv-tl" : "doc-tl"}"><div class="cols3 sticky"><div class="h c-kaya">かや</div><div class="h c-cue">タイミング・合図・共通条件</div><div class="h c-toushin">トーシン</div></div>`
      + (steps.map((s, i) => {
        if (edit && isEd(kind, id, "step", s.id)) return edForm(S.ed);
        const ctl = !edit ? "" : `<button class="b" ${E("edopen", `data-type="step" data-item="${h(s.id)}"`)}>編集</button><button class="b" ${E("edmove", `data-key="steps" data-item="${h(s.id)}" data-dir="-1"`)} ${i === 0 ? "disabled" : ""}>↑</button><button class="b" ${E("edmove", `data-key="steps" data-item="${h(s.id)}" data-dir="1"`)} ${i === steps.length - 1 ? "disabled" : ""}>↓</button><button class="b" ${E("edopen", `data-type="step" data-item="new" data-after="${h(s.id)}"`)}>＋下に追加</button><button class="b dng" ${E("eddel", `data-type="step" data-item="${h(s.id)}" data-hash="${hashOf(s)}"`)}>削除</button>`;
        return stepBlock(s, ctl); }).join("") || '<p class="mut">ステップはまだありません</p>')
      + (!edit ? "" : isEd(kind, id, "step", "new") ? edForm(S.ed) : `<button class="b pri" ${E("edopen", 'data-type="step" data-item="new"')}>＋ステップを追加</button>`) + "</div>";
  }
  function vList(kind, id, doc, type, title, render, edit) {
    const key = LISTKEY[type]; const items = doc[key];
    return `<div class="card"><h3>${title}</h3>${items.map(x => edit && isEd(kind, id, type, x.id) ? edForm(S.ed) : `<div class="row">${render(x)}<span class="grow"></span>${edit ? `<button class="b" data-act="edopen" data-kind="${kind}" data-id="${h(id)}" data-type="${type}" data-item="${h(x.id)}">編集</button><button class="b dng" data-act="eddel" data-kind="${kind}" data-id="${h(id)}" data-type="${type}" data-item="${h(x.id)}" data-hash="${hashOf(x)}">削除</button>` : ""}</div>`).join("") || '<p class="mut">なし</p>'}${!edit ? "" : isEd(kind, id, type, "new") ? edForm(S.ed) : `<button class="b" data-act="edopen" data-kind="${kind}" data-id="${h(id)}" data-type="${type}" data-item="new">＋追加</button>`}</div>`;
  }
  const staffHtml = x => `${rtag(x.role)} ${h(x.duty)}`;
  const materialHtml = x => `<b>${h(x.label || x.url)}</b> ${safeUrl(x.url) ? `<a href="${h(safeUrl(x.url))}" target="_blank" rel="noopener noreferrer">${h(x.url)}</a>` : h(x.url)} <span class="mut">${h(x.note)}</span>`;
  const vStaff = (kind, id, doc, edit = false) => vList(kind, id, doc, "staff", "担当・役割", staffHtml, edit);
  const vMaterials = (kind, id, doc, edit = false) => vList(kind, id, doc, "material", "資料", materialHtml, edit);
  /** 閲覧用の項目表示(登録後の画面と取り込みプレビューで共通)。 */
  function vFieldsView(kind, doc, fields) {
    const show = f => { const v = doc[f]; if (f === "store") return STORE_JA[v] ?? "共通・未定"; if (f === "date") return v || "未定"; if (Array.isArray(v)) return v.length ? `<ul>${v.map(x => `<li style="white-space:pre-wrap">${h(x)}</li>`).join("")}</ul>` : null; return v ? `<span style="white-space:pre-wrap">${h(v)}</span>` : null; };
    return `<div class="card"><dl class="kv">${fields.map(f => `<dt>${FIELD_LABEL[f]}</dt><dd>${show(f) ?? '<span class="mut">(未入力)</span>'}</dd>`).join("")}</dl></div>`;
  }
  /** 基本情報フォーム(編集モード)。保存時は「変更した項目だけ」を書く。閲覧モードは読み取り表示。 */
  function vFields(kind, id, doc, fields, edit = false) {
    if (!edit) return vFieldsView(kind, doc, fields);
    const inp = f => {
      const v = Array.isArray(doc[f]) ? doc[f].join("\n") : doc[f] ?? "";
      if (f === "store") return `<label>${FIELD_LABEL[f]}<select id="f-store" data-o="${h(doc.store || "")}"><option value="" ${!doc.store ? "selected" : ""}>共通・未定</option><option value="diner" ${doc.store === "diner" ? "selected" : ""}>ダイナー</option><option value="toko" ${doc.store === "toko" ? "selected" : ""}>常若亭</option></select></label>`;
      if (f === "date") return `<label>${FIELD_LABEL[f]}<input type="date" id="f-date" data-o="${h(doc.date || "")}" value="${h(doc.date || "")}"></label>`;
      if (LONG.has(f)) return `<label class="grow" style="min-width:100%">${FIELD_LABEL[f]}<textarea id="f-${f}" data-o="${h(v)}" style="white-space:pre-wrap;font-family:inherit;min-height:80px">${h(v)}</textarea></label>`;
      return `<label class="grow">${FIELD_LABEL[f]}<input type="text" id="f-${f}" data-o="${h(v)}" value="${h(v)}"></label>`;
    };
    return `<div class="card"><div class="row">${fields.map(inp).join("")}</div><div class="row"><button class="b pri" data-act="savefields" data-kind="${kind}" data-id="${h(id)}" data-fields="${fields.join(",")}">保存(変更した項目だけ)</button></div></div>`;
  }
  /** ドキュメント全体の閲覧表示。取り込みプレビュー(登録される内容の全表示)にも使う=登録後の画面と同じ部品。 */
  function vDocAll(kind, id, doc, force = true) {
    const sec = (title, body, open = true) => `<details class="card sec" data-open-key="sec:${h(id)}:${h(title)}" ${force ? "open" : open ? "open" : ""}><summary><b>${title}</b></summary>${body}</details>`;
    const f = FIELDS[kind];
    return sec("基本情報", vFieldsView(kind, doc, f.basic)) + sec(`担当・役割(${doc.staff.length}件)`, vStaff(kind, id, doc, false)) + (f.extra.length ? sec("準備事項・注意事項", vFieldsView(kind, doc, f.extra)) : "")
      + sec(`進行タイムライン(${doc.timeline.steps.length}ステップ)`, vTimeline(kind, id, doc, false)) + sec(`マクロ(${doc.macros.length}件)`, vMacros(kind, id, doc, false, force))
      + (kind === "event" ? sec(`資料(${doc.materials.length}件)`, vMaterials(kind, id, doc, false)) : "");
  }

  // ---------- ChatGPT連携(手順つきパネル) ----------
  function vExchange(kind, id, extra = {}) {
    const tgt = extra.target ? `data-p="${h(extra.target.personId)}" data-v="${extra.target.stampValue}"` : "";
    const scope = id ?? extra.scope ?? "new"; const ex = S.imp && S.imp.kind === kind && S.imp.scope === scope ? S.imp : null;
    const what = kind === "event" ? "イベント" : "セレモニー原稿"; const mine = id ? "edit" : "new"; const gk = `guide:${kind}:${mine}`;
    const step = (n, title, body) => `<li><span class="num">${n}</span><div><b>${title}</b><div>${body}</div></div></li>`;
    const steps = id
      ? [step(1, "編集用データをコピーする", `<button class="b pri" data-act="exportcopy" data-kind="${kind}" data-id="${h(id)}" ${tgt}>編集用データをコピー(仕様書＋現在のデータ)</button> <button class="b" data-act="exportjson" data-kind="${kind}" data-id="${h(id)}" ${tgt}>JSONファイルを書き出す</button><br>コピーした文章をChatGPT(チャッピー)に貼り付けます。`),
         step(2, "ChatGPTに修正を相談する", "「このセリフを変更したい」「地下への移動を5分早めたい」など、普段どおりの会話で伝えます。"),
         step(3, "ChatGPTからの質問に答える", "足りない情報や確認があればChatGPTが質問します。答えて内容を固めてください。"),
         step(4, "完成したら書き出しを指示する", "「書き出して」「これでOK」と伝えると、更新版のJSONが出力されます。"),
         step(5, "更新版JSONを取り込む", "ChatGPTの .json ファイルを保存して下の「ファイルを選択」から取り込みます。ファイルが作れない場合は、JSON本文をコピーして貼り付けます。"),
         step(6, "差分を確認して反映する", "変更前/後・追加・削除・競合を確認し、反映したい変更だけチェックして反映します。細かな修正は編集モードから手動でもできます。")]
      : [step(1, "仕様書をコピーする", `<button class="b pri" data-act="spec" data-kind="${kind}" ${tgt}>仕様書をコピー</button>${kind === "ceremony" ? ` <button class="b" data-act="exportcopy" data-kind="${kind}" data-id="" ${tgt}>お客様情報つきの雛形＋仕様書をコピー</button>` : ""}<br>コピーした文章をChatGPT(チャッピー)に貼り付けます。`),
         step(2, `ChatGPTと${what}の内容を作る`, kind === "event" ? "タイムライン・マクロ・企画内容・担当者などを、普段どおりChatGPTとの会話で作成します。" : "セレモニーの流れ・かや/トーシンの役割・マクロ・個別の感謝コメントなどを、普段どおりChatGPTとの会話で作成します。"),
         step(3, "ChatGPTからの質問に答える", "開催日や担当など足りない情報があればChatGPTが質問します。相談しながら内容を完成させてください(未定のままでも下書きとして登録できます)。"),
         step(4, "完成したら書き出しを指示する", "内容を伝え終えたら、ChatGPTへ「書き出して」「これでOK」と伝えます。"),
         step(5, "JSONを取り込む", "ChatGPTが作った .json ファイルを保存し、下の「ファイルを選択」から取り込みます。ファイルが作れない場合は、出力されたJSON本文をコピーして貼り付けます。"),
         step(6, "内容を確認して登録する", "プレビューで登録される内容をすべて確認し、問題がなければ登録します。登録後に直したい箇所は、編集モードから手動で修正できます。")];
    return `<div class="card"><h3>ChatGPTで${id ? "編集" : "作成"}</h3>
      <details class="guide" data-open-key="${gk}" data-default-open="1" ${S.shut.has(gk) ? "" : "open"}><summary><b>手順(6ステップ)</b> <span class="mut">クリックで折り畳み</span></summary><ol class="guide-steps">${steps.join("")}</ol></details>
      <h4>取り込む(手順5)</h4>
      <div class="row"><label>ファイルを選択 <input type="file" id="imfile" accept=".json,application/json" data-act="imfile"></label></div>
      <textarea id="imtext" placeholder="または、ChatGPTが出力したJSON本文をここに貼り付け" style="min-height:90px">${h(ex?.text ?? "")}</textarea>
      <button class="b pri" data-act="imcheck" data-kind="${kind}" data-scope="${h(scope)}">検証してプレビュー(まだ保存しません)</button>
      ${ex ? vPreview(ex, kind) : ""}</div>`;
  }
  // 変更カード(取り込み差分): 追加=緑・変更=黄・削除=赤・競合=赤枠。前後を登録後の画面と同じ部品で表示
  const KIND_BADGE = { field: ["変更", "ch-edit"], "item-edit": ["変更", "ch-edit"], "item-add": ["追加", "ch-add"], "item-remove": ["削除", "ch-remove"], order: ["並べ替え", "ch-edit"] };
  function valHtml(kind, c, v, curDoc) {
    if (v == null) return '<span class="mut">(なし)</span>';
    if (c.kind === "order") return `<ol>${v.map(i => { const it = (c.area === "steps" ? curDoc.timeline.steps : curDoc[c.area]).find(x => x.id === i); return `<li>${h(it ? (c.area === "steps" ? `${it.time} ${it.phase}`.trim() || "(時刻未定)" : it.title ?? it.label ?? it.duty ?? i) : i)}</li>`; }).join("")}</ol>`;
    if (c.kind === "field") return Array.isArray(v) ? (v.length ? `<ul>${v.map(x => `<li>${h(x)}</li>`).join("")}</ul>` : '<span class="mut">(空)</span>') : `<pre class="macro">${h(c.area === "store" ? STORE_JA[v] ?? "共通・未定" : String(v) || "(空)")}</pre>`;
    if (c.area === "steps") return stepBlock(v);
    if (c.area === "macros") return macroBlock(kind, "__pvd__", v, false, true, false);
    if (c.area === "staff") return staffHtml(v);
    return materialHtml(v);
  }
  function vPreview(ex, kind) {
    const p = ex.preview;
    const errs = p.errors?.length ? `<div class="bad"><b>取り込めません(何も保存していません)</b><ul>${p.errors.map(e => `<li><code>${h(e.path)}</code> ${h(e.message)}</li>`).join("")}</ul></div>` : "";
    const warns = p.warnings?.length ? `<div class="warn">${p.warnings.map(e => `⚠ <code>${h(e.path)}</code> ${h(e.message)}`).join("<br>")}</div>` : "";
    if (!p.ok) return errs + warns;
    const pd = ex.previewDoc; const mw = pd.macros.flatMap(m => analyzeMacro(m.body).warnings.map(w => `${m.title}: ${w}`));
    const warnAll = warns + mw.map(w => `<div class="warn">⚠ ${h(w)}</div>`).join("");
    if (p.mode === "create") return `${warnAll}<div class="card previewbar"><b>新規登録のプレビュー</b> <span class="mut">登録される内容をすべて表示しています(登録後の画面と同じ表示)。下書きとして登録し、開催済み・実施済み・完成にはなりません。</span><div class="row"><button class="b pri" data-act="imcommit">この内容で新規登録する</button></div></div>${vDocAll(kind, "__pv__", pd, true)}<div class="row"><button class="b pri" data-act="imcommit">この内容で新規登録する</button></div>`;
    const ch = p.plan.changes; const cur = normalizeDoc(kind, p.raw);
    const count = k => ch.filter(c => KIND_BADGE[c.kind][1] === k && !c.conflict).length;
    return `${warnAll}<div class="card previewbar"><b>変更の差分(チェックした変更だけを反映)</b> <span class="mut">対象: ${h(cur.name || cur.characterName || p.raw.id)}</span>
      <div class="row"><span class="tag ch-add">追加 ${count("ch-add")}</span><span class="tag ch-edit">変更 ${count("ch-edit")}</span><span class="tag ch-remove">削除 ${count("ch-remove")}</span><span class="tag ch-conf">競合 ${ch.filter(c => c.conflict).length}</span></div>
      ${p.plan.notes.map(n => `<div class="mut">ℹ ${h(n)}</div>`).join("")}</div>
      ${ch.map(c => { const [bt, bc] = KIND_BADGE[c.kind]; return `<div class="card chg ${c.conflict ? "ch-conf" : bc}"><label><input type="checkbox" id="ck-${h(c.key)}" data-act="ckchg" data-key="${h(c.key)}" ${(ex.decisions?.[c.key] ?? !(c.conflict || c.defaultOff)) ? "checked" : ""}> <span class="tag ${c.conflict ? "ch-conf" : bc}">${c.conflict ? "競合" : bt}</span> <b>${h(c.label)}</b> ${h(c.title ?? "")}</label>
        ${c.defaultOff ? `<div class="warn">⚠ ${h(c.reason)}</div>` : ""}${c.conflict ? `<div class="bad">競合: ${h(c.reason ?? "現在の値と取り込み側の両方が変更されています")} — チェックすると<b>取り込み側を採用</b>、外すと現在の値を維持</div>` : ""}        <div class="cols3 ba"><div><div class="mut">変更前(現在)</div>${valHtml(kind, c, c.before, cur)}</div><div><div class="mut">変更後(取り込み)</div>${valHtml(kind, c, c.after, cur)}</div></div></div>`; }).join("") || '<p class="mut">差分はありません(現在のデータと同じ内容です)</p>'}
      ${ch.length ? '<button class="b pri" data-act="imcommit">チェックした変更を反映する</button>' : ""}
      <details class="card"><summary><b>反映後の全内容</b> <span class="mut">(いまのチェック状態で反映した場合の最終形。チェックを変えると更新されます)</span></summary>${vDocAll(kind, "__pv__", pd, false)}</details>`;
  }

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
    imcheck: d => run(async () => { const text = val("imtext"); const preview = await previewImport(store(), d.kind, text, d.scope); let previewDoc = null;
      if (preview.ok) previewDoc = normalizeDoc(d.kind, preview.mode === "create" ? buildNewDoc(d.kind, preview.data) : { ...preview.raw, ...applyPlan(d.kind, preview.raw, preview.data, preview.plan, {}).patch });
      S.imp = { kind: d.kind, scope: d.scope, text, preview, previewDoc }; }),
    imcommit: () => { const ex = S.imp; if (!ex?.preview?.ok) return; const p = ex.preview;
      const decisions = {}; for (const c of p.plan?.changes ?? []) decisions[c.key] = !!document.getElementById(`ck-${c.key}`)?.checked;
      if (!confirm(p.mode === "create" ? "この内容で新規登録します(下書き)。よろしいですか?" : `チェックした ${Object.values(decisions).filter(Boolean).length} 件の変更を反映します。よろしいですか?`)) return;
      return run(async () => { const r = await commitImport(store(), ex.kind, p, decisions, L()); S.imp = null; if (r.mode === "create" && ex.kind === "event") { S.view = "events"; S.evId = r.id; S.evTab = "overview"; } }, "取り込みました"); },
    emon: d => { S.em.add(`${d.kind}:${d.id}`); S.render(); },
    emoff: d => { if (isDirty(d.kind, d.id) && !confirm("保存していない変更があります。破棄して編集モードを終了しますか?")) return; S.ed = null; S.em.delete(`${d.kind}:${d.id}`); if (S.exOpen === d.id) S.exOpen = null; if (S.imp && S.imp.scope === d.id) S.imp = null; S.render(); },
    ckchg: d => { const ex = S.imp; if (!ex?.preview?.ok || ex.preview.mode !== "update") return; ex.decisions = {}; for (const c of ex.preview.plan.changes) ex.decisions[c.key] = !!document.getElementById(`ck-${c.key}`)?.checked; ex.previewDoc = normalizeDoc(ex.kind, { ...ex.preview.raw, ...applyPlan(ex.kind, ex.preview.raw, ex.preview.data, ex.preview.plan, ex.decisions).patch }); S.render(); },
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
  /** 画面遷移の前に呼ぶ。編集モード中に未保存の変更があれば破棄確認。許可されたら編集状態を片付ける。 */
  const leaveGuard = () => { if (S.em.size && isDirty() && !confirm("編集モード中に保存していない変更があります。破棄して移動しますか?")) return false; S.em.clear(); S.ed = null; S.exOpen = null; S.imp = null; return true; };
  return { vMacros, vTimeline, vStaff, vMaterials, vFields, vExchange, vDocAll, modeBar, isEdit, leaveGuard, isDirty, FIELDS, actions, docOf, readDraft, dirtyFields };
}
