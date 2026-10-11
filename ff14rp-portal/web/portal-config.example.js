// Firestore接続モード用の設定例。コピーして portal-config.js にすると有効化(portal-config.jsはGit管理外)。
// 無ければ架空データのデモモードで起動します。
// 認証は既存店舗と同じ匿名ログインを踏襲(認証方式・Firestoreルールは変更しません)。
export default {
  mode: "firestore",
  // 共通マスター(rp*コレクション)を置くプロジェクト。第一候補は pixies-diner だが、
  // 本番マスター書込みはGate0(復元検証PASS)・差分監査・利用者承認が揃うまで allowProductionMaster を true にしないこと。
  master: { apiKey: "…", authDomain: "…", projectId: "…", appId: "…" },
  diner:  { apiKey: "…", authDomain: "…", projectId: "…", appId: "…" },   // 読み取り専用で使用
  toko:   { apiKey: "…", authDomain: "…", projectId: "…", appId: "…" },   // 読み取り専用で使用
  allowProductionMaster: false,
  shopLinks: { diner: "https://<diner-site>", toko: "https://<toko-site>" }
};
