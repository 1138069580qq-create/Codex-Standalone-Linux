import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {ConfigStore,ConsoleError} from '../src/backend/config';
import {CommandReceipts} from '../src/backend/receipts';
import {DesktopWorkspaceService} from '../src/backend/desktop-workspace';
const admin={uuid:'admin',elevated:true};
async function fixture(){
  const root=await mkdtemp(path.join(os.tmpdir(),'codex-native-features-'));
  const project=path.join(root,'project'),other=path.join(root,'other'),data=path.join(root,'data'),projectless=path.join(root,'chats');
  for(const dir of [project,other,data,projectless])await mkdir(dir);
  const config=new ConfigStore(path.join(data,'config.json'));
  await config.save({enabled:true,transport:{type:'websocket',endpoint:'ws://127.0.0.1:1'},maxConcurrentTurns:1,projects:[{id:'demo',name:'Demo',root:project,grants:[]}]});
  const receipts=new CommandReceipts(path.join(data,'receipts.json'));await receipts.load();const calls:any[]=[];
  const threads=new Map<string,any>([['anchor',{id:'anchor',cwd:project,name:'Anchor',projectId:'project-1',status:{type:'idle'}}]]);
  const projects=[{id:'project-1',name:'Demo',roots:[{path:project}]},{id:'project-2',name:'Other',roots:[{path:other}]}];
  let n=0;const ipcs=new Map<string,any>();
  const makeIpc=(id:string)=>{const t=threads.get(id)!;const ipc:any=Object.assign(new EventEmitter(),{threadId:id,endpoint:'mock',connected:true,state:{cwd:t.cwd,title:t.name,threadRuntimeStatus:t.status,turns:[],latestThreadSettings:{model:'test',effort:'max'},currentPermissions:{sandboxPolicy:{type:'readOnly'},approvalPolicy:'never'}},async connect(){this.connected=true;},close(){this.connected=false;},async request(method:string,params:any,version:number){calls.push({method,params,version});return {result:{result:{turn:{id:'turn'}}}};}});ipcs.set(id,ipc);return ipc;};
  const bridge:any={available:true,async connect(){this.available=true;},close(){this.available=false;},async host(method:string,params:any){calls.push({method,params});if(method==='projectless-workspace-root')return {workspaceRoot:projectless};if(method==='projectless-thread-cwd'){const cwd=path.join(projectless,'chat-'+(++n));await mkdir(cwd);return {cwd};}if(method==='list-pinned-threads')return {threadIds:[]};return {success:true};},async rpc(method:string,params:any){calls.push({method,params});switch(method){
    case 'project/list':return {data:projects};
    case 'project/create':{const p={id:'project-'+(++n+2),name:params.name,roots:params.roots};projects.push(p);return {project:p};}
    case 'thread/read':return {thread:threads.get(params.threadId)};
    case 'thread/list':return {data:[...threads.values()]};
    case 'thread/turns/list':return {data:[]};
    case 'thread/start':{const id='created-'+(++n);const t={id,name:'Created',cwd:params.cwd,projectId:params.projectId,status:{type:'idle'}};threads.set(id,t);return {thread:t,model:params.model||'test',reasoningEffort:'max'};}
    case 'turn/start':return {turn:{id:'turn',status:'inProgress'}};
    case 'thread/fork':{const id='fork-'+(++n),t={...threads.get(params.threadId),id};threads.set(id,t);return {thread:t};}
    case 'skills/list':return {data:[{cwd:params.cwds[0],skills:[{name:'sample',path:path.join(params.cwds[0],'SKILL.md'),enabled:true}]}]};
    case 'plugin/installed':return {marketplaces:[{name:'test-market',plugins:[{id:'test@test-market',name:'test',enabled:true,installed:true}]}]};
    case 'mcpServerStatus/list':return {data:[{name:'test-mcp',tools:{search:{}},authStatus:'oAuth'}]};
    case 'thread/goal/get':case 'thread/goal/set':return {goal:{objective:params.objective||'Goal',status:params.status||'paused'}};
    default:return {ok:true};
  }}};
  const make=()=>new DesktopWorkspaceService(config,receipts,makeIpc('anchor'),undefined,path.join(data,'tasks.json'),undefined,makeIpc,bridge);
  const service=make();service.models=async()=>({data:[{model:'test',supportedReasoningEfforts:[{reasoningEffort:'max'}]}]});await service.connect();
  return {service,bridge,calls,config,threads,projects,ipcs,project,other,data,root,projectless,make};
}
const input=(requestId='native-request-1')=>({requestId,text:'hello from user',environment:'local',confirmCurrentDirectory:true,settingsOverrides:[],extensions:[]});
test('native desktop imports projects and keeps projectless separate with administrator-only ACL',async()=>{
  const f=await fixture();try{const rows=await f.service.refreshProjects(admin);assert.equal(rows.length,3);assert.equal(rows.find(p=>p.id==='demo').desktopProjectId,'project-1');const free=rows.find(p=>p.id==='projectless');assert.equal(free.kind,'projectless');assert.equal(free.permissions.files,false);assert.equal(f.service.projects({uuid:'guest',elevated:false}).length,0);assert.throws(()=>f.service.project({uuid:'guest',elevated:false},'projectless'),/administrator/);assert.throws(()=>f.service.project(admin,'projectless','files'),/文件/);assert.ok(!f.calls.some(c=>['project/create','thread/start','turn/start'].includes(c.method)));}finally{f.service.disconnect();}
});
test('native task uses user source and structured skill/plugin input exactly once, including concurrent duplicate submit',async()=>{
  const f=await fixture();try{const catalog=await f.service.extensions(admin,'demo');assert.equal(catalog.entries.length,2);assert.ok(catalog.entries.every((e:any)=>!e.input));const req={...input(),extensions:catalog.entries.map((e:any)=>e.id),model:'test',effort:'max',mode:'plan',settingsOverrides:['model','effort','mode']};const [a,b]=await Promise.all([f.service.createTask(admin,'demo',req),f.service.createTask(admin,'demo',req)]);assert.equal(a.threadId,b.threadId);assert.equal(a.messageAccepted,true);const start=f.calls.filter(c=>c.method==='thread/start'),turn=f.calls.filter(c=>c.method==='turn/start');assert.equal(start.length,1);assert.equal(turn.length,1);assert.equal(start[0].params.threadSource,'user');assert.equal(start[0].params.projectId,'project-1');assert.equal(start[0].params.developerInstructions,undefined);assert.deepEqual(turn[0].params.input.map((v:any)=>v.type),['text','skill','mention']);assert.equal(turn[0].params.input[2].path,'plugin://test@test-market');assert.equal(turn[0].params.collaborationMode.settings.model,'test');assert.equal(turn[0].params.collaborationMode.mode,'plan');await assert.rejects(f.service.createTask(admin,'demo',{...req,text:'different'}),/改变|另一条/);const disk=await readFile(path.join(f.data,'tasks.json'),'utf8');assert.ok(!disk.includes('"text":'));assert.ok(!disk.includes('"prompt":'));}finally{f.service.disconnect();}
});
test('projectless creation does not inherit an unrelated project and its output attaches to projectless scope',async()=>{
  const f=await fixture();try{const result=await f.service.createTask(admin,'projectless',input());assert.equal(result.messageAccepted,true);assert.equal(result.attached,true);const start=f.calls.find(c=>c.method==='thread/start');assert.equal(start.params.projectId,null);assert.ok(start.params.cwd.startsWith(f.projectless+path.sep));assert.equal((await f.service.listThreads(admin,'demo')).data.some((t:any)=>t.id===result.threadId),false);assert.equal((await f.service.listThreads(admin,'projectless')).data.some((t:any)=>t.id===result.threadId),true);await assert.rejects(f.service.snapshot(admin,'demo',result.threadId),/不属于/);}finally{f.service.disconnect();}
});
test('native invalid skill and unconfirmed permission changes do not create a task',async()=>{
  const f=await fixture();try{await assert.rejects(f.service.createTask(admin,'demo',{...input(),extensions:['a'.repeat(32)]}),/禁用|移除/);await assert.rejects(f.service.createTask(admin,'demo',{...input(),settingsOverrides:['access'],access:'full'}),/确认/);assert.ok(!f.calls.some(c=>c.method==='thread/start'));}finally{f.service.disconnect();}
});
test('native lost turn response is persisted and never re-created or resent on retry/restart',async()=>{
  const f=await fixture();let other:any;try{const rpc=f.bridge.rpc.bind(f.bridge);f.bridge.rpc=async(m:string,p:any)=>{if(m==='turn/start'){f.calls.push({method:m,params:p});throw new ConsoleError(504,'DESKTOP_OUTCOME_UNKNOWN','timeout');}return rpc(m,p);};const a=await f.service.createTask(admin,'demo',input());assert.equal(a.messageAccepted,null);const b=await f.service.createTask(admin,'demo',input());assert.equal(b.threadId,a.threadId);other=f.make();await other.connect();await other.createTask(admin,'demo',input());assert.equal(f.calls.filter(c=>c.method==='thread/start').length,1);assert.equal(f.calls.filter(c=>c.method==='turn/start').length,1);}finally{other?.disconnect();f.service.disconnect();}
});
test('projects create from an existing or single new directory, persist imports, and reject private/overlap paths',async()=>{
  const f=await fixture();try{const target=path.join(f.root,'new-project');const p=await f.service.createProject(admin,{name:'New',root:target,createDirectory:true,confirmDirectory:true,requestId:'project-request-1'});assert.equal(p.root,target);assert.ok(f.config.value.projects.some(v=>v.root===target));await f.service.createProject(admin,{name:'New',root:target,createDirectory:true,confirmDirectory:true,requestId:'project-request-1'});assert.equal(f.calls.filter(c=>c.method==='project/create').length,1);await assert.rejects(f.service.createProject(admin,{name:'Bad',root:path.join(f.data,'secret'),createDirectory:true,confirmDirectory:true,requestId:'project-request-2'}),/私有/);}finally{f.service.disconnect();}
});
test('slash actions use native operations, require confirmation, and never send model text for rename/pin/fork',async()=>{
  const f=await fixture();try{await assert.rejects(f.service.taskAction(admin,'demo','anchor','review',{requestId:'action-request-1',target:'uncommittedChanges'}),/确认/);for(const kind of ['rename','pin','fork','side','compact','review','feedback']){const result=await f.service.taskAction(admin,'demo','anchor',kind,{requestId:'action-request-'+kind,confirmed:true,name:'Renamed',pinned:true,target:'baseBranch',branch:'main',reason:'test feedback'});assert.equal(result.ok,true);}assert.ok(f.calls.some(c=>c.method==='thread/name/set'&&c.params.name==='Renamed'));assert.ok(f.calls.some(c=>c.method==='set-thread-pinned'));assert.ok(f.calls.some(c=>c.method==='thread-follower-compact-thread'));assert.ok(f.calls.some(c=>c.method==='review/start'&&c.params.delivery==='inline'));assert.ok(f.calls.some(c=>c.method==='thread/fork'&&c.params.ephemeral===true&&c.params.deferGoalContinuation===true));assert.ok(!f.calls.some(c=>c.method==='turn/start'));const feedback=f.calls.find(c=>c.method==='feedback/upload');assert.equal(feedback.params.includeLogs,false);assert.deepEqual(feedback.params.extraLogFiles,[]);assert.deepEqual((await f.service.mcp(admin,'demo','anchor')).data[0].tools,['search']);}finally{f.service.disconnect();}
});
test('existing desktop sends selected skills/plugins through actual follower input, not text-only substitution',async()=>{
  const f=await fixture();try{const c=await f.service.extensions(admin,'demo');await f.service.send(admin,'demo','anchor',{...input(),extensions:c.entries.map((e:any)=>e.id)});const call=f.calls.find(c=>c.method==='thread-follower-start-turn');assert.deepEqual(call.params.turnStart.request.input.map((i:any)=>i.type),['text','skill','mention']);assert.equal(call.params.turnStart.context.inheritThreadSettings,true);}finally{f.service.disconnect();}
});
