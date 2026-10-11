// 隔離テスト用: 店舗アプリのFirebase SDK呼び出しを「demoプロジェクト+Firestoreエミュレータ」へ強制的に向ける。
// 本番プロジェクトIDは demo-* へ読み替え、認証はスタブ。これにより本番へは一切接続しない。
import * as appMod from "firebase/app";
import * as fs from "firebase/firestore";
export * from "firebase/firestore";
const MAP = { "pixies-diner": "demo-iso", "tokowakatei-receipt": "demo-toko" };
export const initializeApp = (cfg, name) => appMod.initializeApp({ projectId: MAP[cfg.projectId] || `demo-${String(cfg.projectId || "x").toLowerCase()}`, apiKey: "fake", appId: "fake" }, name);
export const getFirestore = a => { const db = fs.getFirestore(a); if (!db.__emu) { fs.connectFirestoreEmulator(db, "127.0.0.1", Number(window.__EMU_PORT)); db.__emu = true; } return db; };
export const getAuth = () => ({ fake: true });
export const signInAnonymously = async () => ({ user: { uid: "isolated-test" } });
export const onAuthStateChanged = (auth, cb) => { setTimeout(() => cb({ uid: "isolated-test" }), 0); return () => {}; };
