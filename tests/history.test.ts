import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {CodexRpcError} from '../src/backend/transport';
import {readThreadHistory} from '../src/backend/history';
import {publicBackendError} from '../src/backend/errors';
const c:any={TextEncoder,URL};vm.createContext(c);vm.runInContext(readFileSync(path.join(__dirname,'../public/history.js'),'utf8'),c);const H=c.CodexHistoryCore;
const item=(text='hello')=>({id:'item',type:'agentMessage',text,turnId:'turn'});
test('cache sanitizes executable state, tokens and media handles, retaining bounded Unicode text',()=>{
  const row=H.snapshot({items:[{...item('中文🙂'.repeat(70000)),token:'secret',images:[{src:'native-handle'}]}],turns:[{id:'turn',status:'inProgress',secret:'x'}],pending:[{id:'approval'}],cursor:'cursor',queue:[{text:'write'}]});
  assert.ok(new TextEncoder().encode(JSON.stringify(row)).length<=H.MAX_BYTES);assert.ok(row.items[0].truncated);for(const secret of ['native-handle','secret','approval','cursor','queue'])assert.ok(!JSON.stringify(row).includes(secret));
  assert.equal(row.items[0].turnId,'turn');assert.equal(row.truncated,false);
});
test('cache task list excludes permissions, server paths and unbounded titles',()=>{const rows=H.threads(Array.from({length:130},(_,i)=>({id:String(i),title:'x'.repeat(1000),root:'/private',permissions:{send:true}})));assert.equal(rows.data.length,120);assert.equal(rows.data[0].title.length,240);assert.ok(!JSON.stringify(rows).includes('permissions'));});
test('history isolation across logout, account, server, project and task',async()=>{
  const data=new Map<string,string>();let server='https://one.test';
  const plugin={profile:async()=>({baseUrl:server}),historyCache:async({key,value}:any)=>{if(value!==undefined)data.set(key,value);return {value:data.get(key)||''};}};
  const cache=H.create({plugin});await cache.init({id:'a'});await cache.write('p','t',H.snapshot({items:[item()]}));cache.reset();assert.equal(await cache.read('p','t'),null);
  await cache.init({id:'b'});assert.equal(await cache.read('p','t'),null);await cache.init({id:'a'});assert.equal((await cache.read('p','t')).items[0].text,'hello');assert.equal(await cache.read('p2','t'),null);assert.equal(await cache.read('p','t2'),null);
  server='https://two.test';await cache.init({id:'a'});assert.equal(await cache.read('p','t'),null);
});
test('TTL, future dates, corrupt records, byte cap, LRU and empty snapshots',async()=>{
  let now=100000;const cache=H.create({now:()=>now});await cache.init({id:'a'});await cache.write('p','t',H.snapshot({items:[]},now));assert.deepEqual(Array.from((await cache.read('p','t')).items),[]);
  now+=H.TTL+1;assert.equal(await cache.read('p','t'),null);await cache.write('p','future',H.snapshot({items:[]},now+60001));assert.equal(await cache.read('p','future'),null);
  await assert.rejects(cache.write('p','huge',{text:'文'.repeat(H.MAX_BYTES)}),/上限/);
  for(let i=0;i<40;i++)await cache.write('p',String(i),H.snapshot({items:[item()]},now));assert.equal(await cache.read('p','0'),null);assert.ok(await cache.read('p','39'));
  const broken=H.create({plugin:{profile:async()=>({baseUrl:'https://x.test'}),historyCache:async()=>({value:'not-json'})}});await broken.init({id:'a'});assert.equal(await broken.read('p','t'),null);
});
test('late cache read is ignored after account reset and native write errors propagate',async()=>{
  let resolve!:(value:any)=>void;const cache=H.create({plugin:{profile:async()=>({baseUrl:'https://x.test'}),historyCache:()=>new Promise(r=>resolve=r)}});await cache.init({id:'a'});const read=cache.read('p','t');await Promise.resolve();await Promise.resolve();cache.reset();resolve({value:JSON.stringify(H.snapshot({items:[item()]}))});assert.equal(await read,null);
  const failed=H.create({plugin:{profile:async()=>({baseUrl:'https://x.test'}),historyCache:async()=>{throw Error('disk full');}}});await failed.init({id:'a'});await assert.rejects(failed.write('p','t',H.snapshot({items:[]})),/disk full/);
});
test('queued cache writes are serialized and cancelled at an account boundary',async()=>{
  const calls:any[]=[];let release!:()=>void;const cache=H.create({plugin:{profile:async()=>({baseUrl:'https://x.test'}),historyCache:async(value:any)=>{calls.push(value);if(calls.length===1)await new Promise<void>(r=>release=r);}}});await cache.init({id:'a'});
  const first=cache.write('p','t',H.snapshot({items:[item('first')]}));await Promise.resolve();await Promise.resolve();const second=cache.write('p','t',H.snapshot({items:[item('second')]}));cache.reset();release();await Promise.all([first,second]);assert.equal(calls.length,1);
});
test('paged history does not fall back when supported',async()=>{const calls:string[]=[];const out=await readThreadHistory(async method=>{calls.push(method);return {data:[{id:'last'}]};},'t');assert.deepEqual(calls,['thread/turns/list']);assert.equal(out.data[0].id,'last');});
test('old history method-not-found falls back to read-only full history with ordering and truncation',async()=>{
  const calls:any[]=[];const out=await readThreadHistory(async(method,params)=>{calls.push({method,params});if(method==='thread/turns/list')throw new CodexRpcError(-32601,'unavailable');return {thread:{id:'t',turns:Array.from({length:23},(_,i)=>({id:String(i)}))}};},'t');assert.equal(out.data.length,20);assert.equal(out.data[0].id,'22');assert.equal(out.data.at(-1).id,'3');assert.ok(out.nextCursor);assert.deepEqual(calls[1],{method:'thread/read',params:{threadId:'t',includeTurns:true}});
});
for(const error of [new CodexRpcError(-32602,'invalid parameters'),new CodexRpcError(-32001,'permission denied'),new Error('timeout'),{code:-32601}])test('no history fallback on non-method error '+String((error as any).message||(error as any).code),async()=>{let count=0;await assert.rejects(readThreadHistory(async()=>{count++;throw error;},'t'));assert.equal(count,1);});
test('legacy fallback rejects wrong task or missing turns instead of displaying empty history',async()=>{for(const thread of [{id:'other',turns:[]},{id:'t'}])await assert.rejects(readThreadHistory(async method=>{if(method==='thread/turns/list')throw new CodexRpcError(-32601,'');return {thread};},'t'),/Invalid historical/);});
test('public diagnostics preserve numeric categories without secret upstream messages',()=>{for(const code of [-32601,-32602,-32001]){const info=publicBackendError(new CodexRpcError(code,'PASSWORD=/private/token'));assert.ok(!JSON.stringify(info).includes('PASSWORD'));assert.equal((info as any).rpcCode,code);}assert.equal(publicBackendError(new Error('SECRET')).code,'BACKEND_ERROR');});

test('malformed paged success is rejected, not mistaken for an empty history',async()=>{let calls=0;await assert.rejects(readThreadHistory(async()=>{calls++;return {};},'t'),/Invalid paged/);assert.equal(calls,1);});


test('history pages one turn at a time with cursor ordering and a twenty-turn cap',async()=>{
 const calls:any[]=[];const h=await readThreadHistory(async(method,params)=>{calls.push({method,params});const n=params.cursor?Number(params.cursor):0;return {data:[{id:String(n)}],nextCursor:String(n+1)};},'t');
 assert.equal(calls.length,20);assert.ok(calls.every(c=>c.method==='thread/turns/list'&&c.params.limit===1&&c.params.itemsView==='full'));
 assert.equal(calls[1].params.cursor,'1');assert.equal(h.data.length,20);assert.equal(h.data[0].id,'0');assert.equal(h.nextCursor,'20');
});
test('aggregate history budget retains newer pages and marks older history partial',async()=>{
 let calls=0;const h=await readThreadHistory(async()=>({data:[{id:String(calls++),text:'x'.repeat(1100*1024)}],nextCursor:String(calls)}),'t');
 assert.equal(calls,2);assert.equal(h.data.length,1);assert.equal(h.warning?.code,'HISTORY_PARTIAL');assert.ok(h.nextCursor);
});
test('oversized latest page is explicit and never falls back to a full-history read',async()=>{
 const calls:string[]=[];await assert.rejects(readThreadHistory(async method=>{calls.push(method);throw Object.assign(new RangeError('Max payload size exceeded'),{code:'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH'});},'t'),(e:any)=>e.status===413&&e.code==='HISTORY_TOO_LARGE');assert.deepEqual(calls,['thread/turns/list']);
});
test('oversized older page preserves already read recent history without a full reread',async()=>{
 let count=0;const h=await readThreadHistory(async()=>{if(count++)throw Object.assign(Error('oversized'),{code:'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH'});return {data:[{id:'recent'}],nextCursor:'older'};},'t');assert.equal(h.data[0].id,'recent');assert.equal(h.warning?.code,'HISTORY_PARTIAL');assert.equal(count,2);
});
test('legacy oversized read stays bounded and returns explicit failure',async()=>{
 await assert.rejects(readThreadHistory(async method=>{if(method==='thread/turns/list')throw new CodexRpcError(-32601,'old');throw Object.assign(Error('oversized'),{code:'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH'});},'t'),(e:any)=>e.code==='HISTORY_TOO_LARGE');
});
test('pagination loops, duplicate turns and malformed cursors fail instead of looping',async()=>{
 for(const kind of ['cursor','duplicate','malformed']){let n=0;await assert.rejects(readThreadHistory(async()=>({data:[{id:kind==='duplicate'?'same':String(n++)}],nextCursor:kind==='malformed'?42:kind==='cursor'?'repeat':String(n++)}),'t'),/Invalid/);}
});
test('permission errors after one page cannot be disguised as a partial successful history',async()=>{
 let n=0;await assert.rejects(readThreadHistory(async()=>{if(n++)throw new CodexRpcError(-32001,'forbidden');return {data:[{id:'one'}],nextCursor:'next'};},'t'),(e:any)=>e.code===-32001);
});
