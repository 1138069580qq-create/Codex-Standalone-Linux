import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {UserStore} from '../src/auth';
import {createApp} from '../src/server';
import {mkdtemp,mkdir,readFile} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';
import {ConfigStore,ConsoleError} from '../src/backend/config';
import {CommandReceipts} from '../src/backend/receipts';
import {DesktopWorkspaceService} from '../src/backend/desktop-workspace';
import {DesktopSessionService} from '../src/backend/desktop-session';
import {DesktopModelCatalog} from '../src/backend/desktop-settings';
const admin={uuid:'admin',elevated:true};
function ipc(id:string,cwd:string):any {return Object.assign(new EventEmitter(),{threadId:id,endpoint:'unused',connected:true,state:{id,cwd,title:id,threadRuntimeStatus:{type:'idle'},turns:[],latestThreadSettings:{model:'test-model',effort:'max'},currentPermissions:{sandboxPolicy:{type:'readOnly'},approvalPolicy:'never'}},async connect(){this.connected=true;},close(){this.connected=false;}});}
async function fixture(){
  const root=await mkdtemp(path.join(os.tmpdir(),'codex-newtask-')),project=path.join(root,'project'),data=path.join(root,'data');await mkdir(project);await mkdir(data);
  const config=new ConfigStore(path.join(data,'config.json'));await config.save({enabled:true,transport:{type:'websocket',endpoint:'ws://127.0.0.1:1'},maxConcurrentTurns:1,projects:[{id:'demo',name:'Demo',root:project,grants:[]}]});
  const anchor=ipc('anchor',project),receipts=new CommandReceipts(path.join(data,'receipts.json'));const calls:any[]=[];
  const tools:any={async discover(){return true;},async listProjects(){return {projects:[{projectId:'saved',projectKind:'local',path:project,isGitRepository:true}]};},async listThreads(){return {threads:[],pinnedThreads:[]};},async readThread(id:string){return {thread:{id,kind:'codex',hostId:'local',cwd:project,title:'Created task',status:{type:'idle'}}};},async createTask(args:any,key:string){calls.push({args,key});return {threadId:'new-task',hostId:'local'};},close(){}};
  const modelCatalog=new DesktopModelCatalog(root);modelCatalog.read=async()=>({data:[{id:'test-model',model:'test-model',displayName:'Test',isDefault:true,defaultReasoningEffort:'max',supportedReasoningEfforts:[{reasoningEffort:'max'}],contextWindow:null}],source:'test',provider:null});
  const factory=(endpoint:any)=>new DesktopSessionService(config,receipts,endpoint,modelCatalog),make=()=>new DesktopWorkspaceService(config,receipts,anchor,tools,path.join(data,'tasks.json'),factory,id=>ipc(id,project));
  const service=make();await service.connect();return {service,tools,calls,make,config,project,data};
}
const input=(requestId='request-1234')=>({requestId,text:'Build the user request',environment:'local',confirmCurrentDirectory:true,settingsOverrides:[]});
test('desktop creation requires current-directory confirmation and project authorization before any write',async()=>{
  const {service,calls}=await fixture();try{assert.equal(service.status(admin).capabilities.createWithMessage,true);assert.equal(service.projects(admin)[0].canCreateTask,true);
    await assert.rejects(service.createTask(admin,'demo',{...input(),confirmCurrentDirectory:false}),/确认/);
    await assert.rejects(service.createTask({uuid:'guest',elevated:false},'demo',input()),/access denied/);
    await assert.rejects(service.createTask(admin,'demo',{...input(),settingsOverrides:['access']}),/只能选择模型/);
    assert.equal(calls.length,0);
  }finally{service.disconnect();}
});
test('one desktop create carries the first message; repeat and concurrent requests do not create or send twice',async()=>{
  const {service,tools,calls}=await fixture();let release:()=>void=()=>{};const wait=new Promise<void>(r=>release=r),original=tools.createTask;tools.createTask=async(...args:any[])=>{await wait;return original(...args);};
  try{const first=service.createTask(admin,'demo',input()),second=service.createTask(admin,'demo',input());release();const [a,b]=await Promise.all([first,second]);
    assert.equal(a.thread.id,'new-task');assert.equal(b.thread.id,'new-task');assert.equal(a.messageAccepted,true);assert.equal(calls.length,1);
    assert.equal(calls[0].args.prompt,input().text);assert.deepEqual(calls[0].args.target,{type:'project',projectId:'saved',environment:{type:'local'}});assert.equal(calls[0].args.model,undefined);
    const again=await service.createTask(admin,'demo',input());assert.equal(again.thread.id,'new-task');assert.equal(calls.length,1);
    await assert.rejects(service.createTask(admin,'demo',{...input(),text:'changed'}),/另一条消息/);
    assert.equal((await service.snapshot(admin,'demo','anchor')).id,'anchor');assert.equal((await service.snapshot(admin,'demo','new-task')).id,'new-task');
  }finally{service.disconnect();}
});
test('timeout outcome is durable: reload and check never recreate, and the disk does not store prompts',async()=>{
  const {service,tools,calls,make,data}=await fixture();tools.createTask=async()=>{calls.push('create');throw new ConsoleError(504,'DESKTOP_TOOLS_TIMEOUT','timeout');};
  try{const unknown=await service.createTask(admin,'demo',input());assert.equal(unknown.status,'unknown');assert.equal(calls.length,1);
    const saved=await readFile(path.join(data,'tasks.json'),'utf8');assert.doesNotMatch(saved,/Build the user request/);assert.match(saved,/fingerprint/);
    service.disconnect();const restored=make();await restored.connect();try{const result=await restored.taskCreation(admin,'request-1234');assert.equal(result.status,'unknown');await restored.createTask(admin,'demo',input());assert.equal(calls.length,1);}finally{restored.disconnect();}
  }finally{service.disconnect();}
});
test('created task whose first turn was rejected remains selectable without replaying the prompt',async()=>{
  const {service,tools}=await fixture();tools.createTask=async()=>({status:'created',conversationId:'new-task',hostId:'local',firstTurn:{status:'rejected'}});
  try{const result=await service.createTask(admin,'demo',input());assert.equal(result.status,'ready');assert.equal(result.messageAccepted,false);assert.equal(result.thread.id,'new-task');assert.match(result.message,/首条消息未开始/);}finally{service.disconnect();}
});
test('failed attachment can be recovered through read-only creation status, never a second create',async()=>{
  const {service,tools,calls}=await fixture();const read=tools.readThread;let failed=true;tools.readThread=async(id:string)=>{if(failed)throw new Error('not ready');return read(id);};
  try{const result=await service.createTask(admin,'demo',input());assert.equal(result.threadId,'new-task');assert.equal(result.attached,false);failed=false;
    const recovered=await service.taskCreation(admin,'request-1234');assert.equal(recovered.thread.id,'new-task');assert.equal(calls.length,1);
    await assert.rejects(service.taskCreation({uuid:'different-admin',elevated:true},'request-1234'),/未找到/);
    tools.readThread=async(id:string)=>({thread:{id,kind:'codex',hostId:'local',cwd:os.tmpdir()}});await assert.rejects(service.snapshot(admin,'demo','unrelated'),/不属于此项目/);
  }finally{service.disconnect();}
});
test('pending client IDs are not passed to desktop task read/attach APIs',async()=>{
  const {service,tools}=await fixture();tools.createTask=async()=>({clientThreadId:'client-new-thread:pending',hostId:'local'});tools.readThread=async()=>{throw new Error('must not read client ID');};
  try{const result=await service.createTask(admin,'demo',input());assert.equal(result.status,'unknown');assert.equal(result.clientThreadId,'client-new-thread:pending');assert.equal(result.thread,undefined);}finally{service.disconnect();}
});

test('same-directory creation is blocked while another task is running',async()=>{
  const {service,calls}=await fixture();service.anchor.state.threadRuntimeStatus={type:'active'};
  try{await assert.rejects(service.createTask(admin,'demo',input()),/已有任务运行/);assert.equal(calls.length,0);}finally{service.disconnect();}
});
test('production creation routes enforce auth and CSRF and recover by GET without another create',async t=>{
  const {service,calls,data}=await fixture();const users=new UserStore(path.join(data,'users.json'));await users.upsert({username:'test-admin',password:'test-password-only',admin:true});
  const runtime=await createApp({host:'127.0.0.1',port:3210,origin:'http://127.0.0.1:3210',dataDir:data,secureCookies:false},()=>service);
  const server=runtime.app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));t.after(async()=>{runtime.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
  const base='http://127.0.0.1:'+(server.address() as any).port,body={...input(),projectId:'demo'};
  const request=(route:string,body?:any,headers:any={})=>fetch(base+route,{method:body?'POST':'GET',headers:{'content-type':'application/json',...headers},body:body?JSON.stringify(body):undefined});
  assert.equal((await request('/api/codex/task-creations',body)).status,401);
  const login=await request('/api/login',{username:'test-admin',password:'test-password-only'}),cookie=login.headers.get('set-cookie')!.split(';')[0],session=await login.json() as any;
  assert.equal((await request('/api/codex/task-creations',body,{cookie})).status,403);assert.equal(calls.length,0);
  const response=await request('/api/codex/task-creations',body,{cookie,'x-csrf-token':session.csrf});assert.equal(response.status,200);const created=await response.json() as any;assert.equal(created.thread.id,'new-task');assert.equal(calls.length,1);
  const check=await request('/api/codex/task-creations/'+body.requestId,undefined,{cookie});assert.equal(check.status,200);assert.equal((await check.json() as any).thread.id,'new-task');assert.equal(calls.length,1);
});
