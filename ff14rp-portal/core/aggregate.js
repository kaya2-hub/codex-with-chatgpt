// 集計。来店 / Verスタンプ / 注文 / セレモニー到達 は別指標として別フィールドで返す。
// 店舗の読込が失敗した場合は合計を確定値にせず null を返す(捏造しない)。
export const STAMP_UNIT = 7; // 資料上のセンキューカード対象到達数(運用者確認事項として設定可能)

const visitDate = v => String(v.visitAt || "").slice(0, 10);

export function buildIndex({ persons, characters, links }) {
  const activePersons = persons.filter(p => !p.mergedInto);
  const confirmed = links.filter(l => l.linkStatus === "confirmed");
  const byPerson = new Map(activePersons.map(p => [p.id, { person: p, characters: [], links: [], candidateLinks: [] }]));
  for (const c of characters) byPerson.get(c.personId)?.characters.push(c);
  for (const l of confirmed) byPerson.get(l.personId)?.links.push(l);
  for (const l of links) if (l.linkStatus !== "confirmed") for (const pid of l.candidatePersonIds || [l.personId]) byPerson.get(pid)?.candidateLinks.push(l);
  return byPerson;
}

/**
 * 人物単位の集計。
 * shop = { diner: {customers?, visits} | null, toko: {visits} | null }  null=読込失敗
 * ダイナー: 来店=pixiesVisits件数(元visitIdで一意)。営業回IDが無いので日付での重複排除は行わない。
 *   同一人物の複数ダイナー顧客が同日にあれば sameDateAcrossLinks に列挙するだけ(要確認)。
 * 常若亭: customerVisitsのうち sourceSessionId(営業回ID)を持つものは(人物,営業回)で1回に集約。
 *   営業回IDが無い(Notion由来等)は集約せず個別に数え、unverifiableCount に出す。
 * Verスタンプ: 保存済み verCounted=true かつ orderType=VER を数える(現在のDMリンクで再判定しない)。
 */
export function personStats(entry, shop) {
  const dinerIds = new Set(entry.links.filter(l => l.sourceSystem === "diner").map(l => l.sourceId));
  const tokoIds = new Set(entry.links.filter(l => l.sourceSystem === "toko").map(l => l.sourceId));
  const out = { diner: null, toko: null, total: null, notes: [] };
  if (dinerIds.size === 0) out.diner = { linked: false, visits: 0, verStamps: 0, orders: 0 };
  else if (shop.diner) {
    const vs = shop.diner.visits.filter(v => dinerIds.has(v.customerId));
    const days = new Map();
    vs.forEach(v => { const d = visitDate(v); if (!days.has(d)) days.set(d, new Set()); days.get(d).add(v.customerId); });
    const same = [...days.entries()].filter(([, s]) => s.size > 1).map(([d]) => d);
    out.diner = {
      linked: true, visits: vs.length,
      verStamps: vs.filter(v => v.orderType === "VER" && v.verCounted === true).length,
      verVisits: vs.filter(v => v.orderType === "VER").length,
      orders: vs.length, sameDateAcrossLinks: same
    };
    if (same.length) out.notes.push(`ダイナーで複数キャラが同日に来店している可能性: ${same.length}日(営業回IDが無いため自動で1回にしません)`);
  }
  if (tokoIds.size === 0) out.toko = { linked: false, visits: 0, unverifiableCount: 0 };
  else if (shop.toko) {
    const vs = shop.toko.visits.filter(v => tokoIds.has(v.profileId));
    const sessions = new Set(); let unverifiable = 0, count = 0;
    for (const v of vs) {
      const sid = v.sourceSessionId || "";
      if (sid) { if (!sessions.has(sid)) { sessions.add(sid); count++; } }
      else { count++; unverifiable++; }
    }
    out.toko = { linked: true, visits: count, rawRows: vs.length, unverifiableCount: unverifiable };
    if (unverifiable) out.notes.push(`常若亭の営業回ID無し来店 ${unverifiable}件は集約できず個別に計上(確認要)`);
  }
  if (out.diner && out.toko && (!out.diner.linked || shop.diner) && (!out.toko.linked || shop.toko)) {
    out.total = out.diner.visits + out.toko.visits;
  } else out.notes.push("店舗の読込失敗のため総合来店回数は未確定");
  if (entry.candidateLinks.length) out.notes.push(`未確認の照合候補 ${entry.candidateLinks.length}件は集計に含めていません`);
  return out;
}

/** セレモニー到達: Verスタンプ数/7。来店回数とは混同しない。 */
export function ceremonyUnits(verStamps, unit = STAMP_UNIT) {
  const out = []; for (let n = unit; n <= verStamps; n += unit) out.push(n); return out;
}
