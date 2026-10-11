// ChatGPTへ渡す共通仕様書(コピー用テキスト)の生成。外部APIは使わない(利用者が普段のChatGPTに貼り付ける)。
import { SCHEMAS, SCHEMA_VERSION } from "./exchange.js";
import { ITEM_TYPES, TYPE_JA } from "./timeline.js";
import { ROLES } from "./roles.js";
import { sampleEvent, sampleCeremony } from "./samples.js";

const fence = (t, lang = "") => "```" + lang + "\n" + t + "\n```";
const rolesTxt = ROLES.map(r => `- ${r.ja}(内部ID: ${r.id})`).join("\n");
const typesTxt = ITEM_TYPES.map(t => `- "${t}" = ${TYPE_JA[t]}`).join("\n");

const COMMON = `# 役割
あなたは「FF14 RP店舗の総合DB」へ取り込むための“構造化データ”を、利用者(かやさん・トーシンさん)と相談しながら作るアシスタントです。
企画の相談は普段どおり自由な文章で構いません。最終的に、このあと説明する形式のJSONに整理して渡してください。

# 会話のルール
1. 企画の途中は、普段どおり会話してください。JSONは出さなくて構いません。
2. 重要な点(日付・時刻・担当・セリフ・順序)が曖昧なときは、推測せず利用者へ質問してください。
3. 利用者が「これでOK」「書き出して」などと言うまでは、完成データを出力しないでください。
4. 未定の事項は、無理に決めず null または空にして構いません(下書きとして取り込めます)。勝手に補完・創作しないでください。
5. 出力するときは、JSON以外の説明文をJSONの中に混ぜないでください。

# 出力のルール
- ファイルを作成できる環境では、拡張子 .json のファイルとして出力してください(文字コードはUTF-8)。
- ファイルを作成できない環境では、コピーしやすいように\`\`\`json で囲んだJSON本文を1つだけ出力してください。
- JSONは厳密な形式(コメント・末尾カンマ・省略記号なし)にしてください。
- セリフ・マクロの原文は、要約・言い換え・補正をせず、利用者が書いたとおりに入れてください。改行は \\n で表します。
- 担当者は次のどちらかで指定してください(日本語でも内部IDでも可)。
${rolesTxt}

# タイムライン(timeline.steps)の作り方
- 画面は「かや | タイミング・合図・共通条件 | トーシン」の3列です。1つの時刻(ステップ)に、複数の行動やセリフを入れられます。
- time: 時刻の原文表現をそのまま入れます。例「22:00」「22:55頃」「23時になったら」。時刻が不明なら空文字 ""。時刻を推測で作らないでください。
- cue: 共通の合図・進行条件・演出意図(中央の列)。kaya / toushin: それぞれの担当の行動とセリフ(左・右の列)。
- 列の中の1項目は {"type": 種別, "text": 原文} です。複数行の文章は text の中で \\n を使います。種別:
${typesTxt}
- セリフ(say)は原文のまま。行動(action)・キャラチェンジ(change)・進行条件(condition)・演出意図(intent)を区別して書いてください。どれか判断できない文章は "text"(未分類)にしてください。
- 掛け合いは、時系列に沿ってステップを分け、かや・トーシンの列に交互に入れてください。
- 「的な」「みたいな」など確定していない文言は、確定文言として扱わず、そのことが分かるように書いてください(textに注記、または note に記載)。
- phase は「1F祝賀パーティー」「移動案内」などの区切りの名前(任意)です。

# マクロ(macros)の作り方
- body にはFF14のマクロ原文をそのまま入れます(/yell /s /p /wait などのコマンド、改行、空白、記号、<t> などの特殊表記を変更しない)。
- 1つのマクロは15行以内が目安です。超える場合は分割を提案してください(勝手に削らない)。
- 原文が提示されていないマクロを、あなたが創作して作ってはいけません。必要なら利用者に質問し、無ければ登録しないでください。

# 更新(op が "update")のルール
- 利用者から「現在のデータ」(JSON)が渡されたときは、そのJSONを元に、依頼された変更だけを反映した完全なJSONを返してください。
- 既存の項目の "id" は絶対に変更しないでください。新しい項目は "id" を付けないか、新しい英数字のIDにしてください。削除する項目は配列から外してください。
- "_base" は触らずそのまま残してください(二人が別々に編集した際の衝突検出に使われます)。変更しない項目も、元のまま残してください。
- 取り込み前に、利用者は総合DB上で変更差分を確認します。

# 絶対にしてはいけないこと
- "facts"(読み取り専用の情報)・来店回数・Verスタンプ・実施状況・開催状態(下書き/開催済みなど)を変更したり、JSONで指示したりしないこと。これらは総合DBが管理します。
- 個人的な備考・DMのURLなど、資料にない個人情報を作らない・書かないこと。
- 不確かな情報を事実として書かないこと。`;

const EVENT = `${COMMON}

# このデータの種類: イベント(${SCHEMAS.event}, version ${SCHEMA_VERSION})
新規登録は "op": "create"、既存の更新は "op": "update"(target.occurrenceId が必要)です。
必須: schema, version, event.name(新規のみ)。他の項目はすべて任意で、省略した項目は更新されません。

${fence(`{
  "schema": "${SCHEMAS.event}",  "version": ${SCHEMA_VERSION},  "op": "create" | "update",
  "target": { "occurrenceId": "更新時のみ" },
  "event": {
    "name": "イベント名(新規は必須)",
    "store": "diner" | "toko" | null,        // ダイナー / 常若亭 / 未定
    "date": "YYYY-MM-DD" | null,
    "startTime": "22:00", "endTime": "24:00頃",   // 自由な文字列
    "venue": "開催場所・会場", "overview": "概要", "plan": "企画内容",
    "staff":    [ { "id": "任意", "role": "かや" | "トーシン", "duty": "役割" } ],
    "timeline": { "version": 2, "steps": [ { "id": "任意", "time": "", "phase": "", "cue": [Item], "kaya": [Item], "toushin": [Item], "note": "" } ] },
    "macros":   [ { "id": "任意", "title": "", "role": "かや" | "トーシン", "body": "マクロ原文", "note": "" } ],
    "prep": ["準備事項"], "cautions": ["注意事項"],
    "materials": [ { "id": "任意", "label": "", "url": "https://…", "note": "" } ],
    "retrospective": "振り返り・反省点"
  }
}   // Item = { "type": "say|action|change|condition|intent|text", "text": "原文" }`, "")}

# 記入例(完全に架空)
${fence(JSON.stringify(sampleEvent(), null, 2), "json")}`;

const CEREMONY = `${COMMON}

# このデータの種類: セレモニー原稿(${SCHEMAS.ceremony}, version ${SCHEMA_VERSION})
対象は「お客様 × 達成スタンプ数(7スタンプごと)」です。target の personId と stampValue は総合DBが渡す値をそのまま使ってください。
新規は "op": "create"、既存の更新は "op": "update" です。
必須: schema, version, target(personId と stampValue)。他の項目はすべて任意で、省略した項目は更新されません(未定は空でよい)。
利用者から渡される "facts" は参照用です。あなたが数値を変えても取り込まれません。原稿の中で来店回数やスタンプ数に触れる場合は facts の値を使い、不明なら "不明" と扱って推測しないでください。
原稿を取り込んでも「実施済み」にはなりません(実施は総合DBで利用者が記録します)。GGコール等の完成マクロ本文が資料にない場合は、創作せず利用者に質問してください。

${fence(`{
  "schema": "${SCHEMAS.ceremony}",  "version": ${SCHEMA_VERSION},  "op": "create" | "update",
  "target": { "personId": "総合DBが渡した値", "stampValue": 7 },
  "ceremony": {
    "characterName": "当日使う呼称", "content": "今回のセレモニー内容", "thanks": "個別の感謝コメント",
    "staff":    [ { "id": "任意", "role": "かや" | "トーシン", "duty": "役割" } ],
    "timeline": { "version": 2, "steps": [ { "id": "任意", "time": "", "phase": "", "cue": [Item], "kaya": [Item], "toushin": [Item], "note": "" } ] },
    "macros":   [ { "id": "任意", "title": "", "role": "かや" | "トーシン", "body": "マクロ原文", "note": "" } ],
    "prep": ["当日の準備事項"], "postNote": "実施後メモ"
  }
}   // Item = { "type": "say|action|change|condition|intent|text", "text": "原文" }`, "")}

# 記入例(完全に架空)
${fence(JSON.stringify(sampleCeremony(), null, 2), "json")}`;

export const buildSpec = kind => (kind === "event" ? EVENT : CEREMONY);
/** 既存データを再編集するときの貼り付け用テキスト(仕様書+現在のデータ+依頼文)。 */
export function buildEditPackage(kind, exported, extra = "") {
  return `${buildSpec(kind)}\n\n# 現在のデータ(これを元に修正してください)\n${fence(JSON.stringify(exported, null, 2), "json")}\n${extra ? `\n${extra}\n` : ""}\n# 依頼\nこのデータを元に、これから私が伝える変更だけを反映してください。変更が決まったら「書き出して」と伝えます。それまでは普段どおり会話してください。`;
}
