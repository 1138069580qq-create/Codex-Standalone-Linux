import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs,readFileSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import {ConfigStore,ConsoleError,defaultConfig} from '../src/backend/config';
import {CommandReceipts} from '../src/backend/receipts';
import {CodexConsoleService} from '../src/backend/service';
const source=readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
function browserFixture(){
  const nodes:any={
    'project-name':{value:'Project',disabled:false,focus(){}},
    'project-submit':{disabled:false,textContent:'创建项目'},
    'project-error':{hidden:true,textContent:''},
    'project-base-prefix':{textContent:'/safe/',title:'/safe'},
    'close-project':{disabled:false}
  };
  nodes['project-form']={elements:[nodes['project-name'],nodes['project-submit'],nodes['close-project']]};
  nodes['project-dialog']={open:true,showModal(){this.open=true;},close(){this.open=false;}};
  const events:string[]=[],requests:any[]=[];
  const context:any={S:{epoch:1},$:(id:string)=>nodes[id],CodexState:{requestId:()=> 'stable-project-request-123'},confirmAction:()=>{throw new Error('must not open a nested confirmation');},api:async(_url:string,body:any)=>{requests.push(body);return {id:'new-project'};},refreshContext:async()=>events.push('refresh'),chooseProject:async(id:string)=>events.push(id),startNewConversation:async()=>events.push('conversation'),notice:()=>{}};
  const start=source.indexOf('async function createProjectFromForm('),end=source.indexOf("$('project-form').onsubmit=",start);
  const open=source.indexOf('async function openProjectForm('),openEnd=source.indexOf("$('new-project').onclick=",open);
  assert.ok(start>=0&&end>start&&open>=0&&openEnd>open);
  vm.runInNewContext("let projectAttempt=null,projectCreating=false,projectDirectory={root:'/safe',separator:'/'},projectDirectoryRequest=0;\n"+source.slice(open,openEnd)+source.slice(start,end),context);
  return {context,nodes,events,requests};
}
test('project form submits once without nested confirmation, shows failures inside the modal, and preserves retry ID',async()=>{
  const {context,nodes,events,requests}=browserFixture();let reject!: (e:Error)=>void;
  context.api=async(_url:string,body:any)=>{requests.push(body);return new Promise((_resolve,r)=>reject=r);};
  const first=context.createProjectFromForm();await context.createProjectFromForm();assert.equal(requests.length,1);
  assert.equal(nodes['project-submit'].textContent,'创建中…');assert.ok(nodes['project-form'].elements.every((n:any)=>n.disabled));
  reject(new Error('没有目录写入权限'));await first;
  assert.equal(nodes['project-dialog'].open,true);assert.equal(nodes['project-error'].hidden,false);assert.match(nodes['project-error'].textContent,/写入权限/);
  assert.equal(nodes['project-name'].value,'Project');assert.ok(nodes['project-form'].elements.every((n:any)=>!n.disabled));
  context.api=async(_url:string,body:any)=>{requests.push(body);return {id:'new-project'};};
  await context.createProjectFromForm();assert.equal(requests.length,2);assert.equal(requests[0].requestId,requests[1].requestId);assert.equal(requests[1].folderName,'Project');assert.equal(requests[1].baseRoot,'/safe');assert.equal(requests[1].root,undefined);
  assert.equal(nodes['project-dialog'].open,false);assert.deepEqual(events,['refresh','new-project','conversation']);
});
test('a stale project-create response cannot switch the current conversation',async()=>{
  const {context,nodes,events}=browserFixture();let resolve!:(value:any)=>void;
  context.api=()=>new Promise(r=>resolve=r);const pending=context.createProjectFromForm();context.S.epoch++;
  resolve({id:'stale-project'});await pending;assert.deepEqual(events,[]);assert.equal(nodes['project-dialog'].open,true);
});
test('directory permission failures remain actionable and the same request succeeds after permission is fixed',async t=>{
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'webui-project-submit-')),data=path.join(base,'data'),root=path.join(base,'project');await fs.mkdir(data);
  const config=new ConfigStore(path.join(data,'config.json'));config.value={...defaultConfig(),enabled:true,transport:{type:'unix',endpoint:path.join(base,'codex.sock')}};
  const receiptFile=path.join(data,'receipts.json'),service=new CodexConsoleService(config,new CommandReceipts(receiptFile));t.after(()=>service.disconnect());
  const original=fs.mkdir.bind(fs);const mocked=t.mock.method(fs,'mkdir',async(...args:any[])=>{if(args[0]===root)throw Object.assign(new Error('denied'),{code:'EACCES'});return Reflect.apply(original,fs,args);});
  const body={name:'Project',root,createDirectory:true,confirmDirectory:true,requestId:'project-create-retry-123'},admin={uuid:'admin',elevated:true};
  await assert.rejects(service.createProject(admin,body),(e:unknown)=>e instanceof ConsoleError&&e.code==='PROJECT_DIRECTORY_DENIED');
  assert.deepEqual(JSON.parse(await fs.readFile(receiptFile,'utf8')),[]);mocked.mock.restore();
  const created=await service.createProject(admin,body);assert.ok(created.id);assert.equal(config.value.projects.length,1);
  assert.equal((await service.createProject(admin,body)).id,created.id);assert.equal(config.value.projects.length,1);
  await assert.rejects(service.createProject(admin,{...body,root:path.join(base,'missing-parent','child'),requestId:'missing-parent-123'}),(e:unknown)=>e instanceof ConsoleError&&e.code==='PROJECT_PARENT_MISSING');
});

test('default-prefix loading ignores stale responses, and only a folder name is sent',async()=>{
  const {context,nodes,requests}=browserFixture();const resolve:((v:any)=>void)[]=[];
  context.api=()=>new Promise(r=>resolve.push(r));
  const first=context.openProjectForm(),second=context.openProjectForm();assert.equal(nodes['project-submit'].disabled,true);
  resolve[1]({root:'/new-home',separator:'/'});await second;resolve[0]({root:'/stale-home',separator:'/'});await first;
  assert.equal(nodes['project-base-prefix'].textContent,'/new-home/');assert.equal(nodes['project-submit'].disabled,false);
  context.api=async(_url:string,body:any)=>{requests.push(body);return {id:'folder'};};
  for(const value of ['/1','../escape','nested\\folder']){nodes['project-name'].value=value;await context.createProjectFromForm();assert.equal(requests.length,0);assert.equal(nodes['project-error'].hidden,false);}
  nodes['project-name'].value='文件夹1';await context.createProjectFromForm();assert.equal(requests[0].folderName,'文件夹1');assert.equal(requests[0].baseRoot,'/new-home');assert.equal(requests[0].root,undefined);
});
test('unavailable default directory disables creation and exposes the reason',async()=>{
  const {context,nodes,requests}=browserFixture();context.api=async()=>{throw new Error('默认目录不可写');};
  await context.openProjectForm();assert.equal(nodes['project-submit'].disabled,true);assert.equal(nodes['project-error'].hidden,false);assert.match(nodes['project-error'].textContent,/不可写/);
  await context.createProjectFromForm();assert.equal(requests.length,0);
});
