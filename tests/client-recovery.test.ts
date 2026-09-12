import test from 'node:test';import {webcrypto} from 'node:crypto';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import path from 'node:path';
const read=(name:string)=>readFileSync(path.join(__dirname,'../public',name),'utf8');const source=read('app.js');
const deferred=()=>{let resolve!:(v:any)=>void,reject!:(e:any)=>void;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {resolve,reject,promise};};
function harness(){
  const nodes=new Map<string,any>();function node(id:string):any{if(!nodes.has(id))nodes.set(id,{textContent:'',hidden:false,disabled:false,value:'',children:[],classList:{remove(){},toggle(){}},querySelector:(q:string)=>node(id+q),replaceChildren(...children:any[]){this.children=children;},append(...children:any[]){this.children.push(...children);}});return nodes.get(id);}
  const S:any={epoch:1,authRevision:1,contextSequence:0,user:{id:'a',admin:true},csrf:'csrf',connected:true,project:{id:'p'},projects:[{id:'p'}],thread:{id:'t',title:'T'},threads:[],items:new Map(),turns:[],pending:new Map(),nodes:new Map(),historyState:'none',historyError:'',cacheError:'',capabilities:{},status:'idle'};
  let streams=0;const c:any={S,TextEncoder,TextDecoder,crypto:webcrypto,Buffer,URL,Map,Set,Promise,Math,document:{hidden:false},$ :node,setTimeout:()=>1,clearTimeout(){},notice(){},renderThreads(){},renderTimeline(){},renderApprovals(){},applyThreadSettings(){},rememberSelectedTask(){},loadModels:async()=>{},closeStream(){},openStream(){streams++;},apiProject:(route:string)=>route,api:async()=>({items:[{id:'i',type:'agentMessage',text:'saved',turnId:'turn'}],turns:[],pending:[],status:'idle',cursor:'c',connection:{connected:true}}),controls(){node('send').disabled=S.historyState!=='ready';c.CodexRecovery?.render();},el:(_tag:string,text:string)=>({textContent:text}),CodexQueue:{reset(){},show(){}},CodexUsage:{metrics(){}},CodexFeatures:{reset(){},resetTimeline(){}}};
  c.clearConversation=()=>{c.CodexRecovery.reset();S.epoch++;S.thread=null;S.items=new Map();S.turns=[];S.pending.clear();S.nodes.clear();S.syncing=null;};
  vm.createContext(c);vm.runInContext(read('history.js'),c);c.CodexHistory=c.CodexHistoryCore.create({storage:c.CodexHistoryCore.memoryStore()});vm.runInContext(read('recovery.js'),c);vm.runInContext(source.slice(source.indexOf('async function selectThread('),source.indexOf('function openStream(')),c);
  return {c,S,node,streams:()=>streams};
}
test('history success, refresh failure retains body; cache restores after same-account login; retry recovers controls',async()=>{
  const {c,S,node}=harness();await c.CodexHistory.init(S.user);await c.syncSnapshot();await c.CodexRecovery.cacheCurrent();assert.equal(S.historyState,'ready');
  c.api=async()=>{throw Error('offline');};await assert.rejects(c.syncSnapshot());assert.equal(S.items.get('i').text,'saved');assert.equal(S.historyState,'cached');assert.equal(node('send').disabled,true);assert.match(node('history-message').textContent,/尚未同步/);
  c.clearConversation();S.thread={id:'t'};c.CodexHistory.reset();await c.CodexHistory.init(S.user);await assert.rejects(c.syncSnapshot());assert.equal(S.items.get('i').text,'saved');assert.equal(S.pending.size,0);assert.equal(S.turnId,null);
  c.api=async()=>({items:[{id:'fresh',text:'new',type:'agentMessage'}],pending:[],turns:[],status:'idle'});await c.syncSnapshot();assert.equal(S.historyState,'ready');assert.equal(node('send').disabled,false);assert.ok(S.items.has('fresh'));assert.equal(node('history-status').hidden,true);
});
test('switching from A to failing B never shows A text as B or calls it an empty task',async()=>{
  const {c,S,node}=harness();await c.CodexHistory.init(S.user);await c.syncSnapshot();c.api=async()=>{throw Error('history failed');};await assert.rejects(c.selectThread({id:'b',title:'B'}));assert.equal(S.thread.id,'b');assert.equal(S.items.size,0);assert.equal(node('emptyh2').textContent,'暂未读取到记录');assert.equal(node('history-retry').hidden,false);
});
test('late A success/failure cannot overwrite selected B, and concurrent snapshots are single-flight',async()=>{
  for(const failed of [false,true]){const {c,S}=harness(),d=deferred();let count=0;c.api=()=>{count++;return d.promise;};const a=c.syncSnapshot(),again=c.syncSnapshot();await new Promise(r=>setTimeout(r,20));assert.equal(count,1);c.clearConversation();S.thread={id:'b'};S.historyState='ready';S.items.set('b',{id:'b',text:'B'});if(failed)d.reject(Error('old'));else d.resolve({items:[{id:'a',text:'A'}],pending:[]});await Promise.all([a,again]);assert.equal(S.thread.id,'b');assert.ok(S.items.has('b'));assert.equal(S.historyState,'ready');}
});
test('denied history removes already loaded cache and blocks delayed cache resurrection',async()=>{
  const {c,S}=harness();await c.CodexHistory.init(S.user);await c.syncSnapshot();await c.CodexRecovery.cacheCurrent();const d=deferred();c.CodexHistory.read=()=>d.promise;c.api=async()=>{throw Object.assign(Error('forbidden'),{status:403});};S.items.clear();const loading=c.syncSnapshot();d.resolve({version:1,savedAt:Date.now(),items:[{id:'secret',text:'secret'}],turns:[]});await assert.rejects(loading);await Promise.resolve();await Promise.resolve();assert.equal(S.items.size,0);assert.equal(S.historyState,'error');
});
test('failed model request does not reject an otherwise successful task selection',async()=>{const {c,S}=harness();c.loadModels=async()=>{throw Error('models down');};await c.selectThread({id:'b',title:'B'});assert.equal(S.historyState,'ready');assert.equal(S.thread.id,'b');});
test('disconnect always exposes retry for members and admins; only admins explicitly connect',async()=>{
  for(const admin of [false,true]){const {c,S,node}=harness();S.user.admin=admin;S.connected=false;const writes:string[]=[];c.api=async(url:string)=>{writes.push(url);};c.refreshContext=async()=>{};c.syncSnapshot=async()=>{};c.CodexRecovery.render();assert.equal(node('connection-recovery').hidden,false);assert.equal(node('connect').hidden,false);await c.CodexRecovery.retry();assert.deepEqual(writes,admin?['/api/codex/admin/connect']:[]);c.CodexRecovery.render();assert.equal(node('connect').hidden,false);assert.equal(node('connect').disabled,false);}
});
test('cache can never authorize task writes through api including stale approval dialogs',async()=>{
  const {c,S}=harness();S.historyState='cached';let writes=0;Object.assign(c,{AbortController,setTimeout:()=>1,clearTimeout(){},CodexPlatform:{request:async()=>{writes++;}}});vm.runInContext(source.slice(source.indexOf('async function api('),source.indexOf('const q =')),c);for(const suffix of ['messages','interrupt','approvals/a','queue/id'])await assert.rejects(c.api('/api/codex/threads/t/'+suffix,{}),/尚未同步/);assert.equal(writes,0);
});
test('context status updates connection button even if project request fails',async()=>{
  const {c,S,node}=harness();c.api=async(url:string)=>{if(url.endsWith('status'))return {connected:false};throw Error('projects offline');};vm.runInContext(source.slice(source.indexOf('async function refreshContext('),source.indexOf('async function chooseProject(')),c);await assert.rejects(c.refreshContext(),/projects offline/);assert.equal(S.connected,false);assert.equal(node('connect').hidden,false);assert.equal(node('connection-recovery').hidden,false);
});
test('late context response after account change is discarded',async()=>{const {c,S}=harness(),d=deferred();c.api=()=>d.promise;vm.runInContext(source.slice(source.indexOf('async function refreshContext('),source.indexOf('async function chooseProject(')),c);const p=c.refreshContext();S.user={id:'other'};d.resolve({connected:false});await p;assert.equal(S.connected,true);});


test('a late cached list cannot resurrect tasks after an authoritative empty list',async()=>{
 const {c,S}=harness(),d=deferred();c.CodexHistory.read=()=>d.promise;c.CodexHistory.write=async()=>{};c.api=async()=>({data:[],nextCursor:null});vm.runInContext(source.slice(source.indexOf('async function loadThreads('),source.indexOf('function renderThreads(')),c);
 await c.loadThreads();d.resolve({data:[{id:'old',title:'stale'}]});await Promise.resolve();await Promise.resolve();assert.equal(S.threads.length,0);
});
test('failed lists can restore same-scope titles without hiding retry or granting write access',async()=>{
 const {c,S,node}=harness();S.thread=null;c.CodexHistory.read=async()=>({data:[{id:'old',title:'saved title'}]});c.api=async()=>{throw Object.assign(Error('offline'),{status:503});};vm.runInContext(source.slice(source.indexOf('async function loadThreads('),source.indexOf('function renderThreads(')),c);
 await c.loadThreads();assert.equal(S.threads[0].title,'saved title');assert.equal(S.connected,false);assert.equal(node('connection-recovery').hidden,false);assert.equal(node('connect').hidden,false);
});
test('cache write failure does not turn successful history into request failure',async()=>{const {c,S,node}=harness();c.CodexHistory.write=async()=>{throw Error('storage unavailable');};await c.syncSnapshot();await c.CodexRecovery.cacheCurrent();assert.equal(S.historyState,'ready');assert.ok(S.items.size);assert.match(node('history-message').textContent,/本地记录未保存/);});

test('cached active turns do not animate or claim to be currently running',()=>{const c:any={};vm.runInNewContext(read('turns.js'),c);const rows=c.CodexTurns.group([{id:'i',type:'agentMessage',text:'partial',turnId:'t'}],{historyState:'cached',status:'notLoaded',turnId:'t',turns:[{id:'t',status:'inProgress',startedAt:1}]});assert.equal(rows[0].running,false);assert.match(rows[0].label,/记录时运行中/);});

test('selecting the already-restored task closes the mobile drawer and retries history',async()=>{const {c,S,node}=harness();let closed=false;node('sidebar').classList.remove=(name:string)=>{closed=name==='mobile-open';};await c.selectThread(S.thread);assert.equal(closed,true);assert.equal(S.historyState,'ready');});

test('oversized history keeps cached text labelled unsynchronized without marking the backend offline',async()=>{
 const {c,S,node}=harness();await c.CodexHistory.init(S.user);await c.syncSnapshot();const before=S.connected;
 c.CodexRecovery.failed(Object.assign(Error('历史记录超过读取上限'),{status:413,code:'HISTORY_TOO_LARGE'}));
 assert.equal(S.connected,before);assert.equal(S.items.get('i').text,'saved');assert.equal(S.historyState,'cached');assert.match(node('history-message').textContent,/尚未同步.*读取上限/);assert.equal(node('send').disabled,true);
});
