import {fakeHistoryReader} from './fixtures/history-peer';
import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {EventEmitter} from 'node:events';
import sharp from 'sharp';
import {createApp} from '../src/server';
import {UserStore} from '../src/auth';
import {ProtectedConfigStore} from '../src/protected-config';
import {CodexConsoleService} from '../src/backend/service';
test('real HTTP pipeline restores final/timing/image metadata and enforces generated-image thread ownership',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codex-turn-ui-')),root=path.join(dir,'project'),data=path.join(dir,'data'),home=path.join(dir,'codex-home'),images=path.join(home,'generated_images');for(const p of [root,data,images])await fs.mkdir(p,{recursive:true});
 const prior=process.env.CODEX_HOME;process.env.CODEX_HOME=home;t.after(()=>{if(prior===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=prior;});
 const saved=path.join(images,'generated.png');await sharp({create:{width:1600,height:1000,channels:3,background:'#83a9bb'}}).png().toFile(saved);await fs.writeFile(path.join(root,'result.txt'),'中文交付文件');
 const users=new UserStore(path.join(data,'users.json')),admin=await users.upsert({username:'turn-admin',password:'isolated-turn-test-password',admin:true});await users.upsert({username:'turn-member',password:'isolated-turn-test-password',admin:false});
 const config=new ProtectedConfigStore(path.join(data,'config.json'));await config.save({...config.value,enabled:true,defaultOwnerId:admin.id,transport:{type:'unix',endpoint:path.join(dir,'mock.sock')},projects:[{id:'p',name:'P',root,ownerId:admin.id,grants:[{userId:admin.id,permissions:['view','files','send']}]}]});
 const turn={id:'t',status:'completed',startedAt:100,completedAt:227,items:[{id:'u',type:'userMessage',content:[{type:'text',text:'generate'}]},{id:'g',type:'imageGeneration',savedPath:saved,status:'completed'},{id:'a',type:'agentMessage',phase:'final_answer',text:'[result.txt]('+path.join(root,'result.txt')+')'}]};
 const thread={id:'thread',cwd:root,name:'Turn fixture',status:'idle'};
 class Peer extends EventEmitter{connected=false;serverInfo={userAgent:'test'};async connect(){this.connected=true;}close(){this.connected=false;}async request(method:string,params:any){if(method==='thread/read'||method==='thread/resume')return {thread:params.threadId==='thread'?thread:{...thread,id:'foreign',cwd:path.join(dir,'elsewhere')}};if(method==='thread/turns/list')return {data:[turn]};if(method==='thread/list')return {data:[thread]};return {};}}
 const peer=new Peer(),runtime=await createApp({host:'127.0.0.1',port:3210,origin:'http://127.0.0.1:3210',dataDir:data,secureCookies:false},(c,r)=>new CodexConsoleService(c,r,()=>peer as any,fakeHistoryReader((m,p)=>peer.request(m,p))));await runtime.service.connect();
 const server=runtime.app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));t.after(async()=>{runtime.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
 const base='http://127.0.0.1:'+(server.address() as any).port;let cookie='';const request=(url:string,headers:Record<string,string>={})=>fetch(base+url,{headers:{cookie,...headers}}),url='/api/codex/files/generated-image?projectId=p&threadId=thread&itemId=g&index=0';
 assert.equal((await request(url)).status,401);
 async function login(username:string){const response=await fetch(base+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password:'isolated-turn-test-password'})});assert.equal(response.status,200);cookie=response.headers.get('set-cookie')!.split(';')[0];}
 await login('turn-member');assert.equal((await request(url)).status,403);await login('turn-admin');
 const snap=await runtime.service.snapshot({uuid:admin.id,elevated:true},'p','thread');assert.equal(snap.turns[0].durationMs,127000);assert.equal(snap.items.find(i=>i.id==='a')?.phase,'final_answer');assert.equal(snap.items.find(i=>i.id==='g')?.images?.[0].generated,'generated.png');assert.equal(JSON.stringify(snap).includes(saved),false);
 const thumb=await request(url);assert.equal(thumb.status,200);const metadata=await sharp(Buffer.from(await thumb.arrayBuffer())).metadata();assert.ok(metadata.width!<=384);assert.ok(metadata.height!<=384);
 assert.equal((await request(url,{'if-none-match':thumb.headers.get('etag')!})).status,304);
 const full=await request(url+'&full=1');assert.equal(full.status,200);const fullMeta=await sharp(Buffer.from(await full.arrayBuffer())).metadata();assert.equal(fullMeta.width,1600);assert.equal(fullMeta.height,1000);
 for(const suffix of [url.replace('itemId=g','itemId=a'),url.replace('index=0','index=9'),url.replace('threadId=thread','threadId=foreign')])assert.ok([400,403,404].includes((await request(suffix)).status));
 // A supplied path cannot change the selected artifact.
 const forged=await request(url+'&path=..%2Fsecret.png');assert.equal(forged.status,200);await forged.arrayBuffer();
 const events:any[]=[];const off=runtime.service.hub.subscribe((e:any)=>events.push(e));t.after(()=>off());
 peer.emit('notification',{method:'turn/started',params:{threadId:'thread',turn:{id:'live',status:'inProgress',startedAt:300}}});peer.emit('notification',{method:'item/agentMessage/delta',params:{threadId:'thread',turnId:'live',itemId:'live-a',delta:'stream'}});peer.emit('notification',{method:'item/completed',params:{threadId:'thread',turnId:'live',item:{id:'live-a',type:'agentMessage',text:'final',phase:'final_answer'}}});peer.emit('notification',{method:'turn/completed',params:{threadId:'thread',turn:{id:'live',status:'completed',completedAt:312}}});
 const live=await runtime.service.snapshot({uuid:admin.id,elevated:true},'p','thread');assert.equal(live.turns.find(v=>v.id==='live')?.durationMs,12000);assert.equal(live.items.find(i=>i.id==='live-a')?.turnId,'live');assert.equal(live.items.find(i=>i.id==='live-a')?.phase,'final_answer');assert.ok(events.some(e=>e.type==='status'&&e.payload.turns?.some((v:any)=>v.id==='live'&&v.durationMs===12000)));
});
