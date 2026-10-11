import { MemoryStore } from "../store/memory-store.js";
import { dryRun, applyPlan } from "../tools/migrate-lib.js";
import { syntheticShops } from "../fixtures/synthetic.js";
import { MASTER as M } from "../core/collections.js";

export async function freshStore() {
  const store = process.env.FIRESTORE_EMULATOR_HOST ? await emulatorStore() : new MemoryStore();
  return store;
}
let n = 0;
export async function emulatorStore() {
  const { initializeApp } = await import("firebase/app");
  const fs = await import("firebase/firestore");
  const { FirestoreStore } = await import("../store/firestore-store.js");
  const app = initializeApp({ projectId: "demo-ff14rp" }, `t${Date.now()}${n++}`);
  const db = fs.getFirestore(app);
  const [h, p] = process.env.FIRESTORE_EMULATOR_HOST.split(":");
  fs.connectFirestoreEmulator(db, h, Number(p));
  const store = new FirestoreStore(db, fs, { projectId: "demo-ff14rp" });
  // テスト間の独立性のため全マスターを空にする(エミュレータのみ)
  const { MASTER_COLLECTIONS } = await import("../core/collections.js");
  for (const c of MASTER_COLLECTIONS) for (const d of await store.list(c)) await fs.deleteDoc(fs.doc(db, c, d.id));
  return store;
}
export async function migratedStore() {
  const store = await freshStore();
  const shops = syntheticShops();
  const { plan } = dryRun(shops, { batchId: "b1", now: "2026-10-11T00:00:00.000Z" });
  await applyPlan(store, plan);
  return { store, shops, plan };
}
export const byName = async (store, name) => (await store.list(M.characters)).find(c => c.currentName === name);
