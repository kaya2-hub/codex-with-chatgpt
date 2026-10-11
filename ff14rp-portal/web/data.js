import { MASTER as M } from "../core/collections.js";
import { MemoryStore } from "../store/memory-store.js";
import { MemoryShopSource } from "../store/firestore-store.js";
import { syntheticShops } from "../fixtures/synthetic.js";
import { dryRun, applyPlan } from "../tools/migrate-lib.js";
import { buildIndex } from "../core/aggregate.js";

/** モード: demo(架空データ・メモリ) / firestore(portal-config.js が必要)。 */
export async function bootstrap() {
  let cfg = null;
  try { cfg = (await import("./portal-config.js")).default; } catch { /* 無ければdemo */ }
  if (cfg?.mode === "firestore") return bootFirestore(cfg);
  return bootDemo();
}

async function bootDemo() {
  const shops = syntheticShops();
  const store = new MemoryStore();
  const { plan } = dryRun(shops, { batchId: "demo-batch" });
  await applyPlan(store, plan);
  const src = {
    diner: new MemoryShopSource({ pixiesVisits: shops.dinerVisits, pixiesCustomers: shops.dinerCustomers }, "diner"),
    toko: new MemoryShopSource({ customerVisits: shops.tokoVisits, customers: shops.tokoSessionCustomers, items: shops.tokoItems, customerProfiles: shops.tokoProfiles }, "toko")
  };
  return { mode: "demo", store, src, links: { diner: "#", toko: "#" }, banner: "デモモード: 架空データ(メモリ上のみ。保存されません)", masterOrigin: "memory" };
}

async function bootFirestore(cfg) {
  const base = "https://www.gstatic.com/firebasejs/10.14.1/";
  const [{ initializeApp }, auth, fs, { FirestoreStore, ReadOnlyShopSource }] = await Promise.all([
    import(base + "firebase-app.js"), import(base + "firebase-auth.js"), import(base + "firebase-firestore.js"), import("../store/firestore-store.js")]);
  const open = async (conf, name) => { const app = initializeApp(conf, name); const a = auth.getAuth(app); await auth.signInAnonymously(a); return fs.getFirestore(app); }; // 既存方式(匿名)を踏襲。認証方式は変更しない
  const masterDb = await open(cfg.master, "master");
  const store = new FirestoreStore(masterDb, fs, { projectId: cfg.master.projectId, allowProductionMaster: cfg.allowProductionMaster === true });
  const dinerDb = cfg.master.projectId === cfg.diner.projectId ? masterDb : await open(cfg.diner, "diner");
  const tokoDb = await open(cfg.toko, "toko");
  return { mode: "firestore", store, src: { diner: new ReadOnlyShopSource(dinerDb, fs, "diner"), toko: new ReadOnlyShopSource(tokoDb, fs, "toko") },
    links: cfg.shopLinks || {}, banner: `Firestore接続中(マスター: ${cfg.master.projectId})。店舗原記録は読み取りのみ`, masterOrigin: cfg.master.projectId };
}

const tryList = async (src, name) => { try { return await src.list(name); } catch (e) { console.error(e); return null; } };

export async function loadAll(boot) {
  const { store, src } = boot;
  const [persons, characters, links, occs, masters, records, draws, changes, templates] = await Promise.all([
    store.list(M.persons), store.list(M.characters), store.list(M.sourceLinks), store.list(M.eventOccurrences), store.list(M.eventMasters),
    store.list(M.ceremonyRecords), store.list(M.ceremonyDraws), store.list(M.identityChanges), store.list(M.ceremonyTemplates)]);
  const [dv, tv, tc, ti, dc] = await Promise.all([tryList(src.diner, "pixiesVisits"), tryList(src.toko, "customerVisits"), tryList(src.toko, "customers"), tryList(src.toko, "items"), tryList(src.diner, "pixiesCustomers")]);
  const shop = {
    diner: dv ? { visits: dv, customers: dc } : null,
    toko: tv ? { visits: tv, sessionCustomers: tc || [], items: ti || [] } : null
  };
  return { persons, characters, links, occs, masters, records, draws, changes, templates, shop, index: buildIndex({ persons, characters, links }) };
}
