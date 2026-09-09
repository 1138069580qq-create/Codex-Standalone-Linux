import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
const stateSource = fs.readFileSync(path.join(__dirname,'../public/state.js'),'utf8');
const source = fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
function setup() {
  const elements:any = new Proxy({}, {get(target:any,key:any){return target[key] ||= {value:'',textContent:'',hidden:false,disabled:false,focus:()=>{},prepend:()=>{},querySelector:()=>({disabled:false})};}});
  elements.access.value='default';elements.prompt.value='hello';elements.model.value='test-model';elements.effort.value='low';elements.mode.value='code';
  const S:any={user:{admin:true},connected:true,project:{id:'demo'},thread:null,threads:[],status:'idle',sending:false,epoch:1,attachments:[],selected:[],references:[],goalDraft:'',accessConfirmed:false,attempt:null};
  const calls:any[]=[]; const notices:string[]=[]; let cleared=0;const storage=new Map<string,string>();
  const c:any={module:{exports:{}},crypto:{getRandomValues:webcrypto.getRandomValues.bind(webcrypto)},Uint8Array,document:{},sessionStorage:{getItem:(k:string)=>storage.get(k)||null,setItem:(k:string,v:string)=>storage.set(k,v),removeItem:(k:string)=>storage.delete(k)},setTimeout:()=>1,clearTimeout:()=>{},confirmAction:async()=>true,el:()=>({}),loadEfforts:()=>{},S,$:(id:string)=>elements[id],permission:()=>true,stateName:(v:string)=>v,closeStream:()=>{},renderThreads:()=>{},renderAttachments:()=>{},renderSettingsSource:()=>{},notice:(v='')=>notices.push(v),clearConversation:()=>{cleared++;S.epoch++;S.thread=null;elements.prompt.value='';},syncSnapshot:async()=>{},loadModels:async()=>{},api:async(url:string,body:any)=>{calls.push({url,body});return url.endsWith('/threads')?{id:'real-created',title:'hello',status:'idle'}:{ok:true};}};
  vm.runInNewContext(stateSource,c);c.CodexState=c.module.exports;
  for(const [a,b] of [['function supports(','async function signedIn('],['async function sendMessage()','function renderAttachments()'],['async function selectThread(','async function syncSnapshot()'],['async function loadQuota()','function renderQuota('],['async function loadCatalog(','async function openMenu(']])vm.runInNewContext(source.slice(source.indexOf(a),source.indexOf(b)),c);
  return {c,S,elements,calls,notices,get cleared(){return cleared;}};
}
test('HTTP has getRandomValues but no randomUUID: empty Demo accepts and creates a task on first send',async()=>{
  const {c,S,elements,calls}=setup();c.controls();assert.equal(elements.prompt.disabled,false);assert.equal(elements.send.disabled,false);
  await c.sendMessage();assert.equal(S.sending,false);assert.equal(calls.length,2);assert.equal(S.thread.id,'real-created');
  assert.equal(calls[0].url,'/api/codex/threads');assert.match(calls[0].body.requestId,/^[a-f0-9-]{36}$/);
  assert.match(calls[1].url,/real-created\/messages$/);assert.equal(calls[1].body.text,'hello');assert.equal(elements.prompt.value,'');
});
test('request-ID generation failure cannot leave the composer/settings/project selector locked',async()=>{
  const {c,S,elements,calls}=setup();c.CodexState.requestId=()=>{throw new Error('crypto unavailable');};
  await assert.rejects(c.sendMessage(),/crypto unavailable/);assert.equal(S.sending,false);assert.equal(calls.length,0);
  for(const id of ['prompt','send','settings','project-select','new-thread'])assert.equal(elements[id].disabled,false,id);
  assert.equal(elements.prompt.value,'hello');
});
test('failed send retains the draft and idempotency key, unlocking the page for retry',async()=>{
  const {c,S,elements,calls}=setup();const api=c.api;let failed=false;
  c.api=async(url:string,body:any)=>{const result=await api(url,body);if(url.endsWith('/messages')&&!failed){failed=true;throw new Error('network');}return result;};
  await assert.rejects(c.sendMessage(),/network/);assert.equal(S.sending,false);assert.equal(elements.prompt.value,'hello');
  const id=S.attempt.requestId;await c.sendMessage();assert.equal(calls.filter((v:any)=>v.url==='/api/codex/threads').length,1);
  assert.equal(calls[2].body.requestId,id);assert.equal(S.sending,false);
});

function attached() {
  const state=setup();
  state.S.attachedThreadId='desktop-task';
  state.S.capabilities={createThread:false,extensions:false,mcp:false,quota:false,setGoal:false,configureTransport:false};
  state.S.threads=[{id:'desktop-task',title:'Current desktop task',status:'idle'}];
  return state;
}
test('desktop mode hides new-task and disables APIs the bridge does not support',()=>{
  const {c,S,elements}=attached();c.controls();
  assert.equal(elements['new-thread'].hidden,true);assert.equal(elements['new-thread'].disabled,true);
  assert.equal(elements['sidebar-plugins'].disabled,true);assert.equal(elements['refresh-quota'].hidden,false);
  assert.equal(elements.settings.hidden,true);assert.equal(elements.send.disabled,false);
  for(const id of ['new','skills','plugins','mcp','goal'])assert.equal(c.commandAvailable({id}),false,id);
  for(const id of ['upload','references','plan','model','permissions','status'])assert.equal(c.commandAvailable({id}),true,id);
  S.capabilities={createThread:true};assert.equal(c.supports('createThread'),false,'attached ID must override stale capability flags');
});
test('desktop mode restores a lost task selection and never calls create on send',async()=>{
  const {c,S,elements,calls}=attached();
  await c.sendMessage();
  assert.equal(S.thread.id,'desktop-task');assert.equal(calls.length,1);
  assert.equal(calls[0].url,'/api/codex/threads/desktop-task/messages');
  assert.equal(calls[0].body.text,'hello');assert.equal(elements.prompt.value,'');assert.equal(S.sending,false);
});
test('desktop new-task entry cannot clear the pinned task, draft or attachment context',async()=>{
  const state=attached();const {c,S,elements,calls}=state;
  S.attachments=['upload.txt'];S.references=['README.md'];S.accessConfirmed=true;
  elements.access.value='full';
  await c.startNewConversation();
  assert.equal(state.cleared,0);assert.equal(S.thread.id,'desktop-task');assert.equal(elements.prompt.value,'hello');
  assert.deepEqual(S.attachments,['upload.txt']);assert.deepEqual(S.references,['README.md']);
  assert.equal(S.accessConfirmed,true);assert.equal(elements.access.value,'full');assert.equal(calls.length,0);
});
test('desktop reselect preserves draft; a different task is rejected before clearing',async()=>{
  const state=attached();const {c,S,elements}=state;
  await c.selectThread(S.threads[0]);await c.selectThread(S.threads[0]);
  assert.equal(state.cleared,0);assert.equal(elements.prompt.value,'hello');
  await assert.rejects(c.selectThread({id:'unrelated'}),/仅支持桌面当前任务/);
  assert.equal(elements.prompt.value,'hello');assert.equal(S.thread.id,'desktop-task');
});
test('desktop missing task or a busy snapshot keeps the draft without creating or sending',async()=>{
  const {c,S,elements,calls}=attached();S.threads=[];
  await assert.rejects(c.sendMessage(),/当前桌面任务未加载/);
  assert.equal(elements.prompt.value,'hello');assert.equal(S.sending,false);assert.equal(calls.length,0);
  S.threads=[{id:'desktop-task',title:'Pinned',status:'idle'}];c.syncSnapshot=async()=>{S.status='running';};
  await assert.rejects(c.sendMessage(),/任务仍在运行/);
  assert.equal(elements.prompt.value,'hello');assert.equal(S.sending,false);assert.equal(calls.length,0);
});
test('desktop failed send retains its draft and request ID for a user-driven retry',async()=>{
  const {c,S,elements,calls}=attached();const api=c.api;let failed=false;
  c.api=async(url:string,body:any)=>{const result=await api(url,body);if(!failed){failed=true;throw new Error('403 provider policy');}return result;};
  await assert.rejects(c.sendMessage(),/403 provider policy/);
  assert.equal(calls.length,1,'must not auto-retry');assert.equal(elements.prompt.value,'hello');assert.equal(S.sending,false);
  const id=S.attempt.requestId;await c.sendMessage();
  assert.equal(calls.length,2);assert.equal(calls[1].body.requestId,id);
  assert.ok(calls.every(v=>v.url==='/api/codex/threads/desktop-task/messages'));
});
test('unsupported desktop quota and extension catalogs do not issue failing API calls',async()=>{
  const {c,S,elements,calls}=attached();let localStatisticsLoads=0;c.CodexUsage={load:async()=>{localStatisticsLoads++;}};await c.loadQuota();const catalog=await c.loadCatalog();
  assert.equal(calls.length,0);assert.equal(catalog.entries.length,0);
  assert.equal(S.catalogProject,'demo');assert.equal(localStatisticsLoads,1,'local usage stays available even without upstream quota support');
});
test('ordinary app-server mode retains new-task and extension commands',async()=>{
  const state=setup();const {c,S,elements}=state;S.thread={id:'old'};
  await c.startNewConversation();assert.equal(state.cleared,1);assert.equal(S.thread,null);
  c.controls();assert.equal(elements['new-thread'].hidden,false);
  for(const id of ['new','skills','plugins','mcp','goal'])assert.equal(c.commandAvailable({id}),true,id);
});

function managed(){const result=attached();result.S.capabilities.createWithMessage=true;result.S.capabilities.switchThreads=true;result.S.capabilities.firstMessageExtensions=false;result.S.project.canCreateTask=true;result.S.project.root='test-project';return result;}
test('managed desktop enables new task and enters an empty draft only after confirmation, without a write',async()=>{
  const state=managed();const {c,S,elements,calls}=state;c.controls();assert.equal(elements['new-thread'].hidden,false);assert.equal(elements['new-thread'].disabled,false);
  c.confirmAction=async()=>false;await c.startNewConversation();assert.equal(state.cleared,0);assert.equal(calls.length,0);
  c.confirmAction=async()=>true;await c.startNewConversation();assert.equal(state.cleared,1);assert.equal(S.newTask,true);assert.equal(S.thread,null);assert.equal(calls.length,0);
  c.controls();assert.equal(elements.send.disabled,false);assert.equal(elements.attach.disabled,true);assert.equal(elements.access.disabled,true);
});
test('managed desktop first send creates once and switches to returned task without a second messages request',async()=>{
  const {c,S,elements,calls}=managed();S.newTask=true;
  c.api=async(url:string,body:any)=>{calls.push({url,body});return {requestId:body.requestId,projectId:'demo',status:'ready',threadId:'created',messageAccepted:true,thread:{id:'created',title:'Created',status:'idle'}};};
  await c.sendMessage();assert.equal(calls.length,1);assert.equal(calls[0].url,'/api/codex/task-creations');assert.equal(calls[0].body.text,'hello');
  assert.equal(calls[0].body.confirmCurrentDirectory,true);assert.equal(S.thread.id,'created');assert.equal(S.newTask,false);assert.equal(elements.prompt.value,'');assert.equal(S.taskCreation,null);assert.equal(S.sending,false);
});
test('managed desktop unknown create locks only duplicate sending and read-only check recovers without replay',async()=>{
  const {c,S,elements,calls}=managed();S.newTask=true;
  c.api=async(url:string,body:any)=>{calls.push({url,body});if(body)throw new Error('network lost after submit');return {requestId:S.taskCreation.requestId,projectId:'demo',status:'ready',messageAccepted:true,thread:{id:'recovered',title:'Recovered',status:'idle'}};};
  await c.sendMessage();assert.equal(calls.length,1);assert.equal(elements.prompt.value,'hello');assert.equal(S.sending,false);assert.equal(elements.send.disabled,true);assert.equal(elements.settings.disabled,false);
  await c.sendMessage();assert.equal(calls.length,2);assert.equal(calls[1].body,undefined);assert.match(calls[1].url,/task-creations/);assert.equal(S.thread.id,'recovered');assert.equal(elements.prompt.value,'');
});
test('created task whose first message failed keeps draft and does not create again',async()=>{
  const {c,S,elements,calls}=managed();S.newTask=true;
  c.api=async(url:string,body:any)=>{calls.push({url,body});return {requestId:body.requestId,projectId:'demo',status:'ready',messageAccepted:false,thread:{id:'created',title:'Created',status:'idle'},message:'first message failed'};};
  await c.sendMessage();assert.equal(calls.length,1);assert.equal(S.newTask,false);assert.equal(S.thread.id,'created');assert.equal(elements.prompt.value,'hello');assert.equal(S.taskCreation,null);
});
test('managed desktop snapshot reconnect does not force a selected new task back to the anchor',async()=>{
  const {c,S}=managed();S.thread={id:'selected-new-task'};await c.restoreAttachedThread();assert.equal(S.thread.id,'selected-new-task');
});
test('native composer batch: all requested slash actions except pet, first-message skills, and projectless selection',async()=>{
  const {c,S,elements,calls}=managed();S.capabilities={...S.capabilities,taskActions:true,extensions:true,mcp:true,setGoal:true,firstMessageExtensions:true,projects:true,projectless:true};S.thread={id:'current',title:'Current'};
  for(const id of ['review','side','fork','compact','feedback','archive','new','status','goal','pin','plan','rename','skills','plugins','mcp'])assert.equal(c.commandAvailable({id}),true,id);
  assert.ok(!source.includes("id:'pet'"));S.newTask=true;S.newTaskConfirmed=true;S.selected=[{id:'a'.repeat(32)}];S.project.kind='projectless';S.project.id='projectless';c.controls();assert.equal(elements.attach.disabled,false);assert.equal(elements.access.disabled,false);assert.equal(elements.mode.disabled,false);
  c.api=async(url:string,body:any)=>{calls.push({url,body});return {requestId:body.requestId,projectId:'projectless',status:'unknown'};};await c.sendMessage();assert.equal(calls.length,1);assert.equal(calls[0].body.projectId,'projectless');assert.equal(calls[0].body.extensions[0],'a'.repeat(32));
});
