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
  const nodes:any={};for(const id of ['project-name','project-path','project-create-directory','project-submit','project-error'])nodes[id]={value:'',disabled:false,hidden:true,textContent:'',checked:false};
  nodes['project-name'].value='Project';nodes['project-path'].value='/safe/project';nodes['project-create-directory'].checked=true;
  nodes['project-form']={elements:Object.values(nodes).filter((n:any)=>'value' in n)};
  nodes['project-dialog']={open:true,close(){this.open=false;}};
  const events:string[]=[],requests:any[]=[];
  const context:any={S:{epoch:1},$:(id:string)=>nodes[id],CodexState:{requestId:()=> 'stable-project-request-123'},confirmAction:()=>{throw new Error('must not open a nested confirmation');},api:async(_url:string,body:any)=>{requests.push(body);return {id:'new-project'};},refreshContext:async()=>events.push('refresh'),chooseProject:async(id:string)=>events.push(id),startNewConversation:async()=>events.push('conversation'),notice:()=>{}};
  const start=source.indexOf('async function createProjectFromForm('),end=source.indexOf("$('project-form').onsubmit=",start);
  assert.ok(start>=0&&end>start);vm.runInNewContext('let projectAttempt=null,projectCreating=false;\n'+source.slice(start,end),context);
  return {context,nodes,events,requests};
}
test('project form submits once without nested confirmation, shows failures inside the modal, and preserves retry ID',async()=>{
  const {context,nodes,events,requests}=browserFixture();let reject!: (e:Error)=>void;
  context.api=async(_url:string,body:any)=>{requests.push(body);return new Promise((_resolve,r)=>reject=r);};
  const first=context.createProjectFromForm();await context.createProjectFromForm();assert.equal(requests.length,1);
  assert.equal(nodes['project-submit'].textContent,'创建中…');assert.ok(nodes['project-form'].elements.every((n:any)=>n.disabled));
  reject(new Error('没有目录写入权限'));await first;
  assert.equal(nodes['project-dialog'].open,true);assert.equal(nodes['project-error'].hidden,false);assert.match(nodes['project-error'].textContent,/写入权限/);
  assert.equal(nodes['project-path'].value,'/safe/project');assert.ok(nodes['project-form'].elements.every((n:any)=>!n.disabled));
  context.api=async(_url:string,body:any)=>{requests.push(body);return {id:'new-project'};};
  await context.createProjectFromForm();assert.equal(requests.length,2);assert.equal(requests[0].requestId,requests[1].requestId);
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
