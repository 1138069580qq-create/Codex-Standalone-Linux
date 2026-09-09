import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
// Execute the exact production helper with controlled timing and dependencies, not a reimplementation.
const source=readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
function extract(name:string,next:string){return source.slice(source.indexOf(`function ${name}(`),source.indexOf(`function ${next}(`));}
test('reconnect keeps retrying transient session failures, stops after logout or project change',async()=>{
  const queue:Function[]=[];const state:any={epoch:1,thread:{id:'a'},retry:0};const label:any={};let calls=0;let opened=0;
  const context:any={S:state,document:{hidden:false},$:()=>label,Math,setTimeout:(fn:Function)=>{queue.push(fn);return queue.length;},api:async()=>{if(++calls===1)throw new Error('offline');},syncSnapshot:()=>opened++};
  vm.runInNewContext(extract('scheduleReconnect','scheduleRender'),context);
  context.scheduleReconnect(1);assert.equal(queue.length,1);await queue.shift()!();assert.equal(queue.length,1);await queue.shift()!();assert.equal(opened,1);
  context.scheduleReconnect(1);state.epoch=2;await queue.shift()!();assert.equal(opened,1);
  state.epoch=1;context.api=async()=>{const e:any=new Error('logout');e.status=401;throw e;};context.scheduleReconnect(1);await queue.shift()!();assert.equal(queue.length,0);
});
test('upload cancels before transmission if the project changes while reading the file',async()=>{
  const state:any={epoch:1,user:{id:'qa'},project:{id:'original'},attachments:[]};let sent=0;
  const file={name:'file.txt',size:10,arrayBuffer:async()=>{state.epoch++;state.project={id:'other'};return new ArrayBuffer(10);}};
  const upload:any={files:[file],value:'selected'};
  const features=readFileSync(path.join(__dirname,'../public/features.js'),'utf8');
  const context:any={S:state,$:()=>upload,api:async()=>{sent++;},renderAttachments:()=>{},crypto:{subtle:{digest:async()=>new ArrayBuffer(32)}},same:(epoch:number,id:string)=>epoch===state.epoch&&id===state.project.id,Uint8Array,ArrayBuffer};
  const helperStart=features.indexOf('async function upload('),helperEnd=features.indexOf('async function loadRegistrations(',helperStart);
  vm.runInNewContext(features.slice(helperStart,helperEnd),context);context.CodexFeatures={upload:context.upload};
  const start=source.indexOf('async function uploadFile('),end=source.indexOf('let quotaLoading',start);vm.runInNewContext(source.slice(start,end),context);
  await assert.rejects(context.uploadFile(),/项目已切换/);assert.equal(sent,0);assert.equal(upload.value,'');
});

test('reconnect refreshes snapshots and stops forbidden or explicitly disconnected sessions',async()=>{
  for(const error of [{status:403,code:'THREAD_FORBIDDEN',message:'forbidden'},{status:503,code:'CODEX_DISCONNECTED',message:'manual disconnect'}]){
    const timers:Function[]=[],label:any={},state:any={epoch:2,thread:{id:'a'},retry:0};let snapshots=0;
    const c:any={S:state,document:{hidden:false},$:()=>label,Math,setTimeout:(fn:Function)=>timers.push(fn),api:async()=>({}),syncSnapshot:async()=>{snapshots++;throw error;},notice:()=>{},controls:()=>{}};
    vm.runInNewContext(extract('scheduleReconnect','scheduleRender'),c);c.scheduleReconnect(2);await timers.shift()!();assert.equal(snapshots,1);assert.equal(timers.length,0);assert.match(label.textContent,/不可访问|管理员断开/);
  }
});
test('stale EventSource callbacks cannot change status; short-lived streams retain backoff',()=>{
  const timers:Function[]=[],created:any[]=[],label:any={};const state:any={epoch:1,thread:{id:'a'},project:{id:'p'},retry:4,cursor:'c'};
  class Stream{onopen?:()=>void;onerror?:()=>void;handlers:any={};constructor(){created.push(this);}addEventListener(n:string,fn:Function){this.handlers[n]=fn;}}
  const c:any={S:state,document:{hidden:false},$:()=>label,EventSource:Stream,apiProject:()=>'',closeStream:()=>state.stream=null,setTimeout:(fn:Function)=>timers.push(fn),scheduleReconnect:()=>{},controls:()=>{},notice:()=>{},TextEncoder};
  vm.runInNewContext(extract('openStream','scheduleReconnect'),c);c.openStream();const first=created[0];first.onopen();assert.equal(state.retry,4);c.openStream();label.textContent='current';first.onopen();assert.equal(label.textContent,'current');timers.shift()!();assert.equal(state.retry,4);created[1].onopen();timers.shift()!();assert.equal(state.retry,0);
});
