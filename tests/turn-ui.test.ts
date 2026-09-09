import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeItem,turnTiming,imageReference} from '../src/backend/normalize';
import {fileReference,markdownLinks,generatedImageReference,generatedImagesRoot} from '../src/backend/artifacts';
import path from 'node:path';
const {group,duration}=require('../public/turns.js'),{applyEvent}=require('../public/state.js');
const user=(id='u',turnId='t')=>({id,type:'userMessage',turnId,text:'hello'});
const agent=(id:string,text:string,phase?:string,turnId='t')=>({id,type:'agentMessage',turnId,text,...(phase?{phase}:{})});
test('completed turns hide all process but preserve final text and delivered images/files',()=>{
 const rows=group([user(),{id:'tool',type:'imageGeneration',turnId:'t',text:'imageGeneration',images:[{path:'cat.png'}]},agent('c','progress','commentary'),{...agent('a','done','final_answer'),files:[{path:'result.txt',source:'/p/result.txt'}]}],{status:'idle',turns:[{id:'t',status:'completed',durationMs:127000}]});
 assert.equal(rows.length,1);const row=rows[0];assert.equal(row.collapsible,true);assert.deepEqual(row.finals.map((i:any)=>i.id),['a']);assert.deepEqual(row.process.map((i:any)=>i.id),['tool','c']);assert.equal(row.images[0].path,'cat.png');assert.equal(row.files[0].path,'result.txt');assert.equal(row.label,'用时 2 分钟 7 秒');
});
test('live final-answer streams stay visible; completion collapses only after turn status changes',()=>{
 const items=[user(),agent('c','working','commentary'),agent('a','partial final','final_answer')];
 const state={status:'running',turnId:'t',turns:[{id:'t',status:'inProgress',startedAt:1000}]};let row=group(items,state,4500)[0];assert.equal(row.running,true);assert.equal(row.collapsible,false);assert.equal(row.finals.length,1);assert.equal(row.elapsed,3500);
 state.turns=[{id:'t',status:'completed',startedAt:1000,finishedAt:6000} as any];row=group(items,state,20000)[0];assert.equal(row.collapsible,true);assert.equal(row.elapsed,5000);
});
test('failed/interrupted turns expose process, and commentary is never mistaken for final',()=>{
 for(const status of ['failed','interrupted','cancelled']){const r=group([user(),agent('c','commentary only','commentary')],{turns:[{id:'t',status}]})[0];assert.equal(r.collapsible,false);assert.equal(r.finals.length,0);assert.equal(r.process.length,1);}
});
test('legacy final fallback, orphan deltas, multiple turns and steered user messages stay separate',()=>{
 const rows=group([{...user(),turnId:undefined},agent('a1','old',undefined,undefined),user('u2','t2'),user('u3','t2'),agent('a2','new',undefined,'t2')],{});
 // First assistant has an explicit id due to fixture default: exercise a truly missing turn id below.
 const legacy=group([{id:'u',type:'userMessage',text:'first'},{id:'a',type:'agentMessage',text:'done'},{id:'u2',type:'userMessage',text:'second'},{id:'a2',type:'agentMessage',text:'new'}],{});
 assert.equal(legacy.length,2);assert.equal(legacy[0].finals[0].text,'done');assert.equal(rows.at(-1).users.length,2);
});
test('wall-clock timing never sums overlapping tools or uses per-message duration as total',()=>{
 const row=group([user(),{id:'x',type:'commandExecution',turnId:'t',text:'x',durationMs:7000,startedAt:1000,finishedAt:8000},{id:'y',type:'commandExecution',turnId:'t',text:'y',durationMs:6000,startedAt:2000,finishedAt:8000},agent('a','done')],{})[0];assert.equal(row.elapsed,7000);
 const unknown=group([user(),{id:'x',type:'commandExecution',turnId:'t',text:'x',durationMs:7000},agent('a','done')],{})[0];assert.equal(unknown.elapsed,undefined);assert.doesNotMatch(unknown.label,/毫秒|7 秒/);assert.equal(duration(0),'不到 1 秒');assert.equal(duration(3661000),'1 小时 1 分钟 1 秒');
});
test('delivery deduplication keeps final-linked files and additions, not every changed source file',()=>{
 const items=[user(),{id:'f',type:'fileChange',turnId:'t',text:'',files:[{path:'added.txt',kind:'add'},{path:'code.ts',kind:'update'},{path:'gone.txt',kind:'delete'}]},{...agent('a','done'),images:[{path:'cat.png'},{path:'cat.png'}],files:[{path:'added.txt'},{path:'code.ts'},{path:'cat.png'}]}];const row=group(items,{})[0];assert.equal(row.images.length,1);assert.deepEqual(row.files.map((f:any)=>f.path),['added.txt','code.ts']);
});
test('normalization preserves final phase and converts actual absolute/encoded delivery links',()=>{
 const item=normalizeItem({id:'a',type:'agentMessage',phase:'final_answer',text:'**完成**\n[result.txt](/project/result.txt)\n[报告](/project/中文%20报告.txt)\n![猫](/project/cat.png)'},'/project','t');
 assert.equal(item.phase,'final_answer');assert.deepEqual(item.files?.map(f=>f.path),['result.txt','中文 报告.txt']);assert.equal(item.images?.[0].path,'cat.png');assert.equal(item.images?.[0].source,'/project/cat.png');assert.equal(normalizeItem({id:'a',type:'agentMessage',phase:'analysis',text:'x'}).phase,undefined);
});
test('Markdown scanner recognizes parentheses/angle paths, ignores fenced and inline code',()=>{
 const tick=String.fromCharCode(96),text='[one](</project/report (2).txt>)\n[two](/project/file(1).txt)\n'+tick+'[not](/project/secret.txt)'+tick+'\n'+tick.repeat(3)+'md\n[also not](/project/no.txt)\n'+tick.repeat(3);
 assert.deepEqual(markdownLinks(text).map(v=>v.source),['/project/report (2).txt','/project/file(1).txt']);
});
test('file/image normalization blocks traversal, private paths, unsafe schemes and decoded controls on both platforms',()=>{
 for(const input of ['../secret','%2e%2e/secret','.codex/auth.json','.env.local','javascript:alert(1)','file:///project/a.png','/elsewhere/a.txt','a%00.txt'])assert.equal(fileReference(input,'/project'),undefined,input);
 assert.equal(fileReference('C:\\project\\文件 (2).txt','C:\\project'),'文件 (2).txt');assert.equal(fileReference('sandbox:/project/a.txt','/project'),'a.txt');assert.equal(fileReference('D:\\elsewhere\\a.png','C:\\project'),undefined);assert.equal(imageReference('data:image/png;base64,AAAA','/project'),undefined);
});
test('savedPath/result image generation paths are retained, base64 and unrelated files are never exposed',()=>{
 for(const field of ['savedPath','saved_path','outputPath','result'])assert.equal(normalizeItem({id:'g',type:'imageGeneration',[field]:'/project/cat.png'},'/project','t').images?.[0].path,'cat.png');
 const saved=path.join(generatedImagesRoot(),'qa','cat.png'),item=normalizeItem({id:'g',type:'imageGeneration',savedPath:saved,result:'A'.repeat(100000)},'/project','t');assert.equal(item.images?.[0].generated,'qa/cat.png');assert.equal(JSON.stringify(item).includes('AAAA'),false);
 assert.equal(generatedImageReference(path.join(generatedImagesRoot(),'..','private.png')),undefined);assert.equal(normalizeItem({id:'g',type:'imageGeneration',savedPath:'/etc/private.png'},'/project').images,undefined);
 assert.equal(normalizeItem({id:'a',type:'agentMessage',text:'![private]('+saved+')'},'/project').images,undefined);
});
test('explicit protocol turn seconds become milliseconds; completion freezes duration across reconnect',()=>{
 const started=turnTiming({id:'t',status:'inProgress',startedAt:10},undefined,50000);assert.equal(started.startedAt,10000);
 const done=turnTiming({id:'t',status:'completed',completedAt:20},started,50000);assert.equal(done.durationMs,10000);assert.equal(turnTiming({id:'t',status:'completed'},done,99999).durationMs,10000);
 const unknown=turnTiming({id:'old',status:'completed'});assert.equal(unknown.startedAt,undefined);assert.equal(unknown.durationMs,undefined);
});
test('status reducer replaces turn metadata without losing text; new active turn cannot reopen old turns',()=>{
 const state:any={items:new Map(),pending:new Map(),turns:[],status:'running'};const turns=[{id:'t',status:'completed',durationMs:2000}];assert.equal(applyEvent(state,{type:'status',payload:{status:'idle',turnId:'t',turns}}),true);assert.deepEqual(state.turns,turns);
 const rows=group([user(),agent('a','done'),user('u2','t2'),agent('c','working','commentary','t2')],{turns,status:'running',turnId:'t2'});assert.equal(rows[0].collapsible,true);assert.equal(rows[1].running,true);
});
