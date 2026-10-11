import { PortalError, clone, nowIso } from "../core/util.js";
import { MASTER_COLLECTIONS, PRODUCTION_PROJECT_IDS } from "../core/collections.js";

// Firestore版MasterStore。SDK関数は注入(ブラウザはCDN版、Nodeはfirebase npm)。
// sdk = { doc, getDoc, getDocs, collection, runTransaction }
export class FirestoreStore {
  constructor(db, sdk, { projectId, allowProductionMaster = false } = {}) {
    if (PRODUCTION_PROJECT_IDS.includes(projectId) && !allowProductionMaster) {
      throw new PortalError("production-blocked", "本番プロジェクトへのマスター書込は明示許可(allowProductionMaster)が必要です");
    }
    this.db = db; this.s = sdk; this.kind = "firestore"; this.projectId = projectId;
  }
  _check(c) { if (!MASTER_COLLECTIONS.includes(c)) throw new PortalError("collection-not-allowed", `対象外のコレクション: ${c}`); }
  async get(c, id) { this._check(c); const snap = await this.s.getDoc(this.s.doc(this.db, c, id)); return snap.exists() ? clone(snap.data()) : null; }
  async list(c) { this._check(c); const snap = await this.s.getDocs(this.s.collection(this.db, c)); return snap.docs.map(d => ({ id: d.id, ...clone(d.data()) })); }
  async batch(ops) {
    ops.forEach(o => this._check(o.col));
    await this.s.runTransaction(this.db, async tx => {
      const refs = ops.map(o => this.s.doc(this.db, o.col, o.id));
      const snaps = [];
      for (const r of refs) snaps.push(await tx.get(r));        // 読み取りを先に
      const seen = new Map();
      ops.forEach((o, i) => {
        const key = `${o.col}/${o.id}`;
        const cur = seen.has(key) ? seen.get(key) : (snaps[i].exists() ? snaps[i].data() : null);
        if (o.op === "create") {
          if (cur) throw new PortalError("already-exists", `既に存在: ${key}`);
          const d = { ...clone(o.data), revision: 1, updatedAt: nowIso() }; tx.set(refs[i], d); seen.set(key, d);
        } else if (o.op === "update") {
          if (!cur) throw new PortalError("not-found", `存在しない: ${key}`);
          if (o.expectedRevision !== cur.revision) throw new PortalError("conflict", `他の更新と競合しました: ${key}`, { expected: o.expectedRevision, actual: cur.revision });
          const d = { ...cur, ...clone(o.data), revision: cur.revision + 1, updatedAt: nowIso() }; tx.set(refs[i], d); seen.set(key, d);
        } else if (o.op === "delete") {
          if (!cur) throw new PortalError("not-found", `存在しない: ${key}`);
          if (o.expectedRevision !== cur.revision) throw new PortalError("conflict", `他の更新と競合しました: ${key}`);
          tx.delete(refs[i]); seen.set(key, null);
        } else throw new PortalError("bad-op", o.op);
      });
    });
    return ops.length;
  }
}

// 店舗原記録の読み取り専用アダプター。公開メソッドはread系のみ(書込メソッドを持たない)。
export class ReadOnlyShopSource {
  constructor(db, sdk, label) { this.db = db; this.s = sdk; this.label = label; Object.freeze(this); }
  async list(collectionName) {
    const snap = await this.s.getDocs(this.s.collection(this.db, collectionName));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }
}
export class MemoryShopSource {
  constructor(data, label) { this.data = data; this.label = label; this.failing = new Set(); }
  async list(name) {
    if (this.failing.has(name)) throw new PortalError("shop-read-failed", `${this.label}:${name}の読込に失敗`);
    return clone(this.data[name] || []);
  }
}
