// Notion(Markdownエクスポート/コピー)やテキストの貼り付けから、FF14マクロ候補を取り出す。
// - 本文は原文のまま(行頭・行末の空行以外は一切加工しない)。コードフェンス内は完全にそのまま。
// - フェンスが無い節は、「/」で始まる行(FF14コマンド)が主体のときだけマクロ候補にする。文章は取り込まず「対象外」に列挙。
// - 役割(Kaya/Toushin)は見出しに名前があるときだけ推定。無ければ未設定(人が選ぶ)。何も補完・創作しない。
const HEAD = /^(#{1,6})\s+(.*)$/;
const roleOf = t => /kaya|カヤ/i.test(t) ? "Kaya" : /toushin|トウシン/i.test(t) ? "Toushin" : "";
const trimBlank = lines => { let a = 0, b = lines.length; while (a < b && !lines[a].trim()) a++; while (b > a && !lines[b - 1].trim()) b--; return lines.slice(a, b); };

export function parseMacroPaste(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const blocks = [], skipped = []; let title = "", role = "", buf = [], inFence = false, fence = [], n = 0;
  const flush = () => {
    const body = trimBlank(buf); buf = [];
    if (!body.length) return;
    const cmd = body.filter(l => l.trim()).filter(l => /^\//.test(l.trim())).length, all = body.filter(l => l.trim()).length;
    if (all && cmd / all >= 0.6) blocks.push({ title: title || `マクロ${++n}`, role, body: body.join("\n"), source: "section" });
    else skipped.push({ title: title || "(見出しなし)", reason: "FF14コマンド(/で始まる行)が主体ではない文章のため取り込み対象外", lines: all });
  };
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (!inFence) { flush(); inFence = true; fence = []; }
      else { inFence = false; const body = trimBlank(fence); if (body.length) blocks.push({ title: title || `マクロ${++n}`, role, body: body.join("\n"), source: "fence" }); }
      continue;
    }
    if (inFence) { fence.push(line); continue; }
    const m = line.match(HEAD);
    if (m) { flush(); title = m[2].trim(); role = roleOf(title) || role; continue; }
    buf.push(line);
  }
  if (inFence && fence.length) skipped.push({ title, reason: "コードフェンスが閉じていないため取り込まず(貼り付け範囲を確認)", lines: fence.length });
  flush();
  return { blocks, skipped };
}
