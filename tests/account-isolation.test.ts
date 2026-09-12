import {fakeHistoryReader} from './fixtures/history-peer';
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
 connected=false;serverInfo={userAgent:'protocol-test'};threads:any[]=[];calls:any[]=[];limits=0;accounts=0;
 async connect(){this.connected=true;}close(){this.connected=false;}
 async request(method:string,p:any){this.calls.push({method,p});
  if(method==='config/read')return {config:{}};
  if(method==='plugin/installed')return {marketplaces:[]};
  if(method==='mcpServerStatus/list')return {data:[]};
  if(method==='thread/start'){const thread={id:'thread-'+(this.threads.length+1),cwd:p.cwd,model:'test-model',modelProvider:'protocol-test',status:'idle'};this.threads.push(thread);return {thread,approvalPolicy:p.approvalPolicy,activePermissionProfile:{id:p.config?.default_permissions}};}
  if(method==='thread/list')return {data:this.threads.filter(t=>!p.cwd||t.cwd===p.cwd),nextCursor:null};
  if(method==='thread/read'||method==='thread/resume')return {thread:this.threads.find(t=>t.id===p.threadId),approvalPolicy:p.approvalPolicy,activePermissionProfile:{id:p.config?.default_permissions}};
  if(method==='turn/start')return {turn:{id:'isolated-turn',status:'completed'}};
  if(method==='thread/turns/list')return {data:[],nextCursor:null};
  if(method==='account/rateLimits/read'){this.limits++;return {rateLimits:{secondary:{usedPercent:20,windowDurationMins:10080,resetsAt:2000000000}}};}
  if(method==='account/read'){this.accounts++;assert.equal(p.refreshToken,false);return {account:{type:'chatgpt',planType:'pro',subscription:{currentPeriodStart:Date.now()-86400000,currentPeriodEnd:Date.now()+29*86400000}}};}
  if(method==='model/list')return {data:[{id:'test-model',model:'test-model',displayName:'Test model',supportedReasoningEfforts:[{reasoningEffort:'medium'}],defaultReasoningEffort:'medium'}]};
  throw new Error('Unimplemented protocol mock '+method);
 }
}
test('HTTP account isolation: own folders and projectless chats, guessed IDs denied, statistics private, quota fetched once',async t=>{
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'webui-accounts-')),home=path.join(base,'home'),data=path.join(base,'data');await fs.mkdir(home);await fs.mkdir(data);t.mock.method(os,'homedir',()=>home);
 const users=new UserStore(path.join(data,'users.json')),alice=await users.upsert({username:'alice',password:'test-password-long',admin:true}),bob=await users.upsert({username:'bob',password:'test-password-long',admin:true}),carol=await users.upsert({username:'carol',password:'test-password-long',admin:false});
 const peer=new Peer(),runtime=await createApp({host:'127.0.0.1',port:0,origin:'http://127.0.0.1:3210',secureCookies:false,dataDir:data},(c,r)=>new CodexConsoleService(c,r,()=>peer as any,fakeHistoryReader((m,p)=>peer.request(m,p))));
 await runtime.config.save({...defaultConfig(),enabled:true,accountIsolation:true,defaultOwnerId:alice.id,transport:{type:'unix',endpoint:path.join(base,'test.sock')}});await runtime.service.connect();
 const server=runtime.app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));t.after(async()=>{runtime.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});const origin='http://127.0.0.1:'+(server.address() as any).port;
 async function login(username:string){const response=await fetch(origin+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password:'test-password-long'})});assert.equal(response.status,200);return {cookie:response.headers.get('set-cookie')!.split(';')[0],csrf:(await response.json() as any).csrf};}
 async function call(user:any,url:string,body?:any){const response=await fetch(origin+url,{method:body?'POST':'GET',headers:{cookie:user.cookie,'x-csrf-token':user.csrf,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,data:await response.json() as any};}
 const [a,b,c]=await Promise.all([login('alice'),login('bob'),login('carol')]);const da=await call(a,'/api/codex/projects/default-directory'),db=await call(b,'/api/codex/projects/default-directory'),dc=await call(c,'/api/codex/projects/default-directory');assert.equal(dc.status,200);assert.notEqual(da.data.root,db.data.root);assert.notEqual(dc.data.root,da.data.root);
 const [pa,pb,pc]=await Promise.all(([[a,da],[b,db],[c,dc]] as const).map(([u,d])=>call(u,'/api/codex/projects',{folderName:'same-name',baseRoot:d.data.root,confirmDirectory:true,requestId:'create-project-123'})));for(const p of [pa,pb,pc])assert.equal(p.status,200);assert.notEqual(pa.data.root,pb.data.root);assert.equal(runtime.config.value.projects.length,3);
 const list=await call(b,'/api/codex/projects');assert.deepEqual(list.data.filter((p:any)=>p.kind==='project').map((p:any)=>p.id),[pb.data.id]);assert.equal((await call(b,'/api/codex/files?projectId='+pa.data.id)).status,403);
 // Exercise actual HTTP file routes and upload ownership, not only project listings.
 const canary='account-isolation-canary';await fs.writeFile(path.join(pa.data.root,'private.txt'),canary);
 const url=(route:string,projectId:string,name='private.txt')=>'/api/codex/'+route+'?'+new URLSearchParams({projectId,path:name});
 const ownFile=await fetch(origin+url('files/content',pa.data.id),{headers:{cookie:a.cookie}});assert.equal(ownFile.status,200);assert.equal(await ownFile.text(),canary);
 for(const route of ['files/content','files/preview','files/image','files/options']){
  const denied=await call(b,url(route,pa.data.id));assert.equal(denied.status,403,route);assert.ok(!JSON.stringify(denied.data).includes(canary));
 }
 assert.equal((await call(b,'/api/codex/files',{projectId:pa.data.id,name:'intrusion.txt',base64:Buffer.from('blocked').toString('base64')})).status,403);
 assert.equal((await call(b,'/api/codex/uploads',{projectId:pa.data.id,name:'intrusion.txt',size:0,hash:'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'})).status,403);
 for(const escape of [path.join(pa.data.root,'private.txt'),path.relative(pb.data.root,path.join(pa.data.root,'private.txt'))]){
  const denied=await fetch(origin+url('files/content',pb.data.id,escape),{headers:{cookie:b.cookie}});assert.equal(denied.status,400);const error=await denied.json() as any;assert.equal(error.data.code,'INVALID_PATH');assert.ok(!JSON.stringify(error).includes(canary));
 }
 const upload=await call(a,'/api/codex/uploads',{projectId:pa.data.id,name:'empty.txt',size:0,hash:'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'});assert.equal(upload.status,200);
 assert.equal((await call(b,'/api/codex/uploads/'+upload.data.id+'?projectId='+pb.data.id)).status,404);
 assert.equal((await call(b,'/api/codex/uploads/'+upload.data.id+'/commit',{projectId:pb.data.id})).status,404);
 assert.equal((await call(a,'/api/codex/uploads/'+upload.data.id+'/commit',{projectId:pa.data.id})).status,200);
 assert.equal(await fs.readFile(path.join(pa.data.root,'private.txt'),'utf8'),canary);
 // Account library exists without a conversation and accepts only paths within the authenticated account.
 for(const user of [a,b]){
  assert.equal((await call(user,'/api/codex/files?projectId=account-storage')).status,200);
  assert.equal((await call(user,'/api/codex/files/directory',{projectId:'account-storage',path:'.',name:'一级'})).status,200);
  assert.equal((await call(user,'/api/codex/files/directory',{projectId:'account-storage',path:'一级',name:'二级'})).status,200);
 }
 const libraryUpload=await call(a,'/api/codex/uploads',{projectId:'account-storage',path:'一级/二级',name:'original.txt',size:0,hash:'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'});assert.equal(libraryUpload.status,200);
 assert.equal((await call(b,'/api/codex/uploads/'+libraryUpload.data.id+'?projectId=account-storage&path='+encodeURIComponent('一级/二级'))).status,404);
 assert.equal((await call(a,'/api/codex/uploads/'+libraryUpload.data.id+'/commit',{projectId:'account-storage',path:'一级/二级'})).data.path,'一级/二级/original.txt');
 assert.equal((await call(a,'/api/codex/files?projectId=account-storage&path='+encodeURIComponent('一级/二级'))).data.entries.length,1);
 assert.equal((await call(b,'/api/codex/files?projectId=account-storage&path='+encodeURIComponent('一级/二级')+'&userId='+alice.id)).data.entries.length,0);
 const foreign=await fetch(origin+url('files/content','account-storage','一级/二级/original.txt'),{headers:{cookie:b.cookie}});assert.equal(foreign.status,404);
 assert.equal((await call(b,'/api/codex/files/directory',{projectId:'account-storage',path:'../',name:'escape'})).status,400);
 const [ta,tb]=await Promise.all([call(a,'/api/codex/threads',{projectId:'projectless',requestId:'new-thread-alice'}),call(b,'/api/codex/threads',{projectId:'projectless',requestId:'new-thread-bob'})]);assert.equal(ta.status,200);assert.equal(tb.status,200);
 const la=await call(a,'/api/codex/threads?projectId=projectless');assert.deepEqual(la.data.data.map((v:any)=>v.id),[ta.data.id]);assert.equal((await call(b,'/api/codex/threads/'+ta.data.id+'?projectId=projectless')).status,403);assert.equal((await call(b,'/api/codex/events?projectId=projectless&threadId='+ta.data.id)).status,403);
 runtime.service.usage!.usage(ta.data.id,{inputTokens:1000,cachedInputTokens:500,outputTokens:50});const privateRows=await call(b,'/api/codex/account/usage/details?range=all&userId='+alice.id);assert.equal(privateRows.data.rows.length,0);const own=await call(a,'/api/codex/account/usage/details?range=all');assert.equal(own.data.rows.length,1);assert.equal((await call(b,'/api/codex/account/usage/records/'+own.data.rows[0].id)).status,404);
 await Promise.all([call(a,'/api/codex/account/usage'),call(b,'/api/codex/account/usage'),call(c,'/api/codex/account/usage')]);assert.equal(peer.limits,1);assert.equal(peer.accounts,1);const auto=await call(a,'/api/codex/account/usage');assert.equal(auto.data.cycle.configured,true);assert.equal(auto.data.cycle.source,'account/read');assert.equal(auto.data.weeksPerCycle,5);assert.equal((await call(c,'/api/codex/account/usage/settings')).status,403);assert.equal((await call(c,'/api/codex/account/usage/members')).status,403);
 const memberUsage=await call(a,'/api/codex/account/usage/members');assert.equal(memberUsage.status,200);assert.deepEqual(memberUsage.data.members.map((m:any)=>m.username),['alice','bob','carol']);assert.equal(memberUsage.data.members[0].cycleUsage.requests,1);assert.equal(memberUsage.data.members[1].cycleUsage.requests,0);assert.equal(memberUsage.data.members[2].cycleUsage.requests,0);assert.equal(memberUsage.data.total.cycleUsage.requests,1);assert.equal(memberUsage.data.total.cycleUsage.input,1000);assert.equal(memberUsage.data.total.subscriptionPercent,null);assert.doesNotMatch(JSON.stringify(memberUsage.data),/passwordHash|revision|threadId|projectId/);
 assert.equal((await call(b,'/api/codex/account/usage/members')).status,200);assert.equal((await fetch(origin+'/api/codex/account/usage/members')).status,401);assert.equal(peer.limits,1);assert.equal(peer.accounts,1);assert.equal(peer.calls.filter(c=>c.method==='turn/start').length,0);
 const sent=await call(a,'/api/codex/threads/'+ta.data.id+'/messages',{projectId:'projectless',text:'read original',requestId:'isolated-send-acceptance',model:'test-model',effort:'medium',access:'full',confirmFullAccess:true,references:['@account/一级/二级/original.txt'],attachments:[]});assert.equal(sent.status,200,JSON.stringify(sent.data));const turn=peer.calls.find(c=>c.method==='turn/start')!;assert.equal(turn.p.sandboxPolicy,undefined);assert.equal(turn.p.approvalPolicy,'never');assert.ok(turn.p.input[0].text.includes('Account file reference (server original):'));assert.ok(!turn.p.input[0].text.includes('@account/'));const resume=peer.calls.filter(c=>c.method==='thread/resume'&&c.p.config).at(-1);assert.ok(resume?.p.config.default_permissions.startsWith('webui_'));
});
test('explicit owner overrides an unrelated administrator but preserves a read-only owner grant',()=>{
 const p={id:'p',name:'p',root:'/unused',ownerId:'alice',grants:[{userId:'alice',permissions:['view'] as any}]};assert.equal(permissions(p,{uuid:'bob',elevated:true}).view,false);assert.equal(permissions(p,{uuid:'alice',elevated:false}).view,true);assert.equal(permissions(p,{uuid:'alice',elevated:false}).send,false);
});
