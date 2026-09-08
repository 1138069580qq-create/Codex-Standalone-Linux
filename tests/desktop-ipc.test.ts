import test from 'node:test';
import assert from 'node:assert/strict';
import {DesktopIpc} from '../src/backend/desktop-ipc';
const event=(change:any,extra:any={})=>({type:'broadcast',sourceClientId:'owner',method:'thread-stream-state-changed',version:11,params:{conversationId:'pinned',change},...extra});
const fixture=()=>{const ipc:any=new DesktopIpc('unused-test-endpoint','pinned');ipc.ownerId='owner';return ipc;};
test('desktop IPC accepts owner/thread-scoped snapshots and incremental array patches',()=>{
  const ipc=fixture();let states=0;ipc.on('state',()=>states++);
  ipc.receive(event({type:'snapshot',revision:1,conversationState:{model:'first',items:['a']}}));
  ipc.receive(event({type:'patches',baseRevision:1,revision:2,patches:[{op:'replace',path:['model'],value:'next'},{op:'add',path:['items',1],value:'b'}]}));
  assert.equal(ipc.state.model,'next');assert.deepEqual(ipc.state.items,['a','b']);assert.equal(states,2);
  ipc.receive(event({type:'snapshot',revision:3,conversationState:{model:'wrong'}},{sourceClientId:'other-owner'}));
  ipc.receive(event({type:'snapshot',revision:3,conversationState:{model:'wrong'}},{params:{conversationId:'another-task'}}));
  assert.equal(ipc.state.model,'next');assert.equal(states,2);ipc.close();
});
test('desktop IPC rejects prototype patches and invalid / oversized frames',()=>{
  const ipc=fixture();ipc.state={};
  assert.throws(()=>ipc.patch({op:'add',path:['__proto__','polluted'],value:true}),/Invalid desktop patch/);
  assert.equal(({} as any).polluted,undefined);
  let closed=0;ipc.close=()=>closed++;
  const header=Buffer.alloc(4);header.writeUInt32LE(33*1024*1024);ipc.data(header);assert.equal(closed,1);
});
test('desktop IPC parses fragmented frames and rejects pending writes on disconnect',async()=>{
  const ipc=fixture();const msg=Buffer.from(JSON.stringify(event({type:'snapshot',revision:1,conversationState:{model:'fragmented'}}))),header=Buffer.alloc(4);header.writeUInt32LE(msg.length);
  const frame=Buffer.concat([header,msg]);ipc.data(frame.subarray(0,9));assert.equal(ipc.state,undefined);ipc.data(frame.subarray(9));assert.equal(ipc.state.model,'fragmented');
  ipc.socket={writable:true,write:()=>{},destroy:()=>{}};
  const pending=ipc.request('test',{},1);const rejected=assert.rejects(pending,/Desktop disconnected/);ipc.close();await rejected;assert.equal(ipc.pending.size,0);
});
test('desktop IPC snapshot refresh coalesces simultaneous gap recovery requests',async()=>{
  const ipc=fixture();let calls=0,finish:()=>void=()=>{};ipc.request=()=>{calls++;return new Promise<void>(resolve=>finish=resolve);};
  const first=ipc.refresh(),second=ipc.refresh();assert.equal(calls,1);finish();await Promise.all([first,second]);ipc.close();
});
