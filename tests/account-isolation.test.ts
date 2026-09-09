import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {EventEmitter} from 'node:events';
import {createApp} from '../src/server';
import {UserStore} from '../src/auth';
import {CodexConsoleService} from '../src/backend/service';
import {permissions,defaultConfig} from '../src/backend/config';
class Peer extends EventEmitter {
 connected=false;serverInfo={userAgent:'protocol-test'};threads:any[]=[];calls:any[]=[];limits=0;
 async connect(){this.connected=true;}close(){this.connected=false;}
 async request(method:string,p:any){this.calls.push({method,p});
  if(method==='thread/start'){const thread={id:'thread-'+(this.threads.length+1),cwd:p.cwd,model:'test-model',modelProvider:'protocol-test',status:'idle'};this.threads.push(thread);return {thread};}
  if(method==='thread/list')return {data:this.threads.filter(t=>!p.cwd||t.cwd===p.cwd),nextCursor:null};
  if(method==='thread/read'||method==='thread/resume')return {thread:this.threads.find(t=>t.id===p.threadId)};
  if(method==='thread/turns/list')return {data:[],nextCursor:null};
  if(method==='account/rateLimits/read'){this.limits++;return {rateLimits:{secondary:{usedPercent:20,windowDurationMins:10080,resetsAt:2000000000}}};}
  if(method==='model/list')return {data:[{id:'test-model',model:'test-model',displayName:'Test model',supportedReasoningEfforts:[{reasoningEffort:'medium'}],defaultReasoningEffort:'medium'}]};
  throw new Error('Unimplemented protocol mock '+method);
 }
}
test('HTTP account isolation: own folders and projectless chats, guessed IDs denied, statistics private, quota fetched once',async t=>{
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'webui-accounts-')),home=path.join(base,'home'),data=path.join(base,'data');await fs.mkdir(home);await fs.mkdir(data);t.mock.method(os,'homedir',()=>home);
 const users=new UserStore(path.join(data,'users.json')),alice=await users.upsert({username:'alice',password:'test-password-long',admin:true}),bob=await users.upsert({username:'bob',password:'test-password-long',admin:true}),carol=await users.upsert({username:'carol',password:'test-password-long',admin:false});
 const peer=new Peer(),runtime=await createApp({host:'127.0.0.1',port:0,origin:'http://127.0.0.1:3210',secureCookies:false,dataDir:data},(c,r)=>new CodexConsoleService(c,r,()=>peer as any));
 await runtime.config.save({...defaultConfig(),enabled:true,defaultOwnerId:alice.id,transport:{type:'unix',endpoint:path.join(base,'test.sock')}});await runtime.service.connect();
 const server=runtime.app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));t.after(async()=>{runtime.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});const origin='http://127.0.0.1:'+(server.address() as any).port;
 async function login(username:string){const response=await fetch(origin+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password:'test-password-long'})});assert.equal(response.status,200);return {cookie:response.headers.get('set-cookie')!.split(';')[0],csrf:(await response.json() as any).csrf};}
 async function call(user:any,url:string,body?:any){const response=await fetch(origin+url,{method:body?'POST':'GET',headers:{cookie:user.cookie,'x-csrf-token':user.csrf,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,data:await response.json() as any};}
 const [a,b,c]=await Promise.all([login('alice'),login('bob'),login('carol')]);const da=await call(a,'/api/codex/projects/default-directory'),db=await call(b,'/api/codex/projects/default-directory'),dc=await call(c,'/api/codex/projects/default-directory');assert.equal(dc.status,200);assert.notEqual(da.data.root,db.data.root);assert.notEqual(dc.data.root,da.data.root);
 const [pa,pb,pc]=await Promise.all(([[a,da],[b,db],[c,dc]] as const).map(([u,d])=>call(u,'/api/codex/projects',{folderName:'same-name',baseRoot:d.data.root,confirmDirectory:true,requestId:'create-project-123'})));for(const p of [pa,pb,pc])assert.equal(p.status,200);assert.notEqual(pa.data.root,pb.data.root);assert.equal(runtime.config.value.projects.length,3);
 const list=await call(b,'/api/codex/projects');assert.deepEqual(list.data.filter((p:any)=>p.kind==='project').map((p:any)=>p.id),[pb.data.id]);assert.equal((await call(b,'/api/codex/files?projectId='+pa.data.id)).status,403);
 const [ta,tb]=await Promise.all([call(a,'/api/codex/threads',{projectId:'projectless',requestId:'new-thread-alice'}),call(b,'/api/codex/threads',{projectId:'projectless',requestId:'new-thread-bob'})]);assert.equal(ta.status,200);assert.equal(tb.status,200);
 const la=await call(a,'/api/codex/threads?projectId=projectless');assert.deepEqual(la.data.data.map((v:any)=>v.id),[ta.data.id]);assert.equal((await call(b,'/api/codex/threads/'+ta.data.id+'?projectId=projectless')).status,403);assert.equal((await call(b,'/api/codex/events?projectId=projectless&threadId='+ta.data.id)).status,403);
 runtime.service.usage!.usage(ta.data.id,{inputTokens:1000,cachedInputTokens:500,outputTokens:50});const privateRows=await call(b,'/api/codex/account/usage/details?range=all&userId='+alice.id);assert.equal(privateRows.data.rows.length,0);const own=await call(a,'/api/codex/account/usage/details?range=all');assert.equal(own.data.rows.length,1);assert.equal((await call(b,'/api/codex/account/usage/records/'+own.data.rows[0].id)).status,404);
 await Promise.all([call(a,'/api/codex/account/usage'),call(b,'/api/codex/account/usage'),call(c,'/api/codex/account/usage')]);assert.equal(peer.limits,1);assert.equal((await call(c,'/api/codex/account/usage/settings')).status,403);assert.equal(peer.calls.filter(c=>c.method==='turn/start').length,0);
});
test('explicit owner overrides an unrelated administrator but preserves a read-only owner grant',()=>{
 const p={id:'p',name:'p',root:'/unused',ownerId:'alice',grants:[{userId:'alice',permissions:['view'] as any}]};assert.equal(permissions(p,{uuid:'bob',elevated:true}).view,false);assert.equal(permissions(p,{uuid:'alice',elevated:false}).view,true);assert.equal(permissions(p,{uuid:'alice',elevated:false}).send,false);
});
