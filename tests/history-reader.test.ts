import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {WebSocketServer} from 'ws';
import {CodexRpcClient} from '../src/backend/transport';
import {IsolatedHistoryReader} from '../src/backend/history-reader';

test('oversized history cannot close the shared command/event connection',async t=>{
 const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');
 const calls:string[]=[];server.on('connection',s=>s.on('message',raw=>{const m=JSON.parse(raw.toString());calls.push(m.method);if(m.method==='initialized')return;const result=m.method==='initialize'?{}:m.method==='thread/turns/list'?{data:[{id:'turn',text:'x'.repeat(4*1024*1024)}]}:{thread:{id:'other'}};s.send(JSON.stringify({id:m.id,result}));}));
 const options={type:'websocket' as const,endpoint:'ws://127.0.0.1:'+address.port};const shared=new CodexRpcClient(options),reader=new IsolatedHistoryReader();
 t.after(async()=>{reader.cancelAll();shared.close();for(const s of server.clients)s.terminate();await new Promise<void>(r=>server.close(()=>r()));});await shared.connect();
 await assert.rejects(reader.read(options,'large'),(e:any)=>e.code==='HISTORY_TOO_LARGE');assert.equal(shared.connected,true);assert.equal((await shared.request('thread/read',{threadId:'other',includeTurns:false})).thread.id,'other');
 assert.ok(calls.every(m=>['initialize','initialized','thread/read','thread/turns/list'].includes(m)));
});
function blocked(){let release!:(x:any)=>void,closed=0;const pending=new Promise<any>(r=>release=r);const reader=new IsolatedHistoryReader(()=>({connect:async()=>{},close(){closed++;},request:()=>pending}) as unknown as CodexRpcClient,1);return {reader,release,closed:()=>closed};}
const options={type:'unix' as const,endpoint:'/isolated-test-only'};
test('history cancellation rejects stale results and releases capacity',async()=>{
 const f=blocked();const read=f.reader.read(options,'a');await Promise.resolve();f.reader.cancelAll();f.release({data:[{id:'late'}]});await assert.rejects(read,(e:any)=>e.code==='CONNECTION_CHANGED');assert.ok(f.closed()>0);
});
test('history concurrency is bounded and errors do not leak a pool slot',async()=>{
 const f=blocked();const first=f.reader.read(options,'a');await Promise.resolve();await assert.rejects(f.reader.read(options,'b'),(e:any)=>e.code==='HISTORY_BUSY');f.release({data:[]});await first;await f.reader.read(options,'b');
});
test('account/server generation checks run after the awaited page',async()=>{
 let current=true;const f=blocked();const first=f.reader.read(options,'a',()=>current);await Promise.resolve();current=false;f.release({data:[{id:'old'}]});await assert.rejects(first,(e:any)=>e.code==='CONNECTION_CHANGED');
});
test('history deadline closes the reader and reports a timeout without retrying',async()=>{
 let reject!:(e:Error)=>void;const wait=new Promise((_r,r)=>reject=r);const reader=new IsolatedHistoryReader(()=>({connect:async()=>{},request:()=>wait,close(){reject(Error('closed'));}}) as unknown as CodexRpcClient,1,15);
 await assert.rejects(reader.read(options,'a'),(e:any)=>e.code==='HISTORY_TIMEOUT');
});
