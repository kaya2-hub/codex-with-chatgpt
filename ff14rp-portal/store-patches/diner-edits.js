// ダイナー保存版 v1.15.0 (index.html) への「共通マスター連携」差分。切替フラグがmasterでなければ全て従来動作。
export const DINER_EXPECTED_SHA256 = "75001017252be956e7c530c9fd8fc28045fd844e82cb4419b028c4730098b766";
export const DINER_FILE = "index.html";
const IMPORT_OLD = 'import { getFirestore, collection, doc, getDocs, setDoc, writeBatch, onSnapshot, query, where } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";';
export const dinerEdits = [
  { name: "import: getDoc/runTransaction", find: IMPORT_OLD, replace: IMPORT_OLD.replace("doc, getDocs,", "doc, getDoc, getDocs,").replace("where }", "where, runTransaction }") },
  { name: "bridge初期化関数と補助", find: "    async function initializeCloud(){",
    replace: `    var MB=null;function mbOn(){return!!(MB&&MB.active)}function mbOverlay(c){return mbOn()?MB.overlay(c):c}
    async function initMasterBridge(){try{var m=await import("./bridge/bridge.js");MB=await m.createBridge({db:db,sdk:{doc:doc,getDoc:getDoc,getDocs:getDocs,collection:collection,onSnapshot:onSnapshot,runTransaction:runTransaction},system:"diner",label:"ダイナー画面"})}catch(e){console.warn("共通マスター連携を読み込めないため従来動作で続行",e);MB=null}}
    async function initializeCloud(){` },
  { name: "ログイン後にブリッジ初期化", find: "try{await seedMenu();listenCloud()}", replace: "try{await initMasterBridge();await seedMenu();listenCloud()}" },
  { name: "顧客スナップショットに共通値を重ねる", find: "state.customers=snap.docs.map(function(d){return customerNorm(Object.assign({},d.data(),{customerId:d.id}))}).filter(",
    replace: "state.customers=snap.docs.map(function(d){return mbOverlay(customerNorm(Object.assign({},d.data(),{customerId:d.id})))}).filter(" },
  { name: "共通側の更新を購読", find: "function listenCloud(){var loaded={customers:false,visits:false,menu:false};",
    replace: "function listenCloud(){var loaded={customers:false,visits:false,menu:false};if(mbOn())MB.subscribe(function(){state.customers.forEach(mbOverlay);refreshSelectedFromCloud();renderAll()});" },
  { name: "店舗側の備考/DMフィールドを書かない(凍結)", find: "function customerPayload(c){return{customerName:c.customerName,previousNames:aliasList(c.previousNames||[]),xDmUrl:c.xDmUrl,customerNote:c.customerNote,createdAt:c.createdAt,updatedAt:c.updatedAt}}",
    replace: "function customerPayload(c){var p={customerName:c.customerName,previousNames:aliasList(c.previousNames||[]),xDmUrl:c.xDmUrl,customerNote:c.customerNote,createdAt:c.createdAt,updatedAt:c.updatedAt};if(mbOn()){delete p.xDmUrl;delete p.customerNote}return p}" },
  { name: "顧客保存前に共通Personへ保存", find: "async function saveCustomerCloud(c){state.storage.saving=true;renderDataStatus();try{await setDoc(",
    replace: "async function saveCustomerCloud(c){state.storage.saving=true;renderDataStatus();try{if(mbOn())await MB.persistInfo(c);await setDoc(" },
  { name: "来店保存前に共通Personへ保存", find: "async function saveVisitCloud(customer,visit){state.storage.saving=true;renderDataStatus();try{var batch=writeBatch(db);",
    replace: "async function saveVisitCloud(customer,visit){state.storage.saving=true;renderDataStatus();try{if(mbOn())await MB.persistInfo(customer);var batch=writeBatch(db);" },
  { name: "一括取込前に共通Personへ保存(空で消さない)", find: "records=built.records,cloudBatch=writeBatch(db);Object.keys(customersById)",
    replace: "records=built.records,cloudBatch=writeBatch(db);if(mbOn())await MB.persistInfoMany(Object.keys(customersById).map(function(id){return customersById[id]}));Object.keys(customersById)" },
  { name: "過去Ver判定をDM有無で書き換えない", find: "async function reconcileNoXVerCounts(quiet){if(!state.storage.ready||state.noXRepairRunning)return 0;",
    replace: "async function reconcileNoXVerCounts(quiet){if(mbOn())return 0;if(!state.storage.ready||state.noXRepairRunning)return 0;" },
  { name: "過去Ver判定を現在のDM有無で再計算しない", find: "return!!v.verCounted&&(!customer||validUrl(customer.xDmUrl))}",
    replace: "return!!v.verCounted&&(mbOn()||!customer||validUrl(customer.xDmUrl))}" },
  { name: "連携中は名前一致での既存顧客への統合を止める", find: "async function applyCustomerNameChange(plan,url,note){",
    replace: 'async function applyCustomerNameChange(plan,url,note){if(mbOn()&&plan.merges){toast("共通顧客マスター連携中は、既存のお客様への統合は総合DBの『人物の統合』で行ってね",6500);return null}' },
  { name: "削除警告文(共通側は残る)", find: "お客様情報・DMリンク・備考も削除されるよ。",
    replace: '"+(mbOn()?"このお店のお客様情報は削除されるけど、共通顧客マスターの備考・DMリンクは残るよ。":"お客様情報・DMリンク・備考も削除されるよ。")+"' }
];
