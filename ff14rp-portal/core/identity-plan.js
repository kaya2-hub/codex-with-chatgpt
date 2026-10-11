import { norm, clean, stable, hash, safeId, nowIso } from "./util.js";

const WORLDS = ["Pandaemonium","Alexander","Mandragora","Carbuncle","Masamune","Bahamut","Durandal","Tiamat","Tonberry","Chocobo","Gungnir","Shinryu","Valefor","Yojimbo","Zeromus","Atomos","Belias","Garuda","Hades","Kujata","Ramuh","Unicorn","Aegis","Anima","Asura","Fenrir","Ifrit","Ixion","Ridill","Titan","Typhon","Ultima"].sort((a,b)=>b.length-a.length);
// 常若亭のcleanCustomerNameと同じ規則(照合用。元データは書き換えない)
export function stripWorld(value) {
  const name = String(value ?? "").normalize("NFKC").replace(/[\s　]+/g, " ").trim();
  for (const w of WORLDS) {
    if (!name.endsWith(w)) continue;
    const rest = name.slice(0, -w.length).trim();
    if (rest.split(" ").filter(Boolean).length >= 2) return rest;
  }
  return name;
}

export const linkId = (system, type, sourceId) => `${system}__${type}__${safeId(sourceId)}`;
export const personIdFor = (system, sourceId) => `person-${system}-${safeId(sourceId)}`;
export const characterIdFor = (system, sourceId) => `char-${system}-${safeId(sourceId)}`;

/**
 * 移行計画(純関数・書込なし)。
 * - ダイナー顧客1件=Person1+Character1+SourceLink1(confirmed)。元IDをそのまま使う。
 * - 常若亭プロフィール: ダイナーの現在名/ID一致だけが「候補」。候補は自動統合せず、
 *   SourceLink(status=candidate)としてダイナーPersonを指すのみ。集計には入れない。
 * - 候補なしの常若亭プロフィールは独立Person(常若亭のみの客)として登録。
 * - 常若亭の旧備考(notes)は取り込まない。ダイナーのcustomerNote/xDmUrlのみ共通正本へ。
 * - 旧名(previousNames)は改名か別キャラか不明なので legacyNameCandidates に保持(分類は人が行う)。
 */
export function buildMigrationPlan({ dinerCustomers = [], tokoProfiles = [] }, { batchId = "batch-unset", now = nowIso() } = {}) {
  const persons = [], characters = [], sourceLinks = [];
  const base = { createdAt: now, migrationBatchId: batchId };

  const dinerByName = new Map(); // 正規化名 -> [customer]
  const dinerByLegacy = new Map();
  for (const c of dinerCustomers) {
    const pid = personIdFor("diner", c.id), cid = characterIdFor("diner", c.id);
    persons.push({ id: pid, primaryCharacterId: cid, customerNote: clean(c.customerNote), xDmUrl: clean(c.xDmUrl), origin: "diner", ...base, createdBy: "migration" });
    characters.push({ id: cid, personId: pid, currentName: clean(c.customerName), previousNames: [], legacyNameCandidates: (c.previousNames || []).map(clean).filter(Boolean), world: null, origin: "diner", ...base });
    sourceLinks.push({ id: linkId("diner", "pixiesCustomers", c.id), sourceSystem: "diner", sourceType: "pixiesCustomers", sourceId: c.id, personId: pid, characterId: cid, linkStatus: "confirmed", basis: "diner-baseline", ...base });
    const k = norm(stripWorld(c.customerName));
    if (!dinerByName.has(k)) dinerByName.set(k, []);
    dinerByName.get(k).push(c);
    for (const p of c.previousNames || []) {
      const lk = norm(stripWorld(p)); if (!lk) continue;
      if (!dinerByLegacy.has(lk)) dinerByLegacy.set(lk, []);
      dinerByLegacy.get(lk).push(c);
    }
  }

  const candidates = [];
  let tokoOnly = 0;
  for (const p of tokoProfiles) {
    const k = norm(stripWorld(p.name));
    const exact = dinerByName.get(k) || [];
    const legacy = (dinerByLegacy.get(k) || []).filter(c => !exact.includes(c));
    const hits = [...exact.map(c => ({ c, via: "currentName" })), ...legacy.map(c => ({ c, via: "legacyName" }))];
    if (hits.length === 0) {
      const pid = personIdFor("toko", p.id), cid = characterIdFor("toko", p.id);
      persons.push({ id: pid, primaryCharacterId: cid, customerNote: "", xDmUrl: "", origin: "toko", ...base, createdBy: "migration" });
      characters.push({ id: cid, personId: pid, currentName: clean(stripWorld(p.name)), previousNames: [], legacyNameCandidates: [], world: null, origin: "toko", ...base });
      sourceLinks.push({ id: linkId("toko", "customerProfiles", p.id), sourceSystem: "toko", sourceType: "customerProfiles", sourceId: p.id, personId: pid, characterId: cid, linkStatus: "confirmed", basis: "toko-only", ...base });
      tokoOnly++;
    } else {
      // 候補: 先頭を提示。複数ヒットは曖昧として全件列挙し、どれにも自動確定しない。
      const first = hits[0].c;
      sourceLinks.push({ id: linkId("toko", "customerProfiles", p.id), sourceSystem: "toko", sourceType: "customerProfiles", sourceId: p.id, personId: personIdFor("diner", first.id), characterId: null, linkStatus: "candidate", basis: hits.length > 1 ? "ambiguous-name" : `name-match:${hits[0].via}`, candidatePersonIds: hits.map(h => personIdFor("diner", h.c.id)), ...base });
      candidates.push({ tokoProfileId: p.id, tokoName: p.name, dinerCandidates: hits.map(h => ({ dinerCustomerId: h.c.id, dinerName: h.c.customerName, via: h.via })), ambiguous: hits.length > 1 });
    }
  }
  const report = summarizePlan({ dinerCustomers, tokoProfiles }, { persons, characters, sourceLinks, candidates });
  report.tokoOnlyPersons = tokoOnly;
  return { batchId, persons, characters, sourceLinks, candidates, report };
}

export function summarizePlan(inputs, plan) {
  const st = s => plan.sourceLinks.filter(l => l.linkStatus === s).length;
  return {
    sourceCount: { dinerCustomers: inputs.dinerCustomers.length, tokoProfiles: inputs.tokoProfiles.length },
    personProposedCount: plan.persons.length,
    characterProposedCount: plan.characters.length,
    sourceLinkCount: plan.sourceLinks.length,
    confirmedLinks: st("confirmed"), candidateLinks: st("candidate"), unresolvedLinks: st("unresolved"),
    candidateGroups: plan.candidates.length,
    ambiguousCandidates: plan.candidates.filter(c => c.ambiguous).length,
    oldNoteMigrated: { fromDiner: plan.persons.filter(p => p.origin === "diner" && p.customerNote).length, fromToko: 0 }
  };
}

/** 計画の不変条件検査。違反メッセージ配列を返す(空=合格)。 */
export function verifyPlan(inputs, plan) {
  const errs = [];
  const uniq = (arr, f, label) => { const s = new Set(); for (const x of arr) { const k = f(x); if (s.has(k)) errs.push(`${label}重複: ${k}`); s.add(k); } };
  uniq(plan.persons, x => x.id, "Person"); uniq(plan.characters, x => x.id, "Character"); uniq(plan.sourceLinks, x => x.id, "SourceLink");
  uniq(plan.sourceLinks, x => `${x.sourceSystem}|${x.sourceType}|${x.sourceId}`, "SourceLinkキー");
  const pids = new Set(plan.persons.map(p => p.id));
  const cids = new Set(plan.characters.map(c => c.id));
  for (const l of plan.sourceLinks) {
    if (!pids.has(l.personId)) errs.push(`孤立SourceLink(person): ${l.id}`);
    if (l.characterId && !cids.has(l.characterId)) errs.push(`孤立SourceLink(character): ${l.id}`);
  }
  for (const c of plan.characters) if (!pids.has(c.personId)) errs.push(`孤立Character: ${c.id}`);
  const dinerLinked = new Set(plan.sourceLinks.filter(l => l.sourceSystem === "diner").map(l => l.sourceId));
  for (const c of inputs.dinerCustomers) if (!dinerLinked.has(c.id)) errs.push(`ダイナー顧客が未リンク: ${c.id}`);
  const tokoLinked = new Set(plan.sourceLinks.filter(l => l.sourceSystem === "toko").map(l => l.sourceId));
  for (const p of inputs.tokoProfiles) if (!tokoLinked.has(p.id)) errs.push(`常若亭プロフィールが未リンク: ${p.id}`);
  for (const p of plan.persons) if (p.origin === "toko" && (p.customerNote || p.xDmUrl)) errs.push(`常若亭由来Personに備考/DMが入っている: ${p.id}`);
  // 候補は自動確定していないこと
  for (const l of plan.sourceLinks) if (l.basis?.startsWith("name-match") || l.basis === "ambiguous-name") { if (l.linkStatus !== "candidate") errs.push(`名前一致が確定扱い: ${l.id}`); }
  return errs;
}

/** 来店レコードのVer関連スナップショット(移行前後比較用)。計画はvisitsに触れない。 */
export function verSnapshot(dinerVisits) {
  const m = {};
  for (const v of dinerVisits) m[v.id] = { verCounted: !!v.verCounted, verCountExclusion: v.verCountExclusion ?? "", verCountOverride: v.verCountOverride ?? "" };
  return m;
}
export const verSnapshotHash = snap => hash(stable(snap));
