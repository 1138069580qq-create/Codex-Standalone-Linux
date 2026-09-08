import test from 'node:test';import assert from 'node:assert/strict';import net from 'node:net';import path from 'node:path';import os from 'node:os';import {randomUUID} from 'node:crypto';
import {DesktopTools} from '../src/backend/desktop-tools';
async function fakeServer(t:any,handler:(request:any,socket:net.Socket,reply:(result:any)=>void)=>void){
  const endpoint=process.platform==='win32'?'\\\\.\\pipe\\codex-webui-tools-test-'+randomUUID():path.join(os.tmpdir(),'webui-tools-'+randomUUID()+'.sock');const sockets=new Set<net.Socket>();
  const server=net.createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));let buffer=Buffer.alloc(0);socket.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(buffer.length>=4){const size=buffer.readUInt32LE(0);if(buffer.length<size+4)return;const request=JSON.parse(buffer.subarray(4,size+4).toString());buffer=buffer.subarray(size+4);handler(request,socket,result=>{const body=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:request.id,result})),head=Buffer.alloc(4);head.writeUInt32LE(body.length);socket.write(head.subarray(0,2));socket.write(Buffer.concat([head.subarray(2),body]));});}});});
  await new Promise<void>(r=>server.listen(endpoint,r));t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise<void>(r=>server.close(()=>r()));});return endpoint;
}
const toolsList={tools:['create_thread','list_projects','list_threads','read_thread'].map(name=>({name,namespace:'codex_app'}))};
test('desktop tool client discovery is read-only; an explicit create encodes exactly one user request',async t=>{
  const calls:any[]=[];const endpoint=await fakeServer(t,(request,_socket,reply)=>{calls.push(request);reply(request.method==='tools/list'?toolsList:{success:true,contentItems:[{type:'inputText',text:JSON.stringify(request.params.tool==='create_thread'?{threadId:'created',hostId:'local'}:{projects:[]})}]});});
  const client=new DesktopTools(endpoint,()=>({threadId:'source-task',turnId:'source-turn'}));t.after(()=>client.close());assert.equal(await client.discover(),true);await client.listProjects();assert.equal(calls.filter(v=>v.params?.tool==='create_thread').length,0);
  const args={prompt:'user-clicked first message',target:{type:'project',projectId:'saved',environment:{type:'local'}}};assert.equal((await client.createTask(args,'request-1234')).threadId,'created');
  const create=calls.filter(v=>v.params?.tool==='create_thread');assert.equal(create.length,1);assert.deepEqual(create[0].params.arguments,args);assert.equal(create[0].params.threadId,'source-task');assert.equal(create[0].params.callId,'webui-request-1234');
});
test('desktop tool transport disconnect reports unknown result without replaying a create',async t=>{
  let creates=0;const endpoint=await fakeServer(t,(request,socket,reply)=>{if(request.method==='tools/list')reply(toolsList);else{creates++;socket.destroy();}});const client=new DesktopTools(endpoint,()=>({threadId:'source',turnId:'turn'}));t.after(()=>client.close());await client.discover();await assert.rejects(client.createTask({prompt:'x'},'request-1234'),/不能自动重发/);assert.equal(creates,1);
});
test('desktop task errors do not leak raw credential-bearing text to the WebUI',async t=>{
  const endpoint=await fakeServer(t,(request,_socket,reply)=>reply(request.method==='tools/list'?toolsList:{success:false,contentItems:[{type:'inputText',text:'credential=DO_NOT_LEAK'}]}));const client=new DesktopTools(endpoint,()=>({threadId:'source',turnId:'turn'}));t.after(()=>client.close());await client.discover();await assert.rejects(client.listProjects(),(e:Error)=>!e.message.includes('DO_NOT_LEAK')&&e.message.includes('桌面'));
});
