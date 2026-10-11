import { PRODUCTION_PROJECT_IDS } from "../core/collections.js";
/** ツール類が本番へ接続しないための共通ガード。demo-*+localhostエミュレータのみ許可。 */
export function assertDemoEmulator(projectId, env = process.env) {
  if (PRODUCTION_PROJECT_IDS.includes(projectId)) throw new Error(`本番プロジェクト(${projectId})への接続は、このツールでは禁止されています`);
  if (!/^demo-/.test(projectId || "")) throw new Error("projectIdは demo- で始まる必要があります");
  const host = env.FIRESTORE_EMULATOR_HOST || "";
  if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host)) throw new Error("FIRESTORE_EMULATOR_HOST がlocalhostではありません。エミュレータ経由でのみ実行できます");
  return host;
}
