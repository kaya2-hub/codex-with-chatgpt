// 完全に架空のデータ。実在の顧客・DM URL・備考は一切含まない。
const T = "2026-01-01T00:00:00.000Z";
const dc = (id, customerName, extra = {}) => ({ id, customerName, previousNames: [], xDmUrl: "", customerNote: "", createdAt: T, updatedAt: T, ...extra });

export function syntheticShops() {
  const dinerCustomers = [
    dc("cus_a", "Test Alpha", { xDmUrl: "https://x.example/dm/alpha", customerNote: "架空メモA" }),
    dc("cus_b", "Test Beta", { xDmUrl: "https://x.example/dm/beta" }),
    dc("cus_c", "Test Gamma", { previousNames: ["Old Gamma"], xDmUrl: "https://x.example/dm/gamma" }),
    dc("cus_d", "Test Delta"),                                   // DMリンクなし
    dc("cus_e", "Same Name", { xDmUrl: "https://x.example/dm/e" }),
    dc("cus_f", "Twin Name", { xDmUrl: "https://x.example/dm/f" }),
    dc("cus_g", "Other Person", { previousNames: ["Twin Name"] })  // 旧名が別顧客の現在名と衝突 → 曖昧
  ];
  const dinerVisits = [];
  let n = 0;
  const addVisits = (customerId, name, count, o = {}) => {
    for (let i = 0; i < count; i++) {
      n++;
      dinerVisits.push({ id: `vis_${n}`, customerId, customerName: name, visitAt: o.dateOf ? o.dateOf(i) : `2026-02-${String((i % 28) + 1).padStart(2, "0")}`,
        orderType: o.orderType ?? "VER", foodCode: "F1", foodName: "架空ごはん", listPrice: 1000, payment: 1000, billingStatus: "paid",
        verCounted: o.verCounted ?? true, verCountExclusion: o.verCounted === false ? "no_x_link" : "", verCountOverride: o.override ?? "" });
    }
  };
  addVisits("cus_a", "Test Alpha", 14);
  addVisits("cus_b", "Test Beta", 6);
  addVisits("cus_c", "Test Gamma", 7);
  addVisits("cus_d", "Test Delta", 3, { verCounted: false, override: "not_counted" });
  addVisits("cus_e", "Same Name", 2, { orderType: "A", verCounted: false });
  addVisits("cus_f", "Twin Name", 1);
  const tokoProfiles = [
    { id: "profile-t1", name: "Test Alpha Bahamut", normalizedName: "testalphabahamut", notes: "旧備考(移行しない)" },
    { id: "profile-t2", name: "Toko Only", normalizedName: "tokoonly", notes: "" },
    { id: "profile-t3", name: "Same Name", normalizedName: "samename", notes: "" },
    { id: "profile-t4", name: "Twin Name", normalizedName: "twinname", notes: "" },
    { id: "profile-t5", name: "Test Beta", normalizedName: "testbeta", notes: "" }
  ];
  const tokoVisits = [
    { id: "rv1", profileId: "profile-t1", customerName: "Test Alpha", visitDate: "2026-03-01", sourceSessionId: "2026-03-01", source: "receipt" },
    { id: "rv2", profileId: "profile-t1", customerName: "Test Alpha", visitDate: "2026-03-01", sourceSessionId: "2026-03-01", source: "receipt" }, // 同営業回→1回
    { id: "rv3", profileId: "profile-t1", customerName: "Test Alpha", visitDate: "2026-03-08", sourceSessionId: "2026-03-08", source: "receipt" },
    { id: "nv1", profileId: "profile-t1", customerName: "Test Alpha", visitDate: "2025-12-01", source: "notion" },               // 営業回IDなし
    { id: "rv4", profileId: "profile-t2", customerName: "Toko Only", visitDate: "2026-03-01", sourceSessionId: "2026-03-01", source: "receipt" },
    { id: "rv5", profileId: "profile-t3", customerName: "Same Name", visitDate: "2026-03-01", sourceSessionId: "2026-03-01", source: "receipt" }
  ];
  const tokoSessionCustomers = [{ id: "sc1", sessionId: "2026-03-01", name: "Test Alpha", profileId: "profile-t1" }, { id: "sc2", sessionId: "2026-03-01", name: "Toko Only", profileId: "profile-t2" }];
  const tokoItems = [{ id: "it1", sessionId: "2026-03-01", customerId: "sc1", menuName: "架空紅茶", displayName: "架空紅茶", unitPrice: 300, quantity: 2 }, { id: "it2", sessionId: "2026-03-01", customerId: "sc2", menuName: "架空ケーキ", displayName: "架空ケーキ", unitPrice: 500, quantity: 1 }];
  return { dinerCustomers, dinerVisits, tokoProfiles, tokoVisits, tokoSessionCustomers, tokoItems };
}
