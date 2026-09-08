import path from 'node:path';
import { CodexConsoleService } from './service';
import { ConsoleError, type ConfigStore, type Identity } from './config';
import { CommandReceipts } from './receipts';
import { DesktopIpc } from './desktop-ipc';
import { normalizeItem, runtimeStatus, type TimelineItem } from './normalize';
import { attachmentPath, projectReference } from './files';
import { DesktopModelCatalog, desktopSettings, desktopUsage, desktopOverrides } from './desktop-settings';

/** Local manual-test adapter for an already-owned desktop task. No Codex process is started and no credentials are extracted. */
export class DesktopSessionService extends CodexConsoleService {
  private items=new Map<string,TimelineItem>();
  private lastStatus='idle';
  private updateTimer?:NodeJS.Timeout;
  private settingsSignature='';
  constructor(config:ConfigStore, receipts:CommandReceipts, readonly desktop:DesktopIpc, readonly catalog=new DesktopModelCatalog()) {
    super(config,receipts);
    catalog.on('changed',()=>{for(const project of this.config.value.projects)this.hub.publish({type:'status',projectId:project.id,threadId:desktop.threadId,payload:{status:this.lastStatus,modelsChanged:true}});});
    desktop.on('state',()=>{if(!this.updateTimer)this.updateTimer=setTimeout(()=>{this.updateTimer=undefined;this.update();},100);});
    desktop.on('disconnect',()=>{this.hub.publish({type:'connection',payload:{connected:false}});});
  }
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
    const project=this.config.value.projects.find(p=>p.root===path.resolve(this.desktop.state.cwd));if(!project)return;
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
    if(status!==this.lastStatus||signature!==this.settingsSignature){this.lastStatus=status;this.settingsSignature=signature;this.hub.publish({type:'status',projectId:project.id,threadId:this.desktop.threadId,payload:{status,turnId:this.turns().at(-1)?.turnId,settings,tokenUsage}});}
  }
  override get hasActiveWork(){return runtimeStatus({status:this.desktop.state?.threadRuntimeStatus})==='running';}
  override async connect(){
    if(!this.desktop.connected)await this.desktop.connect();
    this.update();this.hub.publish({type:'connection',payload:{connected:true}});
  }
  override disconnect(){if(this.updateTimer)clearTimeout(this.updateTimer);this.updateTimer=undefined;this.catalog.close();this.desktop.close();}
  override status(identity:Identity):any {return {configured:true,connected:this.desktop.connected,transport:'desktop-ipc',serverVersion:'existing desktop IPC',desktopSync:'verified-owner',processPolicy:'attach-only',userId:identity.uuid,admin:identity.elevated,maxConcurrentTurns:1,attachedThreadId:this.desktop.threadId,capabilities:{createThread:false,extensions:false,mcp:false,quota:false,resetQuota:false,setGoal:false,approvals:false,configureTransport:false},reason:this.desktop.connected?undefined:'桌面未连接'};}
  override async listThreads(identity:Identity,projectId:string):Promise<any>{this.requireCurrent(identity,projectId);return {data:[{id:this.desktop.threadId,title:this.desktop.state.title||'桌面当前任务',status:this.lastStatus,updatedAt:this.desktop.state.updatedAt}],nextCursor:null};}
  override async snapshot(identity:Identity,projectId:string,id:string):Promise<any>{this.requireCurrent(identity,projectId,id);this.update();return {id,title:this.desktop.state.title||'桌面当前任务',status:this.lastStatus,turnId:this.turns().at(-1)?.turnId,items:[...this.items.values()],pending:[],cursor:this.hub.cursor,truncated:true,settings:desktopSettings(this.desktop.state),tokenUsage:desktopUsage(this.desktop.state)};}
  override async models(identity:Identity):Promise<any>{
    if(!identity.uuid)throw new ConsoleError(401,'LOGIN_REQUIRED','请登录。');
    return {...await this.catalog.read(desktopSettings(this.desktop.state).model),settings:desktopSettings(this.desktop.state)};
  }
  override async createThread():Promise<never>{throw new ConsoleError(409,'DESKTOP_CURRENT_TASK_ONLY','本地桥接已附加到当前桌面任务，不能在这里新建其他任务。');}
  override async extensions():Promise<any>{return {entries:[],skillsAvailable:false,pluginsAvailable:false,issues:['此桌面 IPC 仅开放任务操作，技能与插件目录尚未接入此桥接。']};}
  override async mcp():Promise<any>{throw new ConsoleError(501,'DESKTOP_API_UNAVAILABLE','此桌面 IPC 未开放 MCP 列表。');}
  override async rateLimits():Promise<any>{throw new ConsoleError(501,'DESKTOP_API_UNAVAILABLE','此桌面 IPC 未开放额度读取。');}
  override async consumeRateLimitReset():Promise<any>{throw new ConsoleError(501,'DESKTOP_API_UNAVAILABLE','请在桌面中操作重置卡。');}
  override async goal(identity:Identity,projectId:string,id:string,objective?:string):Promise<any>{this.requireCurrent(identity,projectId,id);if(objective!==undefined)throw new ConsoleError(501,'DESKTOP_API_UNAVAILABLE','请在桌面中设置目标。');return {goal:this.desktop.state.threadGoal||null};}
  override async send(identity:Identity,projectId:string,id:string,input:any):Promise<any>{
    const project=this.requireCurrent(identity,projectId,id,'send');
    if(typeof input?.text!=='string'||!input.text.trim()||input.text.length>64000||!/^[-a-zA-Z0-9_]{8,100}$/.test(input.requestId))throw new ConsoleError(400,'INVALID_MESSAGE','无效的消息。');
    if(input.extensions?.length)throw new ConsoleError(501,'DESKTOP_API_UNAVAILABLE','此桥接尚不接受插件/技能选择。');
    const content:any[]=[{type:'text',text:input.text,text_elements:[]}];
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
