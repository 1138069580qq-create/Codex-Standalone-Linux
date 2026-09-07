import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, stat } from "node:fs/promises";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { CodexRpcClient } from "../src/backend/transport";
import { discoverExistingCodex } from "../src/backend/discovery";
import { UserStore } from "../src/auth";
import { ProtectedConfigStore } from "../src/protected-config";
import { createApp } from "../src/server";
async function freePort() { const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as any).port;await new Promise<void>(resolve=>server.close(()=>resolve()));return port; }
const binary=process.env.CODEX_TEST_BINARY;
for (const type of ['unix','websocket'] as const) test(`real Codex ${type}: initialize, model list, production HTTP and attach-only disconnect`,{
  skip:!binary || process.env.CODEX_TEST_ISOLATED!=='1' || (type==='unix'&&process.platform!=='linux'), timeout:60_000
},async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'codex-webui-real-'));
  const home=path.join(directory,'codex-home'),project=path.join(directory,'project'),data=path.join(directory,'webui-data');
  await Promise.all([mkdir(home),mkdir(project),mkdir(data)]);
  const endpoint=type==='unix'?path.join(directory,'app-server.sock'):`ws://127.0.0.1:${await freePort()}`;
  const listen=type==='unix'?`unix://${endpoint}`:endpoint;
  const version=execFileSync(binary!,['--version'],{encoding:'utf8'}).trim();
  let stderr='';
  // Test-only real process. Production src/ never imports this or launches Codex.
  const child=spawn(binary!,['app-server','--listen',listen],{env:{...process.env,CODEX_HOME:home},stdio:['ignore','ignore','pipe']});
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-8000);});
  t.after(async()=>{if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([once(child,'exit'),new Promise(r=>setTimeout(r,3000))]);if(child.exitCode===null)child.kill('SIGKILL');}});
  let peer:CodexRpcClient|undefined;
  for(let i=0;i<60;i++){
    if(child.exitCode!==null)throw new Error(`Real Codex exited ${child.exitCode}: ${stderr}`);
    if(type==='unix' && !await stat(endpoint).catch(()=>null)){await new Promise(r=>setTimeout(r,100));continue;}
    const attempt=new CodexRpcClient({type,endpoint,connectTimeoutMs:1000,requestTimeoutMs:5000});
    try{await attempt.connect();peer=attempt;break;}catch{attempt.close();await new Promise(r=>setTimeout(r,100));}
  }
  assert.ok(peer,`Real Codex failed to initialize: ${stderr}`);t.after(()=>peer?.close());
  const models=await peer.request<any>('model/list',{limit:10});assert.ok(Array.isArray(models.data));assert.ok(models.data.length);
  const discovered=await discoverExistingCodex({roots:[directory],ssOutput:'',maxCandidates:4});
  if(type==='unix')assert.ok(discovered.some(e=>e.endpoint===endpoint&&e.verified));
  const users=new UserStore(path.join(data,'users.json'));
  await users.upsert({username:'admin',password:'real-test-password-only',admin:true});
  const config=new ProtectedConfigStore(path.join(data,'config.json'));
  await config.save({enabled:true,transport:{type,endpoint},maxConcurrentTurns:2,projects:[{id:'live',name:'Real Codex',root:project,grants:[]}]});
  const origin='http://127.0.0.1:3210';const runtime=await createApp({dataDir:data,host:'127.0.0.1',port:3210,origin,secureCookies:false});
  const http=runtime.app.listen(0,'127.0.0.1');await once(http,'listening');
  t.after(async()=>{runtime.close();http.closeAllConnections();await new Promise<void>(resolve=>http.close(()=>resolve()));});
  const base=`http://127.0.0.1:${(http.address() as any).port}`;
  const login=await fetch(base+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'admin',password:'real-test-password-only'})});
  const cookie=login.headers.get('set-cookie')!.split(';')[0],csrf=(await login.json() as any).csrf;
  async function api(route:string,body?:any){const r=await fetch(base+'/api/codex'+route,{method:body===undefined?'GET':'POST',headers:{cookie,'x-csrf-token':csrf,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const value=await r.json();assert.equal(r.status,200,JSON.stringify(value));return value as any;}
  assert.equal((await api('/status')).connected,false); // HTTP startup must not auto-attach/start Codex.
  assert.equal((await api('/admin/connect',{})).connected,true);
  assert.ok((await api('/models')).data.length);
  assert.ok(Array.isArray((await api('/threads?projectId=live')).data));
  const created=await api('/threads',{projectId:'live',title:'Real protocol test — no model turn'});assert.ok(created.id);
  // Read a thread through the actual WebUI snapshot/SSE path (no canned backend).
  const snapshot=await api(`/threads/${created.id}?projectId=live`);assert.equal(snapshot.id,created.id);assert.ok(Array.isArray(snapshot.items));
  const abort=new AbortController();
  const stream=await fetch(`${base}/api/codex/events?projectId=live&threadId=${created.id}`,{headers:{cookie},signal:abort.signal});
  assert.equal(stream.headers.get('content-type')?.includes('text/event-stream'),true);
  const reader=stream.body!.getReader();const frame=await reader.read();assert.match(new TextDecoder().decode(frame.value),/event: codex/);abort.abort();
  await api('/admin/disconnect',{});assert.equal(child.exitCode,null);
  assert.ok((await peer.request<any>('model/list',{limit:1})).data.length);
  t.diagnostic(JSON.stringify({version,transport:type,isolatedHome:true,modelInvocation:false,desktopSharedEndpoint:false,project:directory}));
});
