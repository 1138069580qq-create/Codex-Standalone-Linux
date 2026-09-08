import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
const stateSource = fs.readFileSync(path.join(__dirname,'../public/state.js'),'utf8');
const source = fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
function setup() {
  const elements:any = new Proxy({}, {get(target:any,key:any){return target[key] ||= {value:'',textContent:'',hidden:false,disabled:false};}});
  elements.prompt.value='hello';elements.model.value='test-model';elements.effort.value='low';elements.mode.value='code';
  const S:any={user:{admin:true},connected:true,project:{id:'demo'},thread:null,threads:[],status:'idle',sending:false,epoch:1,attachments:[],attempt:null};
  const calls:any[]=[];
  const c:any={module:{exports:{}},crypto:{getRandomValues:webcrypto.getRandomValues.bind(webcrypto)},Uint8Array,document:{},S,$:(id:string)=>elements[id],permission:()=>true,stateName:(v:string)=>v,renderThreads:()=>{},renderAttachments:()=>{},notice:()=>{},syncSnapshot:async()=>{},api:async(url:string,body:any)=>{calls.push({url,body});return url.endsWith('/threads')?{id:'real-created',title:'hello',status:'idle'}:{ok:true};}};
  vm.runInNewContext(stateSource,c);c.CodexState=c.module.exports;
  for(const [a,b] of [['function controls()','async function signedIn('],['async function sendMessage()','function renderAttachments()']])vm.runInNewContext(source.slice(source.indexOf(a),source.indexOf(b)),c);
  return {c,S,elements,calls};
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
