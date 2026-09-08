import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CodexConsoleService } from './service';
import { ConsoleError, requireAdmin, type ConfigStore, type Identity } from './config';
import { CommandReceipts } from './receipts';
import { DesktopIpc } from './desktop-ipc';
import { DesktopSessionService } from './desktop-session';
import type { DesktopTaskTools } from './desktop-tools';
const validId=(id:any)=>typeof id==='string'&&/^[-a-zA-Z0-9_]{1,128}$/.test(id);
interface Creation {key:string;userId:string;requestId:string;projectId:string;fingerprint:string;at:number;status:'submitting'|'ready'|'failed'|'unknown';threadId?:string;clientThreadId?:string;messageAccepted?:boolean|null;message?:string}
interface KnownTask {id:string;projectId:string;title:string;status:string;updatedAt?:number}
/** Adds explicit, user-driven task creation and switching to existing desktop IPC sessions. */
export class DesktopWorkspaceService extends CodexConsoleService {
  private attached=new Map<string,DesktopSessionService>();private desktopOpening=new Map<string,Promise<DesktopSessionService>>();
  private known=new Map<string,KnownTask>();private creations=new Map<string,Creation>();private creating=new Map<string,Promise<Creation>>();
  private projectWrites=new Map<string,string>();
  private submissions=new Map<string,{fingerprint:string;promise:Promise<any>}>();
  private savedProjects:any[]=[];private management=false;private initialized=false;private flushing=Promise.resolve();
  constructor(config:ConfigStore,receipts:CommandReceipts,readonly anchor:DesktopIpc,readonly tools:DesktopTaskTools|undefined,readonly stateFile:string,private makeSession=(ipc:DesktopIpc)=>new DesktopSessionService(config,receipts,ipc),private makeIpc=(id:string)=>new DesktopIpc(anchor.endpoint,id)){
    super(config,receipts);this.addSession(this.makeSession(anchor));
  }
  private addSession(session:DesktopSessionService){this.attached.set(session.desktop.threadId,session);session.hub.subscribe(event=>{const {cursor,...rest}=event;if(event.type==='connection')this.hub.publish({...rest,payload:{connected:this.status({uuid:'',elevated:false}).connected}});else this.hub.publish(rest);});}
  private async save(){const write=this.flushing.catch(()=>{}).then(async()=>{await fs.mkdir(path.dirname(this.stateFile),{recursive:true,mode:0o700});const data={version:1,tasks:[...this.known.values()],creations:[...this.creations.values()]};await fs.writeFile(this.stateFile+'.tmp',JSON.stringify(data),{mode:0o600});await fs.rename(this.stateFile+'.tmp',this.stateFile);});this.flushing=write;await write;}
  async initialize(){
    if(this.initialized)return;this.initialized=true;
    try{const data=JSON.parse(await fs.readFile(this.stateFile,'utf8'));for(const row of data.tasks||[])if(validId(row.id)&&this.config.value.projects.some(p=>p.id===row.projectId))this.known.set(row.id,row);for(const row of data.creations||[])if(validId(row.requestId)&&typeof row.userId==='string'){if(row.status==='submitting')row.status='unknown';this.creations.set(row.key,row);}}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
    const project=this.config.value.projects.find(p=>p.root===path.resolve(this.anchor.state.cwd));if(!project)throw new Error('Desktop project is not configured');
    this.known.set(this.anchor.threadId,{id:this.anchor.threadId,projectId:project.id,title:this.anchor.state.title||'桌面任务',status:'idle'});
    if(this.tools)try{this.management=await this.tools.discover();if(this.management)this.savedProjects=(await this.tools.listProjects()).projects||[];}catch{this.management=false;}
  }
  override async connect(){await this.initialize();for(const session of this.attached.values())await session.connect();}
  override disconnect(){for(const session of this.attached.values())session.disconnect();this.tools?.close();}
  override get hasActiveWork(){return [...this.attached.values()].some(s=>s.hasActiveWork);}
  override status(identity:Identity):any{const base=this.attached.get(this.anchor.threadId)!.status(identity);return {...base,connected:[...this.attached.values()].some(s=>s.desktop.connected),capabilities:{...base.capabilities,switchThreads:this.management,createWithMessage:this.management&&identity.elevated},creationMode:this.management?'desktop-current-directory':null};}
  override projects(identity:Identity){return super.projects(identity).map(project=>({...project,canCreateTask:this.management&&identity.elevated&&this.savedProjects.some(p=>p.projectKind==='local'&&typeof p.path==='string'&&path.resolve(p.path)===project.root),creationEnvironment:'local'}));}
  private async session(identity:Identity,projectId:string,id:string){
    const project=this.project(identity,projectId);if(!validId(id))throw new ConsoleError(400,'INVALID_THREAD','无效的任务 ID。');
    const existing=this.attached.get(id);if(existing){if(path.resolve(existing.desktop.state.cwd)!==project.root)throw new ConsoleError(403,'THREAD_FORBIDDEN','任务不属于此项目。');if(!existing.desktop.connected)await existing.connect();return existing;}
    const openingKey=projectId+':'+id;const inFlight=this.desktopOpening.get(openingKey);if(inFlight)return inFlight;
    const pending=(async()=>{
      if(!this.management||!this.tools)throw new ConsoleError(501,'DESKTOP_MANAGEMENT_UNAVAILABLE','当前桌面连接不支持切换任务。');
      const result=await this.tools.readThread(id),thread=result.thread;
      if(thread?.id!==id||thread.kind!=='codex'||thread.hostId!=='local'||typeof thread.cwd!=='string'||await fs.realpath(thread.cwd)!==project.root)throw new ConsoleError(403,'THREAD_FORBIDDEN','任务不属于此项目。');
      if(this.attached.size>=16)throw new ConsoleError(429,'DESKTOP_SESSION_LIMIT','已连接 16 个任务，请重启 WebUI 后再打开更多任务。');
      this.known.set(id,{id,projectId,title:thread.title||id,status:thread.status?.type||'idle',updatedAt:thread.updatedAt});
      const ipc=this.makeIpc(id);try{await ipc.connect();if(path.resolve(ipc.state.cwd)!==project.root)throw new ConsoleError(403,'THREAD_FORBIDDEN','任务工作目录已改变。');const session=this.makeSession(ipc);this.addSession(session);await session.connect();await this.save();return session;}catch(error){ipc.close();throw error;}
    })();this.desktopOpening.set(openingKey,pending);try{return await pending;}finally{if(this.desktopOpening.get(openingKey)===pending)this.desktopOpening.delete(openingKey);}
  }
  override async listThreads(identity:Identity,projectId:string):Promise<any>{
    const project=this.project(identity,projectId);
    if(this.management&&this.tools)try{const result=await this.tools.listThreads();for(const thread of [...result.pinnedThreads||[],...result.threads||[]])if(thread.kind==='codex'&&thread.hostId==='local'&&validId(thread.id)&&typeof thread.cwd==='string'&&path.resolve(thread.cwd)===project.root)this.known.set(thread.id,{id:thread.id,projectId,title:thread.title||thread.id,status:thread.status||'idle',updatedAt:thread.updatedAt});}catch{/* Known tasks stay available if listing is temporarily unavailable. */}
    for(const session of this.attached.values())if(path.resolve(session.desktop.state.cwd)===project.root){try{const {data}=await session.listThreads(identity,projectId);for(const row of data)this.known.set(row.id,{...row,projectId});}catch{/* A disconnected task stays in the list for reconnection. */}}
    return {data:[...this.known.values()].filter(t=>t.projectId===projectId).sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0)),nextCursor:null};
  }
  override async snapshot(identity:Identity,projectId:string,id:string):Promise<any>{const result=await(await this.session(identity,projectId,id)).snapshot(identity,projectId,id);return {...result,cursor:this.hub.cursor};}
  override async models(identity:Identity,projectId?:string,threadId?:string):Promise<any>{return (threadId&&projectId?await this.session(identity,projectId,threadId):this.attached.get(this.anchor.threadId)!).models(identity);}
  private checkProjectIdle(projectId:string,except?:string){const project=this.config.value.projects.find(p=>p.id===projectId);if(this.projectWrites.has(projectId)||[...this.attached.values()].some(s=>s.desktop.threadId!==except&&path.resolve(s.desktop.state.cwd)===project?.root&&s.hasActiveWork))throw new ConsoleError(409,'PROJECT_BUSY','此目录中已有任务运行，请等待完成后再发送。');}
  override async send(identity:Identity,projectId:string,id:string,input:any):Promise<any>{this.project(identity,projectId,'send');this.checkProjectIdle(projectId,id);const key='send:'+id;this.projectWrites.set(projectId,key);try{return(await this.session(identity,projectId,id)).send(identity,projectId,id,input);}finally{if(this.projectWrites.get(projectId)===key)this.projectWrites.delete(projectId);}}
  override async interrupt(identity:Identity,projectId:string,id:string):Promise<any>{this.project(identity,projectId,'send');return(await this.session(identity,projectId,id)).interrupt(identity,projectId,id);}
  override async extensions():Promise<any>{return this.attached.get(this.anchor.threadId)!.extensions();}
  override async mcp():Promise<any>{throw new ConsoleError(501,'DESKTOP_API_UNAVAILABLE','请在桌面中查看 MCP。');}
  override async rateLimits():Promise<any>{throw new ConsoleError(501,'DESKTOP_API_UNAVAILABLE','请在桌面中查看额度。');}
  override async goal(identity:Identity,projectId:string,id:string,objective?:string):Promise<any>{return(await this.session(identity,projectId,id)).goal(identity,projectId,id,objective);}
  override async createThread():Promise<never>{throw new ConsoleError(409,'DESKTOP_FIRST_MESSAGE_REQUIRED','请在新任务输入首条消息后创建。');}
  private record(identity:Identity,requestId:string){requireAdmin(identity);const value=this.creations.get(`${identity.uuid}:${requestId}`);if(!value)throw new ConsoleError(404,'CREATION_NOT_FOUND','未找到这次创建请求。');this.project(identity,value.projectId,'send');return value;}
  override async taskCreation(identity:Identity,requestId:string):Promise<any>{const record=this.record(identity,requestId);return this.result(identity,record);}
  private async result(identity:Identity,record:Creation){
    const {fingerprint,key,userId,...publicRecord}=record;
    if(record.threadId)try{
      if(record.messageAccepted===null&&this.tools){const read=await this.tools.readThread(record.threadId);if(read.thread?.id===record.threadId&&read.turns?.some((t:any)=>validId(t.id)&&['inProgress','completed','failed','interrupted'].includes(t.status))){record.messageAccepted=true;record.message=undefined;await this.save();publicRecord.messageAccepted=true;publicRecord.message=undefined;}}
      const snapshot=await this.snapshot(identity,record.projectId,record.threadId);return {...publicRecord,thread:{id:snapshot.id,title:snapshot.title,status:snapshot.status},attached:true};}catch{return {...publicRecord,attached:false,message:record.message||'任务已创建，输出连接尚未就绪。请检查创建状态，不要重发首条消息。'};}
    return publicRecord;
  }
  override async createTask(identity:Identity,projectId:string,input:any):Promise<any>{
    requireAdmin(identity);this.project(identity,projectId,'send');
    const key=identity.uuid+':'+String(input?.requestId),fingerprint=createHash('sha256').update(JSON.stringify({projectId,input})).digest('hex'),existing=this.submissions.get(key);
    if(existing){if(existing.fingerprint!==fingerprint)throw new ConsoleError(409,'CREATION_CHANGED','创建请求内容已改变。');return existing.promise;}
    const isNew=!this.creations.has(key);if(isNew){this.checkProjectIdle(projectId);this.projectWrites.set(projectId,key);}
    const promise=this.createTaskOnce(identity,projectId,input);this.submissions.set(key,{fingerprint,promise});try{return await promise;}finally{if(this.submissions.get(key)?.promise===promise)this.submissions.delete(key);if(this.projectWrites.get(projectId)===key)this.projectWrites.delete(projectId);}
  }
  private async createTaskOnce(identity:Identity,projectId:string,input:any):Promise<any>{
    requireAdmin(identity);const project=this.project(identity,projectId,'send');
    if(!this.management||!this.tools)throw new ConsoleError(501,'DESKTOP_MANAGEMENT_UNAVAILABLE','桌面任务管理接口不可用。');
    if(!/^[-a-zA-Z0-9_]{8,100}$/.test(input?.requestId||'')||typeof input.text!=='string'||!input.text.trim()||input.text.length>64000)throw new ConsoleError(400,'INVALID_MESSAGE','请输入消息并提供有效请求 ID。');
    if(input.environment!=='local'||input.confirmCurrentDirectory!==true)throw new ConsoleError(400,'DIRECTORY_CONFIRMATION_REQUIRED','请确认在当前项目目录创建任务。');
    if(input.attachments?.length||input.references?.length||input.extensions?.length)throw new ConsoleError(400,'DESKTOP_FIRST_MESSAGE_TEXT_ONLY','新任务首条消息仅支持文本；创建后可继续添加附件。');
    const overrides=input.settingsOverrides||[];if(!Array.isArray(overrides)||overrides.some((v:any)=>!['model','effort'].includes(v)))throw new ConsoleError(400,'DESKTOP_NEW_SETTINGS','新任务权限和模式使用桌面设置；此处只能选择模型及强度。');
    const fingerprint=createHash('sha256').update(JSON.stringify({projectId,text:input.text,model:input.model,effort:input.effort,overrides,environment:input.environment})).digest('hex'),key=`${identity.uuid}:${input.requestId}`;
    const existing=this.creations.get(key);if(existing){if(existing.fingerprint!==fingerprint)throw new ConsoleError(409,'CREATION_CHANGED','此请求 ID 已用于另一条消息。请先检查原创建结果。');return this.result(identity,await(this.creating.get(key)||existing));}
    if(this.creations.size>=500)throw new ConsoleError(429,'CREATION_LIMIT','创建记录已达上限，请先由管理员整理。');
    const saved=(await this.tools.listProjects()).projects?.find((p:any)=>p.projectKind==='local'&&typeof p.path==='string'&&path.resolve(p.path)===project.root);if(!saved)throw new ConsoleError(409,'PROJECT_NOT_SAVED','请先在桌面中保存此项目，再从网页创建任务。');
    const args:any={prompt:input.text,title:input.text.trim().slice(0,60),target:{type:'project',projectId:saved.projectId,environment:{type:'local'}}};
    if(overrides.includes('model')||overrides.includes('effort')){const {data}=await this.models(identity);const selected=data.find((m:any)=>m.model===input.model);if(!selected)throw new ConsoleError(400,'MODEL_UNAVAILABLE','请选择桌面目录中的模型。');args.model=selected.model;if(input.effort){if(!selected.supportedReasoningEfforts.some((r:any)=>r.reasoningEffort===input.effort))throw new ConsoleError(400,'EFFORT_UNAVAILABLE','此模型不支持该推理强度。');args.thinking=input.effort;}}
    // Persist before the only mutating request. Reloads/timeouts never recreate a task.
    const row:Creation={key,userId:identity.uuid,requestId:input.requestId,projectId,fingerprint,at:Date.now(),status:'submitting'};this.creations.set(key,row);
    const work=(async()=>{await this.save();try{const reply=await this.tools!.createTask(args,createHash('sha256').update(key).digest('hex'));if(reply.hostId&&reply.hostId!=='local')throw new Error('Unexpected remote host');
      const id=reply.threadId||reply.conversationId;
      if(validId(id)){row.threadId=id;row.status='ready';row.messageAccepted=reply.threadId?true:reply.firstTurn?.status==='accepted'?true:['not-started','rejected','not-requested'].includes(reply.firstTurn?.status)?false:null;if(row.messageAccepted!==true)row.message=row.messageAccepted===false?'任务已创建，但首条消息未开始。可在该任务中手动重新发送。':'任务已创建，但首条消息是否开始尚未确认。请先查看输出，不要重复发送。';}
      else{row.status='unknown';if(typeof reply.clientThreadId==='string')row.clientThreadId=reply.clientThreadId;row.message='桌面创建结果尚未确认。请检查桌面任务列表，不要重复提交。';}
    }catch(error){row.status=error instanceof ConsoleError&&error.code==='DESKTOP_TOOL_REJECTED'?'failed':'unknown';row.message=row.status==='failed'?'桌面未能创建任务，请查看桌面错误。':'创建结果未知，请检查桌面任务列表，不要重复提交。';}await this.save();return row;})();this.creating.set(key,work);
    try{return this.result(identity,await work);}finally{this.creating.delete(key);}
  }
}
