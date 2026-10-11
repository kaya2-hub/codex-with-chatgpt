// 取り込みの保存側。検証→(新規作成 | 差分計画→選択適用)。原稿の取り込みは開催状態・実施記録・来店記録に触れない。
import { MASTER as M } from "./collections.js";
import { PortalError, clean, nowIso } from "./util.js";
import { KINDS, commitPatch } from "./docs.js";
import { validateImport, planImport, applyPlan, buildNewDoc, exportDoc } from "./exchange.js";
import { newId } from "./identity-ops.js";
import { STAMP_UNIT } from "./aggregate.js";

export const scriptId = (personId, stampValue) => `script__${personId}__${stampValue}`;

/** 検証+既存データとの照合。保存はしない(プレビュー用)。 */
export async function previewImport(store, kind, input, scope) {
  const v = validateImport(input, kind);
  if (!v.ok) return { ...v, mode: null };
  // 開いている画面(scope)と、JSONが指す取り込み先が違えば拒否(別のデータを誤って更新しない)
  const bad = (path, message) => ({ ...v, ok: false, errors: [{ path, message }], mode: null });
  if (scope !== undefined) {
    if (kind === "event") {
      if (scope === "new" && v.op !== "create") return bad("op", "新規作成の画面です。op は create にしてください(既存の更新は、そのイベントの画面から)");
      if (scope !== "new" && (v.op !== "update" || v.target?.occurrenceId !== scope)) return bad("target.occurrenceId", "このイベントの更新用データではありません(別のイベントのJSONの可能性)。このイベントの「編集用データをコピー」から作ったJSONを使ってください");
    } else if (scriptId(v.target.personId, v.target.stampValue) !== scope) return bad("target", "この原稿(お客様・達成スタンプ)用のJSONではありません。画面の「仕様書をコピー」/「編集用データをコピー」から作ったJSONを使ってください");
  }
  const col = KINDS[kind].col;
  if (kind === "event") {
    if (v.op === "create") return { ...v, mode: "create" };
    const raw = await store.get(col, v.target.occurrenceId);
    if (!raw) return { ...v, ok: false, errors: [{ path: "target.occurrenceId", message: "対象の開催回が見つかりません" }], mode: null };
    return { ...v, mode: "update", raw, plan: planImport(kind, raw, v.data, v.base) };
  }
  const person = await store.get(M.persons, v.target.personId);
  if (!person) return { ...v, ok: false, errors: [{ path: "target.personId", message: "対象のお客様が見つかりません" }], mode: null };
  if (v.target.stampValue % STAMP_UNIT !== 0) v.warnings.push({ path: "target.stampValue", message: `${STAMP_UNIT}スタンプごとの到達値ではありません` });
  const raw = await store.get(col, scriptId(v.target.personId, v.target.stampValue));
  if (!raw) return v.op === "update" ? { ...v, ok: false, errors: [{ path: "op", message: "更新対象の原稿がまだありません。op を create にしてください" }], mode: null } : { ...v, mode: "create" };
  if (v.op === "create") return { ...v, ok: false, errors: [{ path: "op", message: "この達成の原稿は既に存在します(既存を無断で上書きしません)。編集用データを書き出して op=update で取り込んでください" }], mode: null };
  return { ...v, mode: "update", raw, plan: planImport(kind, raw, v.data, v.base) };
}

/** プレビュー結果を保存。新規は作成、更新は採用された変更だけを書く(プレビュー後に更新されていたら拒否)。 */
export async function commitImport(store, kind, preview, decisions, { label } = {}) {
  const col = KINDS[kind].col;
  if (preview.mode === "create") {
    const d = buildNewDoc(kind, preview.data);
    const history = [{ at: nowIso(), by: clean(label), change: "import:create" }];
    if (kind === "event") {
      const id = newId("evo");
      await store.batch([{ op: "create", col, id, data: { ...d, masterId: null, masterRevisionAtCopy: null, status: "draft", history, createdAt: nowIso() } }]); return { id, mode: "create" };
    }
    const id = scriptId(preview.target.personId, preview.target.stampValue);
    await store.batch([{ op: "create", col, id, data: { ...d, personId: preview.target.personId, stampValue: preview.target.stampValue, scriptStatus: "draft", history, createdAt: nowIso() } }]); return { id, mode: "create" };
  }
  const id = kind === "event" ? preview.target.occurrenceId : scriptId(preview.target.personId, preview.target.stampValue);
  const cur = await store.get(col, id);
  if (!cur || cur.revision !== preview.raw.revision) throw new PortalError("conflict", "プレビュー後にデータが更新されました。もう一度「検証」からやり直してください");
  const { patch, fields } = applyPlan(kind, preview.raw, preview.data, preview.plan, decisions);
  if (!fields.length) throw new PortalError("nothing", "反映する変更がありません");
  await commitPatch(store, kind, id, cur, patch, label, `import:update:${fields.join(",")}`, cur.revision);
  return { id, mode: "update", fields };
}

/** 原稿の完成/未完成(利用者の明示操作)。実施済み(rpCeremonyRecords)とは別管理で、取り込みでは変わらない。 */
export async function setScriptStatus(store, id, status, { label } = {}) {
  if (!["draft", "complete"].includes(status)) throw new PortalError("bad-status", status);
  const cur = await store.get(M.ceremonyScripts, id); if (!cur) throw new PortalError("not-found", "原稿がありません");
  await commitPatch(store, "ceremony", id, cur, { scriptStatus: status }, label, `scriptStatus:${status}`, cur.revision);
}

/** セレモニー用の読み取り専用の事実情報(ChatGPTへ渡す)。個人備考・DM URLは含めない。数値はChatGPTが変更しても取り込まれない。 */
export function ceremonyFacts({ names, total, verStamps, stampValue, act, performance }) {
  return { readOnly: "この情報は参照用です。取り込み時は無視され、来店回数・Verスタンプ・実施状況は変更されません", customerNames: names, totalVisitCount: total ?? "不明", verStamps: verStamps ?? "不明", stampValue, stampUnit: STAMP_UNIT, decidedAct: act ?? "未決定", performanceStatus: performance ?? "未実施" };
}
export { exportDoc };

/** 手動での新規作成(空の下書き)。ChatGPTを使わない場合の入口。 */
export async function createBlankDoc(store, kind, init, { label } = {}) {
  const col = KINDS[kind].col; const history = [{ at: nowIso(), by: clean(label), change: "create:manual" }];
  if (kind === "event") {
    const name = clean(init.name); if (!name) throw new PortalError("empty-name", "イベント名が必要です");
    const id = newId("evo"); await store.batch([{ op: "create", col, id, data: { ...buildNewDoc("event", { name }), masterId: null, masterRevisionAtCopy: null, status: "draft", history, createdAt: nowIso() } }]); return id;
  }
  const id = scriptId(init.personId, init.stampValue);
  await store.batch([{ op: "create", col, id, data: { ...buildNewDoc("ceremony", { characterName: init.characterName ?? "" }), personId: init.personId, stampValue: init.stampValue, scriptStatus: "draft", history, createdAt: nowIso() } }]); return id;
}
