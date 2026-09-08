import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
const stateSource = fs.readFileSync(path.join(__dirname,'../public/state.js'),'utf8');
const source = fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
function setup() {
  const elements:any = new Proxy({}, {get(target:any,key:any){return target[key] ||= {value:'',textContent:'',hidden:false,disabled:false,focus:()=>{},querySelector:()=>({disabled:false})};}});
  elements.access.value='default';elements.prompt.value='hello';elements.model.value='test-model';elements.effort.value='low';elements.mode.value='code';
  const S:any={user:{admin:true},connected:true,project:{id:'demo'},thread:null,threads:[],status:'idle',sending:false,epoch:1,attachments:[],selected:[],references:[],goalDraft:'',accessConfirmed:false,attempt:null};
  const calls:any[]=[]; const notices:string[]=[]; let cleared=0;
  const c:any={module:{exports:{}},crypto:{getRandomValues:webcrypto.getRandomValues.bind(webcrypto)},Uint8Array,document:{},S,$:(id:string)=>elements[id],permission:()=>true,stateName:(v:string)=>v,renderThreads:()=>{},renderAttachments:()=>{},renderSettingsSource:()=>{},notice:(v='')=>notices.push(v),clearConversation:()=>{cleared++;S.epoch++;S.thread=null;elements.prompt.value='';},syncSnapshot:async()=>{},api:async(url:string,body:any)=>{calls.push({url,body});return url.endsWith('/threads')?{id:'real-created',title:'hello',status:'idle'}:{ok:true};}};
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
  assert.equal(elements['sidebar-plugins'].disabled,true);assert.equal(elements['refresh-quota'].hidden,true);
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
  const {c,S,elements,calls}=attached();await c.loadQuota();const catalog=await c.loadCatalog();
  assert.equal(calls.length,0);assert.equal(catalog.entries.length,0);
  assert.equal(S.catalogProject,'demo');assert.match(elements['quota-content'].textContent,/Codex 桌面/);
});
test('ordinary app-server mode retains new-task and extension commands',async()=>{
  const state=setup();const {c,S,elements}=state;S.thread={id:'old'};
  await c.startNewConversation();assert.equal(state.cleared,1);assert.equal(S.thread,null);
  c.controls();assert.equal(elements['new-thread'].hidden,false);
  for(const id of ['new','skills','plugins','mcp','goal'])assert.equal(c.commandAvailable({id}),true,id);
});
