import test from 'node:test';import assert from 'node:assert/strict';import {LocalDevices} from '../src/local-devices';
const catalog=[{name:'local_files_read',description:'Local file',inputSchema:{type:'object'}}];
const rpc=(id:number,method:string,params:any={})=>({jsonrpc:'2.0',id,method,params});
test('daily device MCP routes only to its authenticated account/session and revokes inflight work',async()=>{
 const d=new LocalDevices();let valid=true;try{
 const a=d.create('alice','session-a','task-a','win',catalog,()=>valid),b=d.create('bob','session-b','task-b','win',catalog,()=>true);
 await assert.rejects(d.poll(a.binding.bindingId,'session-b'),/another login/);
 await assert.rejects(d.mcp('unknown',rpc(1,'tools/list')),/expired/);
 const init=await d.mcp(a.token,rpc(1,'initialize',{protocolVersion:'2025-06-18'}));assert.match(init!.result.instructions,/ONLY.*Windows/);
 const pending=d.mcp(a.token,rpc(2,'tools/call',{name:'local_files_read',arguments:{grantId:'grant-a',path:'source.txt'}}));
 const polled=await d.poll(a.binding.bindingId,'session-a');assert.equal(polled.binding?.accountId,'alice');assert.equal(polled.job?.rpc.id,polled.job?.id);assert.notEqual(polled.job?.rpc.id,2);assert.equal(polled.job?.rpc.params.arguments.path,'source.txt');
 assert.throws(()=>d.reply(a.binding.bindingId,'session-b',polled.job!.id,{content:[]}),/another login/);
 d.reply(a.binding.bindingId,'session-a',polled.job!.id,{content:[{type:'text',text:'local fixture'}],isError:false});assert.equal((await pending)!.result.content[0].text,'local fixture');
 assert.throws(()=>d.reply(a.binding.bindingId,'session-a',polled.job!.id,{content:[]}),/no longer pending/);
 const inflight=d.mcp(a.token,rpc(3,'tools/call',{name:'local_files_read',arguments:{}}));d.remove(a.binding.bindingId,'session-a');await assert.rejects(inflight,/expired/);
 assert.deepEqual((await d.mcp(b.token,rpc(4,'tools/list')))!.result.tools,catalog);
 valid=false;await assert.rejects(d.mcp(a.token,rpc(5,'tools/list')),/expired/);
 }finally{d.close();}
});
test('catalog rejects shell tools and pairing replacement invalidates old task token',async()=>{const d=new LocalDevices();try{
 assert.throws(()=>d.create('a','s','t','d',[{...catalog[0],name:'exec_command'}],()=>true),/Only local/);
 const a=d.create('a','s','t','d',catalog,()=>true);const b=d.create('a','s','t','d2',catalog,()=>true);await assert.rejects(d.mcp(a.token,rpc(1,'tools/list')),/expired/);assert.equal((await d.mcp(b.token,rpc(2,'tools/list')))!.result.tools.length,1);
 }finally{d.close();}});
