import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {UserStore} from '../src/auth';
import {ProtectedConfigStore} from '../src/protected-config';
import {CodexConsoleService} from '../src/backend/service';
import {createApp} from '../src/server';

test('HTTP recovery reattaches existing backend, preserves ACL/manual disconnect and enforces admin reset with CSRF/idempotency',async t=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'webui-reconnect-')),data=path.join(base,'data'),project=path.join(base,'project'),home=path.join(base,'home');await mkdir(data);await mkdir(project);await mkdir(home);t.mock.method(os,'homedir',()=>home);
 const users=new UserStore(path.join(data,'users.json'));const admin=await users.upsert({username:'admin',password:'fixture-password',admin:true}),member=await users.upsert({username:'member',password:'fixture-password',admin:false});
 const config=new ProtectedConfigStore(path.join(data,'config.json'));await config.save({...config.value,enabled:true,defaultOwnerId:admin.id,transport:{type:'unix',endpoint:path.join(base,'mock.sock')},projects:[{id:'p',name:'P',root:project,ownerId:member.id,grants:[]}]});
 class Peer extends EventEmitter{
  connected=false;connects=0;resets=0;writes=0;serverInfo={userAgent:'protocol-mock'};calls:string[]=[];
  async connect(){this.connects++;await new Promise(r=>setTimeout(r,20));this.connected=true;}close(){this.connected=false;}
  drop(){this.connected=false;this.emit('disconnect');}
  async request(method:string,p:any={}){this.calls.push(method);if(method==='thread/read'||method==='thread/resume')return {thread:{id:p.threadId,cwd:project,name:'Existing',status:'idle',turns:[]}};if(method==='thread/turns/list'||method==='thread/list')return {data:[]};
   if(method==='account/read')return {account:{type:'chatgpt',planType:'pro'}};
   if(method==='account/rateLimits/read')return {rateLimits:{secondary:{usedPercent:20,windowDurationMins:10080,resetsAt:2000000000}},rateLimitResetCredits:{availableCount:this.resets?0:1,details:[]}};
   if(method==='account/rateLimitResetCredit/consume'){this.resets++;return {outcome:'reset'};}
   if(method.startsWith('turn/')||method==='thread/start')this.writes++;
   throw Error('Unexpected RPC '+method);
  }
 }
 const peer=new Peer();const runtime=await createApp({host:'127.0.0.1',port:3210,origin:'http://127.0.0.1:3210',dataDir:data,secureCookies:false},(c,r)=>new CodexConsoleService(c,r,()=>peer as any));await runtime.service.connect();
 const server=runtime.app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));t.after(async()=>{runtime.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});const origin='http://127.0.0.1:'+(server.address() as any).port;
 const login=async(username:string)=>{const r=await fetch(origin+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password:'fixture-password'})});assert.equal(r.status,200);const body=await r.json() as any;return {cookie:r.headers.get('set-cookie')!.split(';')[0],'x-csrf-token':body.csrf};};
 const a=await login('admin'),m=await login('member');const call=(who:any,url:string,body?:any,extra:any={})=>fetch(origin+url,{method:body===undefined?'GET':'POST',headers:{...who,'content-type':'application/json',...extra},body:body===undefined?undefined:JSON.stringify(body)});
 assert.equal((await (await call(m,'/api/codex/status')).json() as any).capabilities.resetQuota,false);assert.equal((await (await call(a,'/api/codex/status')).json() as any).capabilities.resetQuota,true);
 peer.drop();const before=peer.connects;assert.equal((await call(a,'/api/codex/threads/existing?projectId=forbidden')).status,403);assert.equal(peer.connects,before);
 const reads=await Promise.all([call(m,'/api/codex/threads/existing?projectId=p'),call(m,'/api/codex/threads/existing?projectId=p')]);assert.ok(reads.every(r=>r.status===200));const snapshot=await reads[0].json() as any;assert.equal(snapshot.connection.connected,true);assert.equal(peer.connects,before+1);assert.equal(peer.writes,0);
 const abort=new AbortController();const stream=await fetch(origin+'/api/codex/events?projectId=p&threadId=existing&cursor='+encodeURIComponent(snapshot.cursor),{headers:m,signal:abort.signal});assert.equal(stream.status,200);assert.match(stream.headers.get('content-type')!,/text\/event-stream/);assert.match(new TextDecoder().decode((await stream.body!.getReader().read()).value),/connected/);abort.abort();
 assert.equal((await call(m,'/api/codex/account/usage/members')).status,403);assert.equal((await call(a,'/api/codex/account/usage/members')).status,200);
 assert.equal((await call(m,'/api/codex/account/limits/reset',{requestId:'member-denied'})).status,403);assert.equal(peer.resets,0);
 assert.equal((await call(a,'/api/codex/account/limits/reset',{requestId:'csrf-denied'},{'x-csrf-token':''})).status,403);assert.equal((await call(a,'/api/codex/account/limits/reset',{requestId:'origin-denied'},{origin:'https://wrong.test'})).status,403);
 for(let i=0;i<2;i++){const reset=await call(a,'/api/codex/account/limits/reset',{requestId:'same-reset-id'});assert.equal(reset.status,200);assert.equal((await reset.json() as any).outcome,'reset');}assert.equal(peer.resets,1);
 assert.equal((await call(a,'/api/codex/admin/disconnect',{})).status,200);const stopped=peer.connects;const paused=await call(m,'/api/codex/threads/existing?projectId=p');assert.equal(paused.status,503);assert.equal((await paused.json() as any).data.code,'CODEX_DISCONNECTED');assert.equal(peer.connects,stopped);
 assert.equal((await call(m,'/api/codex/admin/connect',{})).status,403);assert.equal((await call(a,'/api/codex/admin/connect',{})).status,200);assert.equal((await call(m,'/api/codex/threads/existing?projectId=p')).status,200);assert.equal(peer.writes,0);
});

test('reset-card UI has no ordinary-member action and rechecks the account after confirmation',async()=>{
 const source=readFileSync('public/app.js','utf8'),nodes:Record<string,any>={};const el=(tag:string,text?:string):any=>({tag,textContent:text||'',children:[],append(...v:any[]){this.children.push(...v);},replaceChildren(){this.children=[];}});let writes=0;
 const context:any=vm.createContext({S:{user:{id:'m',admin:false}},$: (id:string)=>nodes[id]??=el('div'),el,Date,CodexState:{windowLabel:()=>'',requestId:()=>'safe-request-id'},shortDate:String,supports:()=>true,action:(f:Function)=>f,confirmAction:async()=>true,api:async()=>{writes++;return {outcome:'reset',rateLimits:{windows:[],resetCredits:{availableCount:0,details:[]}}};},toast:()=>{}});
 vm.runInContext(source.slice(source.indexOf('function renderQuota('),source.indexOf('function shortDate(')),context);context.limits={windows:[],resetCredits:{availableCount:1,details:[{id:'card',expiresAt:null}]}};
 vm.runInContext('renderQuota(limits)',context);const findButtons=(n:any):any[]=>[...(n.tag==='button'?[n]:[]),...(n.children||[]).flatMap(findButtons)];assert.equal(findButtons(nodes['quota-detail-content']).length,0);assert.match(JSON.stringify(nodes),/仅管理员/);
 context.S.user={id:'a',admin:true};vm.runInContext('renderQuota(limits)',context);const button=findButtons(nodes['quota-detail-content'])[0];assert.equal(button.disabled,false);context.confirmAction=async()=>{context.S.user={id:'m',admin:false};return true;};await assert.rejects(button.onclick(),/权限或账户已改变/);assert.equal(writes,0);
 context.S.user={id:'a',admin:true};context.confirmAction=async()=>true;await button.onclick();assert.equal(writes,1);
});
