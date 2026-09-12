import test from 'node:test';import assert from 'node:assert/strict';import {promises as fs} from 'node:fs';import path from 'node:path';import os from 'node:os';
import {createApp} from '../src/server';import {UserStore} from '../src/auth';
import {ProtectedConfigStore} from '../src/protected-config';
import {CodexConsoleService} from '../src/backend/service';
const tools=[{name:'local_files_read',description:'Local',inputSchema:{type:'object'}}];
test('daily pairing HTTP requires login and CSRF, protects MCP by bearer, and invalidates on logout',async t=>{
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'daily-http-')),users=new UserStore(path.join(data,'users.json'));await users.upsert({username:'admin',password:'local-device-http-test',admin:true});const member=await users.upsert({username:'member',password:'local-device-http-test',admin:false});const projectRoot=data+'-project';await fs.mkdir(projectRoot);const settings=new ProtectedConfigStore(path.join(data,'config.json'));await settings.save({...settings.value,enabled:true,transport:{type:'unix',endpoint:path.join(data,'mock.sock')},projects:[{id:'p',name:'p',root:projectRoot,ownerId:member.id,grants:[{userId:member.id,permissions:['view','send']}]}]});let config:any;
 class Fixture extends CodexConsoleService{override async snapshot(){return{id:'task'} as any;}override async configureLocalTools(_i:any,_p:any,_t:any,c:any){config=c;return{ok:true};}}
 const runtime=await createApp({host:'127.0.0.1',port:3211,origin:'http://127.0.0.1:3211',dataDir:data,secureCookies:false},(c,r)=>new Fixture(c,r)),server=runtime.app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));t.after(()=>{runtime.close();server.closeAllConnections();server.close();});const base='http://127.0.0.1:'+(server.address() as any).port;
 const post=(url:string,body:any,headers:any={})=>fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
 assert.equal((await post('/api/codex/local-devices',{})).status,401);
 const login=await post('/api/login',{username:'member',password:'local-device-http-test'}),auth:any=await login.json(),headers={cookie:login.headers.get('set-cookie')!.split(';')[0],'x-csrf-token':auth.csrf};
 assert.equal((await post('/api/codex/local-devices',{},{cookie:headers.cookie})).status,403);
 const pairing=await post('/api/codex/local-devices',{projectId:'p',threadId:'task',deviceId:'win',tools},headers);assert.equal(pairing.status,200);const pair:any=await pairing.json();assert.equal(pair.binding.accountId,auth.user.id);assert.equal(pair.token,undefined);
 assert.equal(config['mcp_servers.local_files.enabled'],false);const token=config['mcp_servers.local_device_files'].http_headers.Authorization,rpc={jsonrpc:'2.0',id:1,method:'tools/list'};
 assert.equal((await post('/api/local-tools/mcp',rpc,headers)).status,403);assert.equal((await post('/api/local-tools/mcp',rpc,{Authorization:token,Origin:'http://evil.invalid'})).status,403);
 const list=await post('/api/local-tools/mcp',rpc,{Authorization:token});assert.equal(list.status,200);assert.deepEqual((await list.json() as any).result.tools,tools);
 for(const endpoint of ['/api/admin/users','/api/admin/registrations','/api/codex/admin/config'])assert.equal((await fetch(base+endpoint,{headers})).status,403);
 await post('/api/logout',{},headers);assert.equal((await post('/api/local-tools/mcp',rpc,{Authorization:token})).status,403);
});
