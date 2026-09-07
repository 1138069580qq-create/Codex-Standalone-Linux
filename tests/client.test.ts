import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
const context:any={module:{exports:{}}};vm.runInNewContext(readFileSync(path.join(__dirname,'../public/state.js'),'utf8'),context);
const {applyEvent,parseSse}=context.module.exports;
const fresh=()=>({items:new Map<string,any>(),pending:new Map(),status:'idle',truncated:false});
test('client reducer: replay deduplication, gaps, Unicode offsets and bounds',()=>{
  const s=fresh();assert.ok(applyEvent(s,{type:'item',payload:{id:'a',text:'你好😀'}}));
  const delta={type:'delta',payload:{itemId:'a',offset:4,text:' 世界'}};
  assert.ok(applyEvent(s,delta));assert.ok(applyEvent(s,delta));assert.equal(s.items.get('a').text,'你好😀 世界');
  assert.equal(applyEvent(s,{type:'delta',payload:{itemId:'a',offset:100,text:'gap'}}),false);
  assert.equal(applyEvent(s,{type:'delta',payload:{itemId:'missing',offset:0,text:'x'}}),false);
  for(let i=0;i<230;i++)applyEvent(s,{type:'item',payload:{id:String(i),text:'x'.repeat(4096)}});
  assert.ok(s.items.size<=200);assert.ok([...s.items.values()].reduce((n,v)=>n+v.text.length,0)<=512*1024);assert.equal(s.truncated,true);
});
test('SSE parser: fragmented frames, heartbeat and CRLF',()=>{
  let first=parseSse(': heartbeat\r\n\r\nevent: codex\r\ndata: {"type":"status",');
  assert.equal(first.events.length,0);
  const second=parseSse('"payload":{"status":"running"}}\r\n\r\n',first.carry);
  assert.equal(second.events.length,1);assert.equal(second.events[0].payload.status,'running');
});
test('UI has no HTML injection, polling, external assets, or frontend build requirement',()=>{
  const source=readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
  const html=readFileSync(path.join(__dirname,'../public/index.html'),'utf8');
  assert.doesNotMatch(source,/innerHTML|insertAdjacentHTML|setInterval\s*\(/);
  assert.doesNotMatch(html,/(?:src|href)="https?:\/\//);
  assert.match(source,/document\.hidden/);assert.match(source,/new EventSource/);assert.match(source,/fingerprint/);
});
