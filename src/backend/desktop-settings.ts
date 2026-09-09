import { promises as fs, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { parse } from 'smol-toml';
import { ConsoleError, type Identity } from './config';
import { accessPolicy } from './extensions';

const text=(v:unknown)=>typeof v==='string'?v.slice(0,200):null;
const count=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:0;
export function desktopSettings(state:any) {
  const latest=state?.latestThreadSettings||{}, collaboration=latest.collaborationMode||state?.latestCollaborationMode||{};
  const permission=state?.currentPermissions||latest, sandbox=permission.sandboxPolicy||{};
  return {source:'desktop-thread',model:text(latest.model??collaboration.settings?.model??state?.latestModel),
    effort:text(latest.effort??collaboration.settings?.reasoning_effort??state?.latestReasoningEffort),
    provider:text(latest.modelProvider??state?.modelProvider),mode:collaboration.mode==='plan'?'plan':'code',
    access:sandbox.type==='dangerFullAccess'?'full':sandbox.type==='readOnly'?'read-only':sandbox.type==='workspaceWrite'?'default':'custom',
    sandboxType:text(sandbox.type),approvalPolicy:text(permission.approvalPolicy)};
}
export function desktopUsage(state:any) {
  const info=state?.latestTokenUsageInfo;if(!info)return null;
  return {total:count(info.total?.totalTokens),last:count(info.last?.totalTokens),contextWindow:count(info.modelContextWindow)||null};
}
async function readBounded(file:string,max:number){const h=await fs.open(file,'r');try{if((await h.stat()).size>max)throw new Error('Metadata file too large');return await h.readFile('utf8');}finally{await h.close();}}

/** Only returns model metadata. Never exports config, credentials, model instructions or provider URLs. */
export class DesktopModelCatalog extends EventEmitter {
  private watchers:FSWatcher[]=[];
  private watched='';private timer?:NodeJS.Timeout;
  constructor(readonly home=process.env.CODEX_HOME||path.join(os.homedir(),'.codex')){super();}
  async read(currentModel:string|null) {
    const configFile=path.join(this.home,'config.toml');let config:any={};
    try{config=parse(await readBounded(configFile,1024*1024));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw new ConsoleError(503,'MODEL_CONFIG_UNAVAILABLE','无法读取桌面模型配置，请稍后刷新。');}
    const configured=typeof config.model_catalog_json==='string'&&config.model_catalog_json.trim()?config.model_catalog_json:null;
    const file=configured?path.resolve(this.home,configured):path.join(this.home,'models_cache.json');
    this.observe([configFile,file]);
    let catalog:any;
    try{catalog=JSON.parse(await readBounded(file,16*1024*1024));}catch{throw new ConsoleError(503,'MODEL_CATALOG_UNAVAILABLE','桌面模型目录暂不可读，请稍后刷新。');}
    if(!Array.isArray(catalog.models))throw new ConsoleError(503,'MODEL_CATALOG_UNAVAILABLE','桌面模型目录格式无效。');
    const seen=new Set<string>();
    const data=catalog.models.filter((m:any)=>m&&m.visibility==='list'&&typeof m.slug==='string'&&m.slug.length<=200&&!seen.has(m.slug)&&seen.add(m.slug)).slice(0,200).map((m:any)=>({
      id:m.slug,model:m.slug,displayName:text(m.display_name)||m.slug,isDefault:m.slug===(currentModel||config.model),
      defaultReasoningEffort:text(m.default_reasoning_level),supportedReasoningEfforts:(Array.isArray(m.supported_reasoning_levels)?m.supported_reasoning_levels:[]).map((r:any)=>({reasoningEffort:text(r?.effort)})).filter((r:any)=>r.reasoningEffort),contextWindow:count(m.context_window)||null
    }));
    return {data,source:configured?'desktop-configured-catalog':'desktop-model-cache',provider:text(config.model_provider)};
  }
  private observe(files:string[]) {
    const signature=JSON.stringify(files);if(signature===this.watched)return;
    for(const w of this.watchers)w.close();this.watchers=[];this.watched='';
    const directories=[...new Set(files.map(f=>path.dirname(f)))];
    try{for(const directory of directories){const names=new Set(files.filter(f=>path.dirname(f)===directory).map(f=>path.basename(f)));const watcher=watch(directory,(_event,name)=>{
      if(name&&!names.has(name.toString()))return;
      clearTimeout(this.timer);this.timer=setTimeout(()=>{this.timer=undefined;this.emit('changed');},150);
    });watcher.on('error',()=>{this.watched='';});watcher.unref();this.watchers.push(watcher);}this.watched=signature;}catch{for(const w of this.watchers)w.close();this.watchers=[];}
  }
  close(){clearTimeout(this.timer);this.timer=undefined;for(const w of this.watchers)w.close();this.watchers=[];this.watched='';}
}

/** Absent overrides mean inheritance, not the WebUI's previous hard-coded defaults. */
export function desktopOverrides(state:any,input:any,models:any[],identity:Identity,root:string) {
  const overrides=input.settingsOverrides??[];
  if(!Array.isArray(overrides)||overrides.length>4||overrides.some((k:any)=>!['model','effort','mode','access'].includes(k)))throw new ConsoleError(400,'INVALID_SETTINGS','无效的任务设置。');
  const result:any={},current=desktopSettings(state);
  if(overrides.includes('access'))Object.assign(result,accessPolicy(identity,root,input.access,input.confirmFullAccess),{approvalsReviewer:'user'});

  if(overrides.some((k:string)=>['model','effort','mode'].includes(k))){
    const modelName=overrides.includes('model')?input.model:current.model;
    const model=models.find(m=>m.model===modelName);
    if(!model)throw new ConsoleError(409,'MODEL_UNAVAILABLE','模型已不在桌面目录中，请刷新模型列表。');
    const effort=overrides.includes('effort')?(input.effort||model.defaultReasoningEffort):current.effort;
    if(effort&&!model.supportedReasoningEfforts.some((r:any)=>r.reasoningEffort===effort))throw new ConsoleError(400,'EFFORT_UNAVAILABLE','此模型不支持所选推理强度。');
    if(overrides.includes('mode')&&!['code','plan'].includes(input.mode))throw new ConsoleError(400,'INVALID_MODE','无效的协作模式。');
    const previous=state?.latestThreadSettings?.collaborationMode||state?.latestCollaborationMode||{};
    result.collaborationMode={mode:(overrides.includes('mode')?input.mode:current.mode)==='plan'?'plan':'default',settings:{...previous.settings,model:modelName,reasoning_effort:effort,developer_instructions:previous.settings?.developer_instructions??null}};
  }
  return result;
}
