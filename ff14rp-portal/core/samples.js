// ChatGPT仕様書に載せる記入例。完全に架空(実顧客・実在のDM/備考なし)。
export const sampleEvent = () => ({
  schema: "ff14rp.event", version: 1, op: "create",
  event: {
    name: "5周年記念式典(サンプル)", store: "diner", date: "2026-11-21", startTime: "22:00", endTime: "24:00頃", venue: "1F 店内 → 地下 式典会場(円卓)",
    overview: "1Fで祝賀パーティーを開いたのち、地下で記念式典を行う。",
    plan: "22:00 1Fパーティー開始 / 22:50 地下への移動案内 / 23:00 式典開始",
    staff: [{ id: "st-kaya", role: "かや", duty: "進行・案内アナウンス" }, { id: "st-toushin", role: "トーシン", duty: "先に地下で円卓待機(ひろげたろうに変更)" }],
    timeline: { version: 2, steps: [
      { id: "s-1", time: "22:00", phase: "1F祝賀パーティー", cue: [{ type: "condition", text: "1F祝賀パーティー開始" }], kaya: [{ type: "action", text: "入店対応、食事トレード" }, { type: "action", text: "歓談" }], toushin: [{ type: "action", text: "入店対応、食事トレード" }, { type: "action", text: "歓談" }], note: "" },
      { id: "s-2", time: "22:50", phase: "移動案内", cue: [{ type: "condition", text: "地下式典会場への移動案内アナウンス" }], kaya: [{ type: "say", text: "「23時より地下にて5周年記念式典を執り行います」的な(確定文言ではなく案)" }], toushin: [], note: "文言は案。確定したら差し替える" },
      { id: "s-3", time: "22:55頃", phase: "移動", cue: [{ type: "condition", text: "かやの案内でお客様が地下へ移動" }], kaya: [{ type: "action", text: "お客様を地下へ案内する" }], toushin: [{ type: "action", text: "ちょっとだけ先に地下へ移動" }, { type: "change", text: "ひろげたろうにキャラチェンジ(円卓で待機)" }], note: "" },
      { id: "s-4", time: "23時になったら", phase: "余興", cue: [{ type: "intent", text: "かやが無茶振りして走り去り、トーシンが場をつなぐ" }],
        kaya: [{ type: "say", text: "「今お客さんが近くに来てるっぽいんだけど、場所が分からないみたいなのでちょっと迎えに行ってきます！」" }, { type: "say", text: "「店長なんか面白い話しといて！」" }, { type: "action", text: "走り去り、ログアウトしてメスラへキャラチェンジ" }, { type: "change", text: "メスラへキャラチェンジ" }],
        toushin: [{ type: "say", text: "「面白い話…！？」" }, { type: "action", text: "無茶振りに応えようとしているように振る舞う" }, { type: "action", text: "桜や春の怪談めいた話題で場をつなぐ" }], note: "" }
    ] },
    macros: [{ id: "m-1", title: "移動案内(かや)", role: "かや", body: "/yell 23時より地下にて5周年記念式典を執り行います <t>\n/wait 3\n/s ご案内します、こちらへどうぞ♪", note: "" }],
    prep: ["地下の円卓の席札を並べる"], cautions: ["ログアウト前に必ず荷物を確認"], materials: [{ id: "mt-1", label: "チラシ", url: "https://example.com/flyer", note: "" }], retrospective: ""
  }
});
export const sampleCeremony = () => ({
  schema: "ff14rp.ceremony", version: 1, op: "create", target: { personId: "person-diner-cus_demo", stampValue: 7 },
  ceremony: {
    characterName: "テスト 太郎", content: "7スタンプ達成のお祝い。ダーツの結果に応じてGGコールまたは魔物ショーへ。",
    thanks: "いつも通ってくださってありがとうございます(個別コメントの下書き)",
    staff: [{ id: "st-kaya", role: "かや", duty: "ダーツ進行・コール" }, { id: "st-toushin", role: "トーシン", duty: "BGM・演出" }],
    timeline: { version: 2, steps: [{ id: "s-1", time: "セレモニー開始", phase: "導入", cue: [{ type: "condition", text: "お客様の会計が終わったら" }], kaya: [{ type: "say", text: "「本日のスペシャルゲストをご紹介します！」" }], toushin: [{ type: "action", text: "BGMを切り替える" }], note: "" }] },
    macros: [{ id: "m-1", title: "導入コール(かや)", role: "かや", body: "/yell 本日の主役は <t> さん！\n/wait 2\n/s おめでとうございます♡", note: "" }],
    prep: ["ダーツを用意"], postNote: ""
  }
});
