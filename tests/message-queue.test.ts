import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';
import {MessageQueue} from '../src/backend/message-queue';
import {ReplayHub} from '../src/backend/events';
import {ConsoleError} from '../src/backend/config';
const who={uuid:'alice',elevated:false};
async function setup(){
 const dir=await mkdtemp(path.join(os.tmpdir(),'webui-queue-')),file=path.join(dir,'queue.json');let allowed=true;
 const service:any={hub:new ReplayHub(),state:'running',turnId:'turn-1',calls:[],error:null,wait:null,
 project(user:any,id:string){if(!allowed||user.uuid!=='alice'||id!=='project')throw new ConsoleError(403,'FORBIDDEN','forbidden');},
 async snapshot(user:any,p:string,t:string){this.project(user,p);if(t!=='thread')throw new ConsoleError(403,'FORBIDDEN','forbidden');return {status:this.state,turnId:this.turnId};},
 async send(user:any,p:string,t:string,input:any){this.project(user,p);this.calls.push(structuredClone(input));if(this.wait)await this.wait;if(this.error)throw this.error;this.state='running';return {turnId:this.turnId};}
 };
 const queue=new MessageQueue(file,service,()=>allowed?who:null,false);await queue.load();
 const input=(id:string,text=id)=>({requestId:'message-'+id,text,attachments:['pic.png'],references:['README.md'],extensions:[]});
 const add=(id:string)=>queue.enqueue(who,'project','thread',input(id));const rows=()=>queue.rows(who,'project','thread');
 const change=(id:string,action:string,extra:any={})=>{const row=rows().find(r=>r.id==='message-'+id)!;return queue.change(who,'project','thread',row.id,{version:row.version,action,...extra});};
 return {queue,service,file,input,add,rows,change,revoke:()=>{allowed=false;}};
}
test('running messages are durable, ordered, preserve attachments, and dispatch exactly one per completed turn',async t=>{
 const f=await setup();t.after(()=>f.queue.close());await f.add('one');await f.add('two');await f.queue.pump();assert.equal(f.service.calls.length,0);
 f.service.state='idle';await Promise.all([f.queue.pump(),f.queue.pump()]);assert.equal(f.service.calls.length,1);assert.equal(f.service.calls[0].text,'one');assert.deepEqual(f.service.calls[0].attachments,['pic.png']);assert.deepEqual(f.service.calls[0].references,['README.md']);assert.equal(f.rows().length,1);
 f.service.state='idle';await f.queue.pump();assert.equal(f.service.calls[1].text,'two');assert.equal(f.rows().length,0);assert.doesNotMatch(await readFile(f.file,'utf8'),/pic.png|README.md/);
});
test('enqueue retries and sent/deleted tombstones are idempotent; changed payloads cannot reuse IDs',async t=>{
 const f=await setup();t.after(()=>f.queue.close());await Promise.all([f.add('one'),f.add('one')]);assert.equal(f.rows().length,1);
 await assert.rejects(f.queue.enqueue(who,'project','thread',f.input('one','different')),/请求 ID/);
 await f.change('one','delete');await f.add('one');assert.equal(f.rows().length,0);await f.queue.pump();assert.equal(f.service.calls.length,0);
});
test('editing pauses the head atomically, does not lose input, and save resumes FIFO',async t=>{
 const f=await setup();t.after(()=>f.queue.close());await f.add('one');await f.add('two');await f.change('one','edit');f.service.state='idle';await f.queue.pump();assert.equal(f.service.calls.length,0);
 await f.change('one','save',{text:'修改后的中文 👩🏽‍💻'});await f.queue.pump();assert.equal(f.service.calls[0].text,'修改后的中文 👩🏽‍💻');assert.equal(f.rows()[0].text,'two');
});
test('cancel editing retains original input; delete removes only the specified queue item',async t=>{
 const f=await setup();t.after(()=>f.queue.close());await f.add('one');await f.add('two');await f.change('one','edit');await f.change('one','resume');assert.equal(f.rows()[0].text,'one');await f.change('one','delete');assert.equal(f.rows()[0].text,'two');
});
test('send now steers the active turn, but starts normally when already idle',async t=>{
 const f=await setup();t.after(()=>f.queue.close());await f.add('one');await f.add('two');await f.change('two','send');assert.equal(f.service.calls[0].delivery,'steer');assert.equal(f.service.calls[0].expectedTurnId,'turn-1');assert.equal(f.rows()[0].text,'one');
 f.service.state='idle';await f.change('one','send');assert.equal(f.service.calls[1].delivery,undefined);assert.equal(f.rows().length,0);
});
test('in-flight dispatch cannot be edited, deleted or duplicated by simultaneous pumps',async t=>{
 const f=await setup();t.after(()=>f.queue.close());await f.add('one');let release:any;f.service.wait=new Promise(r=>{release=r;});const work=f.change('one','send');
 while(!f.service.calls.length)await new Promise(r=>setImmediate(r));await assert.rejects(f.change('one','delete'),/提交/);await assert.rejects(f.change('one','edit'),/提交/);await f.queue.pump();assert.equal(f.service.calls.length,1);release();await work;
});
test('unknown dispatch is never automatically retried, including after process restart',async t=>{
 const f=await setup();t.after(()=>f.queue.close());await f.add('one');f.service.error=new Error('timeout');await f.change('one','send');assert.equal(f.rows()[0].state,'unknown');await f.queue.pump();await assert.rejects(f.change('one','resume'),/未知/);assert.equal(f.service.calls.length,1);
 const restart=new MessageQueue(f.file,f.service,()=>who,false);t.after(()=>restart.close());await restart.load();await restart.pump();assert.equal(restart.rows(who,'project','thread')[0].state,'unknown');assert.equal(f.service.calls.length,1);
});
test('restart retains unsent text but requires confirmation instead of unexpectedly sending it',async t=>{
 const f=await setup();t.after(()=>f.queue.close());await f.add('one');const restart=new MessageQueue(f.file,f.service,()=>who,false);t.after(()=>restart.close());await restart.load();f.service.state='idle';await restart.pump();const row=restart.rows(who,'project','thread')[0];assert.equal(row.state,'paused');assert.equal(row.text,'one');assert.equal(f.service.calls.length,0);
 await restart.change(who,'project','thread',row.id,{version:row.version,action:'resume'});await restart.pump();assert.equal(f.service.calls.length,1);
});
test('queue entries cannot cross accounts or projects; dispatch rechecks revoked users',async t=>{
 const f=await setup();t.after(()=>f.queue.close());await f.add('one');assert.deepEqual(f.queue.rows({uuid:'bob',elevated:true},'project','thread'),[]);
 await assert.rejects(f.queue.list({uuid:'bob',elevated:true},'project','thread'),/forbidden/);await assert.rejects(f.queue.list(who,'other','thread'),/forbidden/);
 f.revoke();f.service.state='idle';await f.queue.pump();assert.equal(f.service.calls.length,0);assert.equal(f.rows()[0].state,'paused');
});
test('concurrent stale edits fail rather than overwriting a newer queue revision',async t=>{
 const f=await setup();t.after(()=>f.queue.close());const original=await f.add('one');await f.change('one','edit');await assert.rejects(f.queue.change(who,'project','thread',original.id,{version:original.version,action:'delete'}),/已改变/);assert.equal(f.rows()[0].state,'editing');
});
test('known concurrency rejection retains FIFO for later, invalid content pauses, and queue events contain no message bodies',async t=>{
 const f=await setup();t.after(()=>f.queue.close());const events:any[]=[];f.service.hub.subscribe((e:any)=>events.push(e));await f.add('one');f.service.state='idle';f.service.error=new ConsoleError(409,'CONCURRENCY_LIMIT','busy');await f.queue.pump();assert.equal(f.rows()[0].state,'queued');f.service.error=new ConsoleError(400,'INVALID_MESSAGE','invalid');await f.queue.pump();assert.equal(f.rows()[0].state,'paused');assert.ok(events.every(e=>JSON.stringify(e.payload)==='{"changed":true}'));
 await assert.rejects(f.queue.enqueue(who,'project','thread',{...f.input('bad'),text:''}),/无效/);
});
