import { hash, norm } from "./util.js";
import { stripWorld } from "./identity-plan.js";

// 常若亭の顧客IDは名前由来(profile-<hash>)。読み取り照合専用。書込には使わない。
export const tokoProfileIdForName = name => `profile-${hash(norm(stripWorld(name)))}`;

/** 人物の横断履歴(読み取り専用ビュー)。店舗原記録の名前・単価・数量はそのまま。確定リンクのみ。 */
export function buildHistory(entry, shop) {
  const rows = [];
  const dIds = new Set(entry.links.filter(l => l.sourceSystem === "diner").map(l => l.sourceId));
  const tIds = new Set(entry.links.filter(l => l.sourceSystem === "toko").map(l => l.sourceId));
  if (shop.diner) for (const v of shop.diner.visits) if (dIds.has(v.customerId)) {
    rows.push({ shop: "diner", date: String(v.visitAt || "").slice(0, 10), sourceId: v.id, name: v.customerName,
      text: [v.foodName, v.drinkName].filter(Boolean).join(" / ") + (v.payment != null ? `  ${v.payment}G` : ""), type: v.orderType,
      ver: v.orderType === "VER" ? (v.verCounted ? "♥" : "♡") : "" });
  }
  if (shop.toko) {
    const sessionCustomers = shop.toko.sessionCustomers || [], items = shop.toko.items || [];
    for (const v of shop.toko.visits) if (tIds.has(v.profileId)) {
      const sid = v.sourceSessionId || v.visitDate;
      const orders = [];
      for (const c of sessionCustomers) {
        if (c.sessionId !== sid) continue;
        if ((c.profileId || tokoProfileIdForName(c.name)) !== v.profileId) continue;
        for (const it of items) if (it.customerId === c.id) orders.push(`${it.displayName || it.menuName} ×${it.quantity} @${it.unitPrice}`);
      }
      rows.push({ shop: "toko", date: v.visitDate, sourceId: v.id, name: v.customerName, text: orders.join(", "), type: v.source || "", ver: "" });
    }
  }
  return rows.sort((a, b) => b.date.localeCompare(a.date));
}
