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
  const context:any={S:state,document:{hidden:false},$:()=>label,Math,setTimeout:(fn:Function)=>{queue.push(fn);return queue.length;},api:async()=>{if(++calls===1)throw new Error('offline');},openStream:()=>opened++};
  vm.runInNewContext(extract('scheduleReconnect','scheduleRender'),context);
  context.scheduleReconnect(1);assert.equal(queue.length,1);await queue.shift()!();assert.equal(queue.length,1);await queue.shift()!();assert.equal(opened,1);
  context.scheduleReconnect(1);state.epoch=2;await queue.shift()!();assert.equal(opened,1);
  state.epoch=1;context.api=async()=>{const e:any=new Error('logout');e.status=401;throw e;};context.scheduleReconnect(1);await queue.shift()!();assert.equal(queue.length,0);
});
test('upload cancels before transmission if the project changes while reading the file',async()=>{
  const upload:any={files:[{name:'file.txt',size:10}],value:'selected'};const state:any={epoch:1,project:{id:'original'},attachments:[]};let sent=0;
  class FakeFileReader {result='data:text/plain;base64,YQ==';onload?:()=>void;readAsDataURL(){state.epoch++;state.project={id:'other'};this.onload?.();}}
  const context:any={S:state,$:()=>upload,FileReader:FakeFileReader,api:async()=>{sent++;},renderAttachments:()=>{},toast:()=>{}};
  const start=source.indexOf('async function uploadFile('),end=source.indexOf('let quotaLoading',start);
  vm.runInNewContext(source.slice(start,end),context);
  await assert.rejects(context.uploadFile(),/项目已切换/);assert.equal(sent,0);assert.equal(upload.value,'');
});
