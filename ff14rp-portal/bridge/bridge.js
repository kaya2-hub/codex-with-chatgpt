// 店舗アプリ用「共通顧客マスター連携ブリッジ」。
// - 切替フラグ(rpMigrationBatches/cutover)が <system>Mode==="master" のときだけ有効。それ以外/読込失敗は何もしない(=従来動作)。
// - 備考(customerNote)とDMリンク(xDmUrl)の正本を共通Personにする。店舗側の旧フィールドは読み書きとも削除・上書きしない(凍結)。
// - SDK関数は注入(ブラウザは店舗アプリが読み込んだgstatic版、Nodeテストはfirebase npm)。
import { MASTER as M } from "../core/collections.js";
import { personIdFor, characterIdFor, linkId } from "../core/identity-plan.js";

export const BRIDGE_VERSION = "0.1.0";
const SRC = { diner: "pixiesCustomers", toko: "customerProfiles" };
const iso = () => new Date().toISOString();
const isUrl = v => /^https?:\/\/\S+$/i.test(String(v ?? "").trim());
// reconcileAllowed: 店舗アプリの「過去Verを現在のDM有無で書き換える処理」を許可してよいか。
//  フラグを読めて、かつ一度もmasterにしたことがない(従来運用のまま)場合だけtrue。master中/master経験後/フラグ読込失敗はfalse(店舗側旧DMは凍結・古いため)。
const inactive = (mode, system, reconcileAllowed = false) => ({ active: false, mode, system, version: BRIDGE_VERSION, reconcileAllowed, overlay: c => c, overlayProfile: p => p, subscribe() {}, linked: () => false,
  async persistInfo() {}, async persistInfoMany() {}, async syncName() {}, async persistNote() { throw new Error("master bridge inactive"); } });

export async function createBridge({ db, sdk, system, label = "店舗画面" }) {
  const { doc, getDoc, getDocs, collection, onSnapshot, runTransaction } = sdk;
  let mode = "off", everMaster = false;
  try { const f = await getDoc(doc(db, M.migrationBatches, "cutover")); if (f.exists()) { const d = f.data(); mode = d[`${system}Mode`] || "off"; everMaster = (d.history || []).some(h => h.system === system && h.mode === "master"); } }
  catch (e) { console.warn("cutover flag unreadable -> legacy mode (reconcile blocked)", e); return inactive("unknown", system, false); }
  if (mode !== "master") return inactive(mode, system, !everMaster);

  const sourceType = SRC[system];
  let persons = new Map(), links = new Map(), listeners = [];
  const loadAll = async () => {
    persons = new Map((await getDocs(collection(db, M.persons))).docs.map(d => [d.id, d.data()]));
    links = new Map((await getDocs(collection(db, M.sourceLinks))).docs.map(d => d.data()).filter(l => l.sourceSystem === system && l.sourceType === sourceType).map(l => [l.sourceId, l]));
  };
  await loadAll();
  const touch = async (pid, lid) => { // 保存後は該当文書だけ読み直す(全件再読込はしない)
    const ps = await getDoc(doc(db, M.persons, pid)); if (ps.exists()) persons.set(pid, ps.data());
    if (lid) { const ls = await getDoc(doc(db, M.sourceLinks, lid)); if (ls.exists()) links.set(ls.data().sourceId, ls.data()); }
  };
  const norm = v => String(v ?? "").normalize("NFKC").toLowerCase().replace(/[\s　]/g, "");
  const resolve = pid => { let p = persons.get(pid), id = pid, n = 0; while (p?.mergedInto && n++ < 5) { id = p.mergedInto; p = persons.get(id); } return p ? { id, p } : null; };
  const confirmedLink = sid => { const l = links.get(sid); return l && l.linkStatus === "confirmed" ? l : null; };
  const txResolve = async (tx, pid) => { let id = pid; for (let i = 0; i < 5; i++) { const s = await tx.get(doc(db, M.persons, id)); if (!s.exists()) return null; const d = s.data(); if (!d.mergedInto) return { id, ref: s.ref, d }; id = d.mergedInto; } return null; };
  const cleanNote = v => String(v ?? "").replace(/\r\n/g, "\n");

  const logDoc = (tx, personId, diffs, kind) => tx.set(doc(db, M.identityChanges, `chg-${system}app-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`), { kind, label, reason: `${system}-app`, at: iso(), diffs, undone: false, revision: 1, updatedAt: iso() });

  const bridge = {
    active: true, mode, system, version: BRIDGE_VERSION, reconcileAllowed: false,
    linked: sid => !!confirmedLink(sid),
    /** ダイナー顧客オブジェクトへ共通値を重ねる。連携済みのみ。未連携は従来値のまま。 */
    overlay(c) {
      const l = confirmedLink(c.customerId); const r = l && resolve(l.personId);
      if (!r) { c._master = false; return c; }
      c.xDmUrl = r.p.xDmUrl || ""; c.customerNote = r.p.customerNote || ""; c._master = true; c._personId = r.id; return c;
    },
    /** 常若亭プロフィールへ共通備考を重ねる。旧備考(legacyNotes)は参照用に保持。 */
    overlayProfile(p) {
      const l = confirmedLink(p.id); const r = l && resolve(l.personId);
      if (!r) return { ...p, _master: false };
      return { ...p, notes: r.p.customerNote || "", legacyNotes: p.notes || "", _master: true, _personId: r.id };
    },
    subscribe(cb) {
      let queued = false; const fire = () => { if (queued) return; queued = true; Promise.resolve().then(() => { queued = false; cb(); }); };
      listeners.push(onSnapshot(collection(db, M.persons), s => { persons = new Map(s.docs.map(d => [d.id, d.data()])); fire(); }, e => console.warn(e)));
      listeners.push(onSnapshot(collection(db, M.sourceLinks), s => { links = new Map(s.docs.map(d => d.data()).filter(l => l.sourceSystem === system && l.sourceType === sourceType).map(l => [l.sourceId, l])); fire(); }, e => console.warn(e)));
    },
    /** ダイナー顧客の備考/DMを共通Personへ保存。未連携なら新規Personを作成(既存人物へは自動統合しない)。 */
    async persistInfo(c, { allowClear = true } = {}) {
      if (system !== "diner") throw new Error("persistInfo is diner-only");
      const sid = c.customerId;
      const next = { customerNote: cleanNote(c.customerNote), xDmUrl: String(c.xDmUrl ?? "").trim() };
      if (next.xDmUrl && !isUrl(next.xDmUrl)) throw new Error("XのDMリンクは http:// または https:// から入力してね");
      let touchedPid = null, touchedLink = null;
      await runTransaction(db, async tx => {
        touchedPid = null; touchedLink = null;
        const lref = doc(db, M.sourceLinks, linkId("diner", sourceType, sid));
        const ls = await tx.get(lref);
        if (!ls.exists()) {
          // 新規顧客(移行後に店舗で登録)。独立したPerson/Character/SourceLinkを作る。
          const pid = personIdFor("diner", sid), cid = characterIdFor("diner", sid);
          const ps = await tx.get(doc(db, M.persons, pid));
          if (ps.exists()) throw new Error("共通マスターに同じIDの人物が既に存在します。総合DBで確認してください");
          const t = iso();
          tx.set(doc(db, M.persons, pid), { primaryCharacterId: cid, customerNote: next.customerNote, xDmUrl: next.xDmUrl, origin: "diner", createdAt: t, createdBy: `${system}-app`, revision: 1, updatedAt: t });
          tx.set(doc(db, M.characters, cid), { personId: pid, currentName: c.customerName, previousNames: [], legacyNameCandidates: [], world: null, origin: "diner", createdAt: t, revision: 1, updatedAt: t });
          tx.set(lref, { sourceSystem: "diner", sourceType, sourceId: sid, personId: pid, characterId: cid, linkStatus: "confirmed", basis: "diner-app-new", createdAt: t, revision: 1, updatedAt: t });
          logDoc(tx, pid, [{ type: "create", col: M.persons, id: pid, after: {} }, { type: "create", col: M.characters, id: cid, after: {} }, { type: "create", col: M.sourceLinks, id: lref.id, after: {} }], "appNewCustomer");
          touchedPid = pid; touchedLink = lref.id;
          return;
        }
        const l = ls.data();
        if (l.linkStatus !== "confirmed") throw new Error("この顧客の共通マスター連携が未確認です。総合DBで確認してください");
        // 同じ顧客IDでも、共通側のキャラ名と一致しなければ別人の可能性があるため書かない(名前だけでの紐付けはしない)
        if (l.characterId) {
          const cs = await tx.get(doc(db, M.characters, l.characterId));
          if (cs.exists()) { const ch = cs.data(); const names = [ch.currentName, ...(ch.previousNames || []), ...(ch.legacyNameCandidates || [])].map(norm); if (c.customerName && !names.includes(norm(c.customerName))) throw new Error("お名前が共通顧客マスターの人物と一致しません(別の方の可能性)。総合DBで確認してね"); }
        }
        const r = await txResolve(tx, l.personId); if (!r) throw new Error("共通マスターの人物が見つかりません");
        touchedPid = r.id;
        const patch = {};
        for (const f of ["customerNote", "xDmUrl"]) {
          if (next[f] === (r.d[f] ?? "")) continue;
          if (!allowClear && next[f] === "" && (r.d[f] ?? "") !== "") continue; // 一括取込では空で既存値を消さない
          patch[f] = next[f];
        }
        if (!Object.keys(patch).length) return;
        const before = Object.fromEntries(Object.keys(patch).map(f => [f, r.d[f] ?? null]));
        tx.set(r.ref, { ...r.d, ...patch, revision: (r.d.revision || 1) + 1, updatedAt: iso() });
        logDoc(tx, r.id, [{ type: "update", col: M.persons, id: r.id, before, after: patch, revisionAfter: (r.d.revision || 1) + 1 }], "editPersonInfo");
      });
      if (touchedPid) await touch(touchedPid, touchedLink);
    },
    /** ダイナー側で名前変更(統合でない)された場合、共通側Characterを改名として更新(旧名保持)。旧名が一致しなければ拒否。 */
    async syncName(customerId, oldName, newName) {
      let pid = null;
      await runTransaction(db, async tx => {
        const ls = await tx.get(doc(db, M.sourceLinks, linkId("diner", sourceType, customerId)));
        if (!ls.exists() || ls.data().linkStatus !== "confirmed" || !ls.data().characterId) return; // 未連携: persistInfoが新規作成する
        const cref = doc(db, M.characters, ls.data().characterId); const cs = await tx.get(cref); if (!cs.exists()) return;
        const ch = cs.data(); if (norm(ch.currentName) === norm(newName)) return;
        if (norm(ch.currentName) !== norm(oldName)) throw new Error("共通顧客マスターのお名前が店舗側の旧名と違います。総合DBで確認してね");
        const prev = (ch.previousNames || []).some(x => norm(x) === norm(ch.currentName)) ? ch.previousNames : [...(ch.previousNames || []), ch.currentName];
        const rev = (ch.revision || 1) + 1;
        tx.set(cref, { ...ch, currentName: newName, previousNames: prev.filter(x => norm(x) !== norm(newName)), revision: rev, updatedAt: iso() });
        logDoc(tx, ls.data().personId, [{ type: "update", col: M.characters, id: cref.id, before: { currentName: ch.currentName, previousNames: ch.previousNames || [] }, after: { currentName: newName, previousNames: prev.filter(x => norm(x) !== norm(newName)) }, revisionAfter: rev }], "renameCharacter");
        pid = ls.data().personId;
      });
    },
    async persistInfoMany(customers) { for (const c of customers) await bridge.persistInfo(c, { allowClear: false }); },
    /** 常若亭: 共通備考のみ保存。連携確認済みの人物だけ(未確認は呼び出し側で従来保存)。 */
    async persistNote(profileId, notes) {
      if (system !== "toko") throw new Error("persistNote is toko-only");
      const next = cleanNote(notes); let touchedPid = null;
      await runTransaction(db, async tx => {
        const ls = await tx.get(doc(db, M.sourceLinks, linkId("toko", sourceType, profileId)));
        if (!ls.exists() || ls.data().linkStatus !== "confirmed") throw Object.assign(new Error("not-linked"), { code: "not-linked" });
        const r = await txResolve(tx, ls.data().personId); if (!r) throw new Error("共通マスターの人物が見つかりません");
        if (next === (r.d.customerNote ?? "")) return;
        tx.set(r.ref, { ...r.d, customerNote: next, revision: (r.d.revision || 1) + 1, updatedAt: iso() });
        logDoc(tx, r.id, [{ type: "update", col: M.persons, id: r.id, before: { customerNote: r.d.customerNote ?? null }, after: { customerNote: next }, revisionAfter: (r.d.revision || 1) + 1 }], "editPersonInfo");
        touchedPid = r.id;
      });
      if (touchedPid) await touch(touchedPid);
    },
    dispose() { listeners.forEach(u => u()); listeners = []; }
  };
  if (typeof document !== "undefined") {
    const b = document.createElement("div"); b.id = "ff14rp-master-badge";
    b.textContent = "共通顧客マスター連携中(備考・DMは総合DBと共通)";
    b.style.cssText = "position:fixed;right:8px;bottom:8px;z-index:99999;background:#4b3f7a;color:#fff;font:11px system-ui;padding:3px 8px;border-radius:99px;opacity:.85;pointer-events:none";
    document.body.append(b);
  }
  return bridge;
}
