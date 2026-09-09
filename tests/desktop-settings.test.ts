import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,rename} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {once,EventEmitter} from 'node:events';
import {DesktopModelCatalog,desktopSettings,desktopOverrides,desktopUsage} from '../src/backend/desktop-settings';
import {DesktopSessionService} from '../src/backend/desktop-session';
import {ConfigStore} from '../src/backend/config';
import {CommandReceipts} from '../src/backend/receipts';
const admin={uuid:'admin',elevated:true};
const state=()=>({latestModel:'old',latestReasoningEffort:null,latestThreadSettings:{model:'current',modelProvider:'provider-a',effort:'max',collaborationMode:{mode:'default',settings:{model:'current',reasoning_effort:'max',developer_instructions:'PRIVATE'}}},currentPermissions:{approvalPolicy:'never',sandboxPolicy:{type:'dangerFullAccess'}}});
const model=(name:string)=>({model:name,id:name,displayName:name,defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'max'}]});
const catalog=(names:string[])=>JSON.stringify({models:names.map(slug=>({slug,visibility:'list',display_name:slug,default_reasoning_level:'low',supported_reasoning_levels:[{effort:'low'},{effort:'max'}],base_instructions:'PRIVATE'}))});
test('desktop settings prefer authoritative task settings and never expose private fields',()=>{
  const settings=desktopSettings(state());assert.equal(settings.model,'current');assert.equal(settings.effort,'max');assert.equal(settings.access,'full');
  assert.doesNotMatch(JSON.stringify(settings),/PRIVATE|instruction/);
  assert.deepEqual(desktopUsage({latestTokenUsageInfo:{total:{totalTokens:123},last:{totalTokens:12},modelContextWindow:200000}}),{total:123,last:12,contextWindow:200000});
});
test('default desktop send inherits; stale model/effort/permission form fields are not forwarded',()=>{
  assert.deepEqual(desktopOverrides(state(),{model:'wrong',effort:'low',access:'default'},[],admin,'.'),{});
  assert.throws(()=>desktopOverrides(state(),{settingsOverrides:['provider']},[],admin,'.'),/无效的任务设置/);
  assert.deepEqual(desktopOverrides(state(),{},[],{uuid:'viewer',elevated:false},'.'),{});
});
test('only explicit model changes are forwarded and available efforts are checked',()=>{
  const overrides=desktopOverrides(state(),{model:'next',effort:'low',settingsOverrides:['model','effort']},[model('next')],admin,'.');
  assert.deepEqual(Object.keys(overrides),['collaborationMode']);assert.equal(overrides.collaborationMode.settings.model,'next');assert.equal(overrides.collaborationMode.settings.reasoning_effort,'low');
  assert.equal(overrides.collaborationMode.settings.developer_instructions,'PRIVATE');
  assert.throws(()=>desktopOverrides(state(),{model:'missing',settingsOverrides:['model']},[model('next')],admin,'.'),/不在桌面目录/);
  assert.throws(()=>desktopOverrides(state(),{model:'next',effort:'invalid',settingsOverrides:['model','effort']},[model('next')],admin,'.'),/不支持/);
  assert.throws(()=>desktopOverrides(state(),{access:'full',settingsOverrides:['access']},[],admin,'.'),/确认/);
});
test('configured model catalog wins over stale cache and atomic provider changes notify the UI',async()=>{
  const home=await mkdtemp(path.join(os.tmpdir(),'codex-webui-models-')),external=await mkdtemp(path.join(os.tmpdir(),'codex-webui-provider-'));
  const first=path.join(home,'catalog-a.json'),second=path.join(external,'catalog-b.json');
  await writeFile(first,catalog(['current','next']));await writeFile(second,catalog(['provider-b']));await writeFile(path.join(home,'models_cache.json'),catalog(['stale']));
  const config=(file:string,provider:string)=>`model_catalog_json = ${JSON.stringify(file)}\nmodel_provider = '${provider}'\n[model_providers.private]\napi_key = 'DO_NOT_EXPOSE'\n`;
  await writeFile(path.join(home,'config.toml'),config(first,'provider-a'));
  const reader=new DesktopModelCatalog(home);
  try{
    const result=await reader.read('current');assert.deepEqual(result.data.map((m:any)=>m.model),['current','next']);assert.equal(result.source,'desktop-configured-catalog');assert.equal(result.data[0].isDefault,true);
    assert.doesNotMatch(JSON.stringify(result),/PRIVATE|DO_NOT_EXPOSE|api_key|base_instructions/);
    const changed=once(reader,'changed',{signal:AbortSignal.timeout(5000)});
    await writeFile(path.join(home,'config.next'),config(second,'provider-b'));await rename(path.join(home,'config.next'),path.join(home,'config.toml'));await changed;
    const next=await reader.read('provider-b');assert.deepEqual(next.data.map((m:any)=>m.model),['provider-b']);assert.equal(next.provider,'provider-b');
    const externalChange=once(reader,'changed',{signal:AbortSignal.timeout(5000)});await writeFile(second,catalog(['provider-b','new-model']));await externalChange;
    assert.equal((await reader.read(null)).data.length,2);
    await writeFile(second,'invalid');await assert.rejects(reader.read(null),/暂不可读/);
  }finally{reader.close();}
});
test('desktop snapshot and status stream expose live settings without sending a turn',async()=>{
  const desktop:any=new EventEmitter();Object.assign(desktop,{threadId:'pinned',connected:true,state:{...state(),cwd:process.cwd(),threadRuntimeStatus:{type:'idle'},turns:[]},close(){}});
  const config=new ConfigStore(path.join(os.tmpdir(),'unused-desktop-config.json'));config.value.enabled=true;config.value.projects=[{id:'demo',name:'Demo',root:process.cwd(),grants:[]}];
  const service=new DesktopSessionService(config,new CommandReceipts(path.join(os.tmpdir(),'unused-desktop-receipts.json')),desktop);
  try{const snapshot=await service.snapshot(admin,'demo','pinned');assert.equal(snapshot.settings.model,'current');
    const events:any[]=[];service.hub.subscribe(e=>events.push(e));desktop.state.latestThreadSettings.model='next';desktop.emit('state');
    await new Promise(r=>setTimeout(r,180));assert.ok(events.some(e=>e.type==='status'&&e.payload.settings?.model==='next'));
    assert.equal(service.status(admin).capabilities.createThread,false);
  }finally{service.disconnect();}
});
class Select {
  options:any[]=[];textContent='';hidden=false;title='';disabled=false;
  get value(){return this.options.find(o=>o.selected)?.value||'';}
  set value(v:string){for(const o of this.options)o.selected=o.value===v;}
  get firstChild(){return this.options[0];}
  replaceChildren(...items:any[]){this.options=[];for(const item of items)this.append(item);}
  append(o:any){if(o.selected)for(const prior of this.options)prior.selected=false;else if(!this.options.length)o.selected=true;this.options.push(o);}
  querySelector(selector:string){return this.options.find(o=>selector.includes('value='+o.value));}
}
function ui(){
  const elements:any={};for(const id of ['model','effort','mode','access','settings-source','follow-desktop'])elements[id]=new Select();
  for(const value of ['code','plan'])elements.mode.append({value});for(const value of ['default','read-only','full'])elements.access.append({value});
  const S:any={attachedThreadId:'pinned',models:[],threadSettings:null,settingsOverrides:{},epoch:1};
  const c:any={S,$:(id:string)=>elements[id],el:(_tag:string,label:string)=>({textContent:label,value:'',selected:false}),controls:()=>{},api:async()=>({data:[model('current'),model('next')],settings:desktopSettings(state())})};
  const source=readFileSync(path.join(__dirname,'../public/app.js'),'utf8');vm.runInNewContext(source.slice(source.indexOf('async function loadModels(){'),source.indexOf('async function sendMessage(){')),c);
  return {c,S,elements};
}
test('UI follows live model/effort/permissions, preserves explicit user choices and adds new provider models',async()=>{
  const {c,S,elements}=ui();await c.loadModels();assert.equal(elements.model.value,'current');assert.equal(elements.effort.value,'max');assert.equal(elements.access.value,'full');
  elements.model.value='next';elements.effort.value='low';c.markSettings('model','effort');
  c.applyThreadSettings({...desktopSettings(state()),model:'current',effort:'max',access:'read-only'});
  assert.equal(elements.model.value,'next');assert.equal(elements.effort.value,'low');assert.equal(elements.access.value,'read-only');
  c.api=async()=>({data:[model('new-provider-model')],settings:{...desktopSettings(state()),model:'current'}});await c.loadModels();
  assert.ok(elements.model.options.some((o:any)=>o.value==='new-provider-model'));assert.equal(elements.model.value,'next','do not silently replace a pending user selection');
  S.settingsOverrides={};c.renderThreadSettings();assert.equal(elements.model.value,'current');assert.equal(elements.effort.value,'max');
});

test('desktop immediate send uses guarded turn/steer and preserves the active model/settings',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'webui-desktop-steer-'));const config=new ConfigStore(path.join(root,'config.json'));config.value={...config.value,enabled:true,projects:[{id:'demo',name:'Demo',root,grants:[]}]};
 const calls:any[]=[];const desktop:any=Object.assign(new EventEmitter(),{threadId:'task',connected:true,state:{...state(),cwd:root,threadRuntimeStatus:'inProgress',turns:[{id:'current',turnId:'current',items:[]}]},close(){},request(){throw Error('must not use start/interrupt');}});
 const bridge:any={available:true,async rpc(method:string,params:any){calls.push({method,params});return {turnId:'current'};}};
 const service=new DesktopSessionService(config,new CommandReceipts(path.join(root,'receipts.json')),desktop,new DesktopModelCatalog(root),bridge);
 try{const input={text:'补充',requestId:'desktop-steer-001',delivery:'steer',expectedTurnId:'current'};const result=await service.send(admin,'demo','task',input);assert.equal(result.steered,true);assert.equal(calls[0].method,'turn/steer');assert.equal(calls[0].params.expectedTurnId,'current');assert.equal(calls[0].params.model,undefined);
 await assert.rejects(service.send(admin,'demo','task',{...input,requestId:'desktop-steer-002',expectedTurnId:'stale'}),/轮次已改变/);
 }finally{service.disconnect();}
});
