import path from 'node:path';
import { CodexConsoleService } from './service';
import { ConsoleError, requireAdmin, type Project, type ConfigStore, type Identity } from './config';
import { CommandReceipts } from './receipts';
import { DesktopIpc } from './desktop-ipc';
import { normalizeItem, runtimeStatus, type TimelineItem } from './normalize';
import { attachmentPath, projectReference } from './files';
import { readCatalog, publicCatalog, resolveExtensions, readMcp, type Catalog } from './extensions';
import type { DesktopBridgeApi } from './desktop-bridge';
import { DesktopModelCatalog, desktopSettings, desktopUsage, desktopOverrides } from './desktop-settings';

/** Local manual-test adapter for an already-owned desktop task. No Codex process is started and no credentials are extracted. */
export class DesktopSessionService extends CodexConsoleService {
  private items=new Map<string,TimelineItem>();
  private lastStatus='idle';
  private updateTimer?:NodeJS.Timeout;
  private observedTurn="";private usageItemStates=new Map<string,string>();
  private settingsSignature='';
  constructor(config:ConfigStore, receipts:CommandReceipts, readonly desktop:DesktopIpc, readonly catalog=new DesktopModelCatalog(), readonly bridge?:DesktopBridgeApi, private binding?:Project) {
    super(config,receipts);
    catalog.on('changed',()=>{for(const project of this.config.value.projects)this.hub.publish({type:'status',projectId:project.id,threadId:desktop.threadId,payload:{status:this.lastStatus,modelsChanged:true}});});
    desktop.on('state',()=>{if(!this.updateTimer)this.updateTimer=setTimeout(()=>{this.updateTimer=undefined;this.update();},100);});
    desktop.on('disconnect',()=>{this.hub.publish({type:'connection',payload:{connected:false}});});
  }
  private catalogValue?:{at:number,value:Promise<Catalog>};
  override project(identity:Identity,id:string,capability:'view'|'send'|'files'|'approve'='view'):Project {
    if(this.binding?.id===id){if(!identity.uuid||this.binding.ownerId&&this.binding.ownerId!==identity.uuid)throw new ConsoleError(403,'THREAD_FORBIDDEN','此聊天属于另一个网页账户。');if(capability==='files')throw new ConsoleError(403,'PROJECTLESS_FILES','无项目对话不开放文件浏览。');return this.binding;}
    return super.project(identity,id,capability);
  }
  async extensionCatalog(root:string,refresh=false){if(!this.bridge?.available)throw new ConsoleError(503,'DESKTOP_BRIDGE_OFFLINE','技能接口未连接。');if(!refresh&&this.catalogValue&&Date.now()-this.catalogValue.at<60000)return this.catalogValue.value;const value=readCatalog((method,params)=>this.bridge!.rpc(method,params),root,refresh);this.catalogValue={at:Date.now(),value};return value;}
  override async extensions(identity:Identity,projectId:string,refresh=false){const project=this.requireCurrent(identity,projectId);return publicCatalog(await this.extensionCatalog(project.root,refresh));}
  override async mcp(identity:Identity,projectId:string,id?:string){this.requireCurrent(identity,projectId,id);if(!this.bridge?.available)throw new ConsoleError(503,'DESKTOP_BRIDGE_OFFLINE','MCP 接口未连接。');return readMcp((method,params)=>this.bridge!.rpc(method,params),id);}
  private requireCurrent(identity:Identity,projectId:string,id=this.desktop.threadId,capability:'view'|'send'|'files'|'approve'='view') {
    const project=this.project(identity,projectId,capability);
    if(!this.desktop.connected)throw new ConsoleError(503,'DESKTOP_OFFLINE','桌面 IPC 未连接。');
    if(id!==this.desktop.threadId||path.resolve(this.desktop.state?.cwd||'')!==project.root)throw new ConsoleError(403,'THREAD_FORBIDDEN','不是已附加的桌面任务。');
    return project;
  }
  private turns():any[] {
    const state=this.desktop.state;
    if(!state)return [];
    const h=state.turnHistory?.history;
    if(!h)return state.turns||[];
    const rows:any[]=[];const seen=new Set<string>();
    for(const island of h.islands||[])for(const entry of island.entries||[]){const turn=h.entitiesByKey?.[entry.value];if(turn&&!seen.has(entry.value)){rows.push(turn);seen.add(entry.value);}}
    return rows;
  }
  private update() {
    if(!this.desktop.state)return;
    const project=this.binding||this.config.value.projects.find(p=>p.root===path.resolve(this.desktop.state.cwd));if(!project)return;
    const latest=this.turns().at(-1),turnId=latest?.turnId||latest?.id;
    if(this.usage?.owner(this.desktop.threadId)&&turnId){
      const running=runtimeStatus({status:this.desktop.state.threadRuntimeStatus})==="running";
      if(running&&this.observedTurn!==turnId){this.observedTurn=turnId;this.usageItemStates.clear();this.usage.observe(this.desktop.threadId,"turn/started",{turn:{id:turnId}});}
      const settings=desktopSettings(this.desktop.state);if(settings.model)this.usage.model(this.desktop.threadId,settings.model,this.desktop.state.modelProvider,this.desktop.state.latestThreadSettings?.serviceTier);
      this.usage.usage(this.desktop.threadId,this.desktop.state.latestTokenUsageInfo?.total);
      if(this.observedTurn===turnId){for(const raw of latest.items||[]){const signature=String(raw.status||""),prior=this.usageItemStates.get(raw.id);
        if(prior===undefined&&/inProgress|running/.test(signature))this.usage.observe(this.desktop.threadId,"item/started",{item:raw});
        if(prior!==signature&&/completed|failed|interrupted/.test(signature))this.usage.observe(this.desktop.threadId,"item/completed",{item:raw});
        if(raw.type==="agentMessage"&&normalizeItem(raw).text&&!this.items.get(raw.id)?.text)this.usage.observe(this.desktop.threadId,"item/agentMessage/delta",{delta:"1"});
        this.usageItemStates.set(raw.id,signature);
      }if(!running)this.usage.observe(this.desktop.threadId,"turn/completed",{turn:{id:turnId,status:latest.status||"completed"}});}
    }
    const next=new Map<string,TimelineItem>();
    for(const turn of this.turns().slice(-20))for(const raw of turn.items||[]){
      // Render only public message/tool fields, never private reasoning content or raw tool arguments.
      if(raw.type==='reasoning')continue;
      const item=normalizeItem(raw);next.set(item.id,item);
    }
    let size=[...next.values()].reduce((n,v)=>n+v.text.length,0);
    while(next.size>200||size>512*1024){const key=next.keys().next().value!;size-=next.get(key)!.text.length;next.delete(key);}
    for(const [id,item]of next){const prior=this.items.get(id);if(prior?.text===item.text&&prior.status===item.status)continue;
      if(prior&&item.text.startsWith(prior.text)&&item.status===prior.status)this.hub.publish({type:'delta',projectId:project.id,threadId:this.desktop.threadId,payload:{itemId:id,offset:prior.text.length,text:item.text.slice(prior.text.length)}});
      else this.hub.publish({type:'item',projectId:project.id,threadId:this.desktop.threadId,payload:item});
    }
    this.items=next;
    const status=runtimeStatus({status:this.desktop.state.threadRuntimeStatus});
    const settings=desktopSettings(this.desktop.state),tokenUsage=desktopUsage(this.desktop.state),signature=JSON.stringify({settings,tokenUsage});
    if(status!==this.lastStatus||signature!==this.settingsSignature){this.lastStatus=status;this.settingsSignature=signature;this.hub.publish({type:'status',projectId:project.id,threadId:this.desktop.threadId,payload:{status,turnId:this.turns().at(-1)?.turnId,settings,tokenUsage,metrics:this.usageSnapshot(this.desktop.threadId)}});}
  }
  override get hasActiveWork(){return runtimeStatus({status:this.desktop.state?.threadRuntimeStatus})==='running';}
  protected override async readAccountMetadata(){if(!this.bridge?.available)throw new ConsoleError(503,'DESKTOP_BRIDGE_OFFLINE','账户接口未连接。');return this.bridge.rpc('account/read',{refreshToken:false});}
  override async connect(){
    if(!this.desktop.connected)await this.desktop.connect();
    this.update();this.hub.publish({type:'connection',payload:{connected:true}});
  }
  override disconnect(){this.invalidateSubscription();if(this.updateTimer)clearTimeout(this.updateTimer);this.updateTimer=undefined;this.catalog.close();this.desktop.close();}
  override status(identity:Identity):any {return {configured:true,connected:this.desktop.connected,transport:'desktop-ipc',serverVersion:'existing desktop IPC',desktopSync:'verified-owner',processPolicy:'attach-only',userId:identity.uuid,admin:identity.elevated,maxConcurrentTurns:1,attachedThreadId:this.desktop.threadId,capabilities:{createThread:false,extensions:!!this.bridge?.available,mcp:!!this.bridge?.available,quota:false,resetQuota:false,setGoal:false,approvals:false,configureTransport:false},reason:this.desktop.connected?undefined:'桌面未连接'};}
  override async listThreads(identity:Identity,projectId:string):Promise<any>{this.requireCurrent(identity,projectId);return {data:[{id:this.desktop.threadId,title:this.desktop.state.title||'桌面当前任务',status:this.lastStatus,updatedAt:this.desktop.state.updatedAt}],nextCursor:null};}
  override async snapshot(identity:Identity,projectId:string,id:string):Promise<any>{this.requireCurrent(identity,projectId,id);this.update();return {id,title:this.desktop.state.title||'桌面当前任务',status:this.lastStatus,turnId:this.turns().at(-1)?.turnId,items:[...this.items.values()],pending:[],cursor:this.hub.cursor,truncated:true,settings:desktopSettings(this.desktop.state),tokenUsage:desktopUsage(this.desktop.state),metrics:this.usageSnapshot(id)};}
  override async models(identity:Identity):Promise<any>{
    if(!identity.uuid)throw new ConsoleError(401,'LOGIN_REQUIRED','请登录。');
    return {...await this.catalog.read(desktopSettings(this.desktop.state).model),settings:desktopSettings(this.desktop.state)};
  }
  override async createThread():Promise<never>{throw new ConsoleError(409,'DESKTOP_CURRENT_TASK_ONLY','本地桥接已附加到当前桌面任务，不能在这里新建其他任务。');}
  override async rateLimits():Promise<any>{throw new ConsoleError(501,'DESKTOP_API_UNAVAILABLE','此桌面 IPC 未开放额度读取。');}
  override async consumeRateLimitReset():Promise<any>{throw new ConsoleError(501,'DESKTOP_API_UNAVAILABLE','请在桌面中操作重置卡。');}
  override async goal(identity:Identity,projectId:string,id:string,objective?:string):Promise<any>{this.requireCurrent(identity,projectId,id);if(objective!==undefined)throw new ConsoleError(501,'DESKTOP_API_UNAVAILABLE','请在桌面中设置目标。');return {goal:this.desktop.state.threadGoal||null};}
  override async send(identity:Identity,projectId:string,id:string,input:any):Promise<any>{
    const project=this.requireCurrent(identity,projectId,id,'send');
    if(typeof input?.text!=='string'||!input.text.trim()||input.text.length>64000||!/^[-a-zA-Z0-9_]{8,100}$/.test(input.requestId))throw new ConsoleError(400,'INVALID_MESSAGE','无效的消息。');
    if(input.extensions!==undefined&&(!Array.isArray(input.extensions)||input.extensions.length>12))throw new ConsoleError(400,'INVALID_EXTENSIONS','最多选择 12 个技能或插件。');
    const content:any[]=[{type:'text',text:input.text,text_elements:[]}];
    if(input.extensions?.length)content.push(...resolveExtensions(await this.extensionCatalog(project.root,true),input.extensions));
    if(input.attachments?.length||input.references?.length){this.requireCurrent(identity,projectId,id,'files');
      if(!Array.isArray(input.attachments)||input.attachments.length>5||!Array.isArray(input.references)||input.references.length>12)throw new ConsoleError(400,'INVALID_ATTACHMENTS','附件数量无效。');
      for(const ref of input.references)content[0].text+='\n\nProject reference: '+await projectReference(project.root,ref);
      for(const ref of input.attachments){const full=await attachmentPath(project.root,ref);if(/\.(png|jpe?g|webp)$/i.test(full))content.push({type:'localImage',path:full});else content[0].text+='\n\nAttached project file: '+ref;}
    }
    return this.receipts.run(`${identity.uuid}:desktop:${id}:${input.requestId}`,async()=>{
      if(this.hasActiveWork)throw new ConsoleError(409,'THREAD_BUSY','桌面任务仍在运行，请等待本轮结束。');
      const wantsModel=Array.isArray(input.settingsOverrides)&&input.settingsOverrides.some((k:string)=>['model','effort','mode'].includes(k));
      const data=wantsModel?(await this.models(identity)).data:[];
      const overrides=desktopOverrides(this.desktop.state,input,data,identity,project.root);
      const response=await this.desktop.request('thread-follower-start-turn',{conversationId:id,turnStart:{request:{threadId:id,clientUserMessageId:input.requestId,input:content,...overrides},context:{inheritThreadSettings:true}}},2);
      this.update();return {turnId:response.result?.result?.turn?.id||this.turns().at(-1)?.turnId,status:this.lastStatus};
    });
  }
  override async interrupt(identity:Identity,projectId:string,id:string):Promise<any>{this.requireCurrent(identity,projectId,id,'send');await this.desktop.request('thread-follower-interrupt-turn',{conversationId:id,mode:'user-stop',expectedTurnId:this.turns().at(-1)?.turnId},4);return {ok:true};}
  override async answer():Promise<any>{throw new ConsoleError(501,'DESKTOP_API_UNAVAILABLE','请在桌面中处理审批。');}
}
