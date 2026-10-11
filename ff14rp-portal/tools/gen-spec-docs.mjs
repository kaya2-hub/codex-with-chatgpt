#!/usr/bin/env node
// ChatGPT仕様書・サンプルJSONを docs/ へ書き出す(コードが正本。テストで最新性を検証)。
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { buildSpec } from "../core/exchange-spec.js"; import { sampleEvent, sampleCeremony } from "../core/samples.js";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "docs");
export const outputs = () => ({ "samples/event-sample.json": JSON.stringify(sampleEvent(), null, 2) + "\n", "samples/ceremony-sample.json": JSON.stringify(sampleCeremony(), null, 2) + "\n", "samples/chatgpt-spec-event.md": buildSpec("event") + "\n", "samples/chatgpt-spec-ceremony.md": buildSpec("ceremony") + "\n" });
if (process.argv[1] === fileURLToPath(import.meta.url)) for (const [f, t] of Object.entries(outputs())) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), t); console.log("wrote", f); }
