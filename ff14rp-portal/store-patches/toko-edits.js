// 常若亭保存版 v1.3.0 (app.js) への「共通マスター連携」差分。切替フラグがmasterでなければ全て従来動作。
export const TOKO_EXPECTED_SHA256 = "f506f26d127a358d82d7817bfabe6fb98f49ac8a4b14548e831b826079e9180c";
export const TOKO_FILE = "app.js";
const IMP = 'import { getFirestore, collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc, writeBatch, onSnapshot, query, where, serverTimestamp } from';
export const tokoEdits = [
  { name: "import: runTransaction", find: IMP, replace: IMP.replace("serverTimestamp }", "serverTimestamp, runTransaction }") },
  { name: "ブリッジ初期化関数", find: "let app, auth, db;",
    replace: `let app, auth, db, TB=null;
function tbOn(){return!!(TB&&TB.active)}
function tbOverlay(p){return tbOn()?TB.overlayProfile(p):p}
async function initMasterBridge(){try{const [{masterFirebaseConfig},m]=await Promise.all([import("./master-config.js"),import("./bridge/bridge.js")]);const mApp=initializeApp(masterFirebaseConfig,"master"),mAuth=getAuth(mApp);await signInAnonymously(mAuth);const mDb=getFirestore(mApp);TB=await m.createBridge({db:mDb,sdk:{doc,getDoc,getDocs,collection,onSnapshot,runTransaction},system:"toko",label:"常若亭画面"});if(tbOn())TB.subscribe(()=>render())}catch(e){console.warn("共通マスター連携を読み込めないため従来動作で続行",e);TB=null}}` },
  { name: "ログイン後にブリッジ初期化", find: "try{await seed();await seedCustomerHistory();", replace: "try{await initMasterBridge();await seed();await seedCustomerHistory();" },
  { name: "プロフィールに共通備考を重ねる", find: "function directoryData(){return state.profiles.map(profile=>{", replace: "function directoryData(){return state.profiles.map(profile0=>{const profile=tbOverlay(profile0);" },
  { name: "備考欄の表示(旧備考は参照のみ)", find: '<section class="profile-notes"><h4>備考</h4><textarea data-profile-notes',
    replace: '<section class="profile-notes"><h4>備考${profile._master?" <small>(共通顧客マスター)</small>":(tbOn()?" <small>(照合未確認: 共通備考には未接続)</small>":"")}</h4>${profile._master&&profile.legacyNotes?`<details><summary>切替前の旧備考(参照のみ・自動では取り込みません)</summary><pre style="white-space:pre-wrap">${esc(profile.legacyNotes)}</pre></details>`:""}<textarea data-profile-notes' },
  { name: "備考保存を共通マスターへ", find: 'await setDoc(doc(db,"customerProfiles",profileId),{notes,updatedAt:serverTimestamp()},{merge:true});toast(',
    replace: 'if(tbOn()&&TB.linked(profileId)){await TB.persistNote(profileId,notes);render()}else{await setDoc(doc(db,"customerProfiles",profileId),{notes,updatedAt:serverTimestamp()},{merge:true})}toast(' }
];
