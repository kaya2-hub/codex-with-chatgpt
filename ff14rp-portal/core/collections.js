// 書込許可コレクション(共通マスター)と、読み取り専用の店舗原記録を分離する唯一の定義。
export const MASTER = Object.freeze({
  persons: "rpPersons",
  characters: "rpCharacters",
  sourceLinks: "rpSourceLinks",
  identityChanges: "rpIdentityChanges",
  eventMasters: "rpEventMasters",
  eventOccurrences: "rpEventOccurrences",
  ceremonyRecords: "rpCeremonyRecords",
  ceremonyDraws: "rpCeremonyDraws",
  ceremonyTemplates: "rpCeremonyTemplates",
  migrationBatches: "rpMigrationBatches"
});
export const MASTER_COLLECTIONS = Object.freeze(Object.values(MASTER));

// 店舗原記録(読み取りのみ)。ここに書く経路はコード上存在しない。
export const SHOP = Object.freeze({
  diner: { projectId: "pixies-diner", customers: "pixiesCustomers", visits: "pixiesVisits", menu: "pixiesMenu" },
  toko: { projectId: "tokowakatei-receipt", profiles: "customerProfiles", visits: "customerVisits", sessionCustomers: "customers", items: "items", logs: "logs" }
});
export const PRODUCTION_PROJECT_IDS = Object.freeze([SHOP.diner.projectId, SHOP.toko.projectId]);
