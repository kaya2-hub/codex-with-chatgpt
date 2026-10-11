import { clone, PortalError, nowIso } from "../core/util.js";
import { MASTER_COLLECTIONS } from "../core/collections.js";

// MasterStore契約: get/list/batch。batchは原子的。update/deleteは expectedRevision 必須。
export class MemoryStore {
  constructor(seed = {}) {
    this.cols = new Map();
    for (const [c, docs] of Object.entries(seed)) for (const [id, d] of Object.entries(docs)) this._set(c, id, clone(d));
    this.kind = "memory";
  }
  _col(c) {
    if (!MASTER_COLLECTIONS.includes(c)) throw new PortalError("collection-not-allowed", `書込/読込対象外のコレクション: ${c}`);
    if (!this.cols.has(c)) this.cols.set(c, new Map());
    return this.cols.get(c);
  }
  _set(c, id, d) { this._col(c).set(id, d); }
  async get(c, id) { const d = this._col(c).get(id); return d ? clone(d) : null; }
  async list(c) { return [...this._col(c).entries()].map(([id, d]) => ({ id, ...clone(d) })); }
  // ops: {op:'create'|'update'|'delete', col, id, data?, expectedRevision?}
  async batch(ops) {
    const staged = new Map();
    const read = (c, id) => staged.has(`${c}/${id}`) ? staged.get(`${c}/${id}`) : (this._col(c).get(id) ?? null);
    for (const o of ops) {
      const cur = read(o.col, o.id);
      if (o.op === "create") {
        if (cur) throw new PortalError("already-exists", `既に存在: ${o.col}/${o.id}`);
        staged.set(`${o.col}/${o.id}`, { ...clone(o.data), revision: 1, updatedAt: nowIso() });
      } else if (o.op === "update") {
        if (!cur) throw new PortalError("not-found", `存在しない: ${o.col}/${o.id}`);
        if (o.expectedRevision !== cur.revision) throw new PortalError("conflict", `他の更新と競合しました: ${o.col}/${o.id}`, { expected: o.expectedRevision, actual: cur.revision });
        staged.set(`${o.col}/${o.id}`, { ...cur, ...clone(o.data), revision: cur.revision + 1, updatedAt: nowIso() });
      } else if (o.op === "delete") {
        if (!cur) throw new PortalError("not-found", `存在しない: ${o.col}/${o.id}`);
        if (o.expectedRevision !== cur.revision) throw new PortalError("conflict", `他の更新と競合しました: ${o.col}/${o.id}`);
        staged.set(`${o.col}/${o.id}`, null);
      } else throw new PortalError("bad-op", `不明な操作: ${o.op}`);
    }
    for (const [k, v] of staged) {
      const [c, ...r] = k.split("/"); const id = r.join("/");
      if (v === null) this._col(c).delete(id); else this._set(c, id, v);
    }
    return ops.length;
  }
}
