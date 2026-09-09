import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import vm from 'node:vm';
import {textPrefix} from '../src/backend/text';import {normalizeItem,MAX_ITEM_CHARS} from '../src/backend/normalize';
const context:any={module:{exports:{}}};vm.runInNewContext(fs.readFileSync('public/state.js','utf8'),context);const client=context.module.exports;
const multilingual='中文𠮷𰻞 👩🏽‍💻 🐱 é العربية ไทย हिन्दी 𝄞 <script>alert(1)</script>';
test('Unicode text survives normalization, SSE JSON and UTF-16 delta offsets without rewriting any script',()=>{
 const s={items:new Map(),pending:new Map()};client.applyEvent(s,{type:'item',payload:{id:'msg',type:'agentMessage',text:''}});
 let offset=0;for(let i=0;i<multilingual.length;i++){const payload={itemId:'msg',offset,text:multilingual[i]};const wire='data: '+JSON.stringify({type:'delta',payload})+'\n\n';const event=client.parseSse(wire).events[0];assert.equal(client.applyEvent(s,event),true);offset++;}
 assert.equal(s.items.get('msg').text,multilingual);assert.equal(normalizeItem({id:'msg',type:'agentMessage',text:multilingual}).text,multilingual);assert.equal(client.textDiagnostics(multilingual).replacement,0);assert.equal(client.textDiagnostics(multilingual).unpaired,0);
});
test('all bounded text helpers avoid splitting emoji and rare CJK surrogate pairs at 64KiB',()=>{
 const text='x'.repeat(MAX_ITEM_CHARS-1)+'𠮷尾';
 for(const slice of [textPrefix,client.textPrefix]){const result=slice(text,MAX_ITEM_CHARS);assert.equal(result.length,MAX_ITEM_CHARS-1);assert.equal(client.textDiagnostics(result).unpaired,0);}
 const item=normalizeItem({id:'m',type:'agentMessage',text});assert.equal(item.truncated,true);assert.equal(client.textDiagnostics(item.text).unpaired,0);
});
test('source diagnostics distinguishes real replacement/unpaired characters from valid non-Latin output',()=>{
 const info=client.textDiagnostics('正常\ufffd\ud800文字');assert.equal(info.replacement,1);assert.equal(info.unpaired,1);assert.ok(info.samples.some((s:string)=>s.includes('U+FFFD')));
});
test('production source files are valid UTF-8 and contain no replacement characters or known double-decoding artifacts',()=>{
 const files:string[]=[];function visit(dir:string){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())visit(p);else if(/\.(ts|js|html|css)$/.test(e.name))files.push(p);}}visit('src');visit('public');
 for(const file of files){const text=new TextDecoder('utf-8',{fatal:true}).decode(fs.readFileSync(file));assert.doesNotMatch(text,/\ufffd|锟斤拷|ï¿½|Ã©|â€™/,file);}
});
