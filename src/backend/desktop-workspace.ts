import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CodexConsoleService } from './service';
import { ConsoleError, requireAdmin, isWithin, validateConfig, type Project, type ConfigStore, type Identity } from './config';
import { CommandReceipts } from './receipts';
import { DesktopNativeSession } from './desktop-native-session';
import { DesktopIpc } from './desktop-ipc';
import { DesktopSessionService } from './desktop-session';
import { type DesktopBridgeApi } from './desktop-bridge';
import { readCatalog, publicCatalog, resolveExtensions, readMcp, type Catalog } from './extensions';
import { DesktopModelCatalog } from './desktop-settings';
import { normalizeRateLimits } from './limits';
import { prepareProjectDirectory,materializeProjectDirectory } from './projects';
import { runtimeStatus } from './normalize';
import type { DesktopTaskTools } from './desktop-tools';
const validId=(id:any)=>typeof id==='string'&&/^[-a-zA-Z0-9_]{1,128}$/.test(id);
interface Creation {key:string;userId:string;requestId:string;projectId:string;fingerprint:string;at:number;status:'submitting'|'ready'|'failed'|'unknown';threadId?:string;clientThreadId?:string;messageAccepted?:boolean|null;message?:string}
interface KnownTask {id:string;projectId:string;title:string;status:string;updatedAt?:number;cwd?:string;kind?:string;pinned?:boolean;archived?:boolean}
/** Adds explicit, user-driven task creation and switching to existing desktop IPC sessions. */
export class DesktopWorkspaceService extends CodexConsoleService {
  private attached=new Map<string,DesktopSessionService>();private desktopOpening=new Map<string,Promise<DesktopSessionService>>();
  private known=new Map<string,KnownTask>();private creations=new Map<string,Creation>();private creating=new Map<string,Promise<Creation>>();
  private projectWrites=new Map<string,string>();
  private submissions=new Map<string,{fingerprint:string;promise:Promise<any>}>();
  private savedProjects:any[]=[];private management=false;private initialized=false;private flushing=Promise.resolve();
  private featureCatalogs=new Map<string,{at:number,value:Promise<Catalog>}>();
  private bridgeProjects:any[]=[];private projectlessRoot='';private projectRefresh?:Promise<void>;private projectRefreshAt=0;
  constructor(config:ConfigStore,receipts:CommandReceipts,readonly anchor:DesktopIpc,readonly tools:DesktopTaskTools|undefined,readonly stateFile:string,private makeSession=(ipc:DesktopIpc)=>new DesktopSessionService(config,receipts,ipc),private makeIpc=(id:string)=>new DesktopIpc(anchor.endpoint,id),readonly bridge?:DesktopBridgeApi){
    super(config,receipts);this.addSession(this.newSession(anchor));
  }
  private newSession(ipc:DesktopIpc,binding?:Project){return this.bridge?new DesktopSessionService(this.config,this.receipts,ipc,new DesktopModelCatalog(),this.bridge,binding):this.makeSession(ipc);}
  private addSession(session:DesktopSessionService){this.attached.set(session.desktop.threadId,session);session.hub.subscribe(event=>{const {cursor,...rest}=event;if(event.type==='connection')this.hub.publish({...rest,payload:{connected:this.status({uuid:'',elevated:false}).connected}});else this.hub.publish(rest);});}
  private async save(){const write=this.flushing.catch(()=>{}).then(async()=>{await fs.mkdir(path.dirname(this.stateFile),{recursive:true,mode:0o700});const data={version:1,tasks:[...this.known.values()],creations:[...this.creations.values()]};await fs.writeFile(this.stateFile+'.tmp',JSON.stringify(data),{mode:0o600});await fs.rename(this.stateFile+'.tmp',this.stateFile);});this.flushing=write;await write;}
  async initialize(){
    if(this.initialized)return;this.initialized=true;
    try{const data=JSON.parse(await fs.readFile(this.stateFile,'utf8'));for(const row of data.tasks||[])if(validId(row.id)&&(row.projectId==='projectless'||this.config.value.projects.some(p=>p.id===row.projectId)))this.known.set(row.id,row);for(const row of data.creations||[])if(validId(row.requestId)&&typeof row.userId==='string'){if(row.status==='submitting')row.status='unknown';this.creations.set(row.key,row);}}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
    const project=this.config.value.projects.find(p=>p.root===path.resolve(this.anchor.state.cwd));if(!project)throw new Error('Desktop project is not configured');
    this.known.set(this.anchor.threadId,{id:this.anchor.threadId,projectId:project.id,title:this.anchor.state.title||'桌面任务',status:'idle'});
    if(this.bridge)try{await this.bridge.connect();await this.syncDesktopProjects();}catch{/* Capabilities stay unavailable if the opt-in bridge is offline. */}
    if(this.tools)try{this.management=await this.tools.discover();if(this.management)this.savedProjects=(await this.tools.listProjects()).projects||[];}catch{this.management=false;}
  }
  override async connect(){await this.initialize();if(this.bridge&&!this.bridge.available)try{await this.bridge.connect();await this.syncDesktopProjects(true);}catch{};for(const session of this.attached.values())await session.connect();}
  override disconnect(){for(const session of this.attached.values())session.disconnect();this.tools?.close();this.bridge?.close();}
  override get hasActiveWork(){return [...this.attached.values()].some(s=>s.hasActiveWork);}
  override status(identity:Identity):any{
    const base=this.attached.get(this.anchor.threadId)!.status(identity),native=!!this.bridge?.available;
    return {...base,connected:[...this.attached.values()].some(s=>s.desktop.connected),capabilities:{...base.capabilities,switchThreads:native||this.management,createWithMessage:(native||this.management)&&identity.elevated,projects:native&&identity.elevated,projectless:native&&identity.elevated,extensions:native,mcp:native,quota:native,resetQuota:native,setGoal:native,taskActions:native,firstMessageExtensions:native},creationMode:native?'desktop-native':'desktop-current-directory'};
  }
  override project(identity:Identity,id:string,capability:'view'|'send'|'approve'|'files'='view'):Project{
    if(id==='projectless'){requireAdmin(identity);if(!this.config.value.enabled||!this.bridge?.available||!this.projectlessRoot)throw new ConsoleError(503,'PROJECTLESS_UNAVAILABLE','无项目对话接口尚未连接。');if(capability==='files')throw new ConsoleError(403,'PROJECTLESS_FILES','无项目对话不开放项目文件浏览。');return {id,name:'无项目对话',root:this.projectlessRoot,grants:[]};}
    return super.project(identity,id,capability);
  }
  override projects(identity:Identity):any[]{
    const native=!!this.bridge?.available;
    const rows=super.projects(identity).filter(p=>p.id!=='projectless').map(project=>({...project,kind:'project',desktopProjectId:this.config.value.projects.find(p=>p.id===project.id)?.desktopProjectId,canCreateTask:identity.elevated&&(native||this.management&&this.savedProjects.some(p=>p.projectKind==='local'&&typeof p.path==='string'&&path.resolve(p.path)===project.root)),creationEnvironment:'local'}));
    if(native&&identity.elevated&&this.projectlessRoot)rows.push({id:'projectless',name:'无项目对话',root:'',permissions:{view:true,send:true,approve:true,files:false},activeCount:0,kind:'projectless',desktopProjectId:undefined,canCreateTask:true,creationEnvironment:'local'});
    return rows;
  }
  override async refreshProjects(identity:Identity){if(this.bridge?.available&&identity.elevated)await this.syncDesktopProjects();return this.projects(identity);}
  private async syncDesktopProjects(force=false){
    if(this.projectRefresh){await this.projectRefresh;if(!force)return;}if(!force&&Date.now()-this.projectRefreshAt<10000)return;
    const work=(async()=>{
      const result=await this.bridge!.rpc('project/list',{limit:100});this.bridgeProjects=result.data||[];
      const projects=this.config.value.projects.map(p=>({...p}));let changed=false;
      for(const p of this.bridgeProjects){if(!validId(p.id)||typeof p.name!=='string')continue;
        for(const root of p.roots||[]){if(typeof root.path!=='string')continue;const canonical=await fs.realpath(root.path).catch(()=>null);if(!canonical)continue;
          const prior=projects.find(v=>v.root===canonical);if(prior){if(prior.desktopProjectId!==p.id||prior.name!==p.name){Object.assign(prior,{desktopProjectId:p.id,name:p.name.slice(0,100)});changed=true;}continue;}
          const entry={id:'p-'+createHash('sha256').update(p.id+canonical).digest('hex').slice(0,20),name:p.name.slice(0,100),root:canonical,grants:[],desktopProjectId:p.id};
          try{await validateConfig({...this.config.value,projects:[...projects,entry]});const privateDir=path.dirname(this.config.file);if(isWithin(canonical,privateDir)||isWithin(privateDir,canonical))continue;projects.push(entry);changed=true;}catch{/* Inaccessible, overlapping and private roots are not exposed. */}
        }
      }
      if(changed)await this.config.save({...this.config.value,projects});
      const root=await this.bridge!.host('projectless-workspace-root',{}).catch(()=>null);
      if(typeof root?.workspaceRoot==='string')this.projectlessRoot=await fs.realpath(root.workspaceRoot).catch(()=>path.resolve(root.workspaceRoot));
      this.projectRefreshAt=Date.now();
    })();this.projectRefresh=work;try{await work;}finally{this.projectRefresh=undefined;}
  }
  override async createProject(identity:Identity,input:any){
    requireAdmin(identity);if(!this.bridge?.available)throw new ConsoleError(503,'DESKTOP_BRIDGE_OFFLINE','桌面项目接口未连接。');
    const prepared=await prepareProjectDirectory(this.config,input),canonical=prepared.root;
    return this.receipts.run(identity.uuid+':project:'+input.requestId,async()=>{
      await materializeProjectDirectory(this.config,prepared,input.name.trim());
      const entry={id:'p-'+createHash('sha256').update(canonical).digest('hex').slice(0,20),name:input.name.trim(),root:canonical,grants:[]};
      const result=await this.bridge!.rpc('project/create',{name:entry.name,roots:[{path:canonical}],idempotencyKey:identity.uuid+':'+input.requestId});
      if(!validId(result.project?.id))throw new ConsoleError(502,'PROJECT_OUTCOME_UNKNOWN','桌面项目创建结果未知，请刷新项目列表检查。');
      await this.syncDesktopProjects(true);const selected=this.projects(identity).find(p=>p.root===canonical);if(!selected)throw new ConsoleError(502,'PROJECT_SYNC_FAILED','项目已创建，但尚未同步到网页，请刷新项目列表。');return selected;
    });
  }
  private async session(identity:Identity,projectId:string,id:string){
    const project=this.project(identity,projectId);if(!validId(id))throw new ConsoleError(400,'INVALID_THREAD','无效的任务 ID。');
    const existing=this.attached.get(id);if(existing){if(projectId==='projectless'?this.known.get(id)?.projectId!=='projectless':path.resolve(existing.desktop.state.cwd)!==project.root)throw new ConsoleError(403,'THREAD_FORBIDDEN','任务不属于此项目。');if(!existing.desktop.connected)await existing.connect();if(await fs.realpath(existing.desktop.state.cwd).catch(()=>null)!==existing.project(identity,projectId).root)throw new ConsoleError(403,'THREAD_FORBIDDEN','任务目录已改变。');return existing;}
    const openingKey=projectId+':'+id;const inFlight=this.desktopOpening.get(openingKey);if(inFlight)return inFlight;
    const pending=(async()=>{
      if(!this.bridge?.available&&(!this.management||!this.tools))throw new ConsoleError(501,'DESKTOP_MANAGEMENT_UNAVAILABLE','当前桌面连接不支持切换任务。');
      const result=this.bridge?.available?await this.bridge.rpc('thread/read',{threadId:id,includeTurns:false}):await this.tools!.readThread(id),thread=result.thread;
      if(thread?.id!==id||(!this.bridge?.available&&(thread.kind!=='codex'||thread.hostId!=='local'))||typeof thread.cwd!=='string'||!(await this.matchesProject(project,thread)))throw new ConsoleError(403,'THREAD_FORBIDDEN','任务不属于此项目。');
      if(this.attached.size>=16)throw new ConsoleError(429,'DESKTOP_SESSION_LIMIT','已连接 16 个任务，请重启 WebUI 后再打开更多任务。');
      this.known.set(id,{...this.known.get(id),id,projectId,title:thread.name||thread.title||this.known.get(id)?.title||id,status:runtimeStatus(thread),updatedAt:thread.updatedAt,cwd:thread.cwd});
      const ipc=this.bridge?.watch?new DesktopNativeSession(this.anchor.endpoint,id,this.bridge):this.makeIpc(id);try{await ipc.connect();if(await fs.realpath(ipc.state.cwd)!==await fs.realpath(thread.cwd))throw new ConsoleError(403,'THREAD_FORBIDDEN','任务工作目录已改变。');const session=this.newSession(ipc,projectId==='projectless'?{...project,root:await fs.realpath(thread.cwd)}:undefined);this.addSession(session);await session.connect();await this.save();return session;}catch(error){ipc.close();throw error;}
    })();this.desktopOpening.set(openingKey,pending);try{return await pending;}finally{if(this.desktopOpening.get(openingKey)===pending)this.desktopOpening.delete(openingKey);}
  }
  override async listThreads(identity:Identity,projectId:string):Promise<any>{
    const project=this.project(identity,projectId);
    if(this.bridge?.available){const result=await this.bridge.rpc('thread/list',{limit:100,archived:false,modelProviders:[],...(projectId==='projectless'?{projectId:null}:{cwd:project.root})});for(const t of result.data||[])if(validId(t.id)&&await this.matchesProject(project,t)){const prior=this.known.get(t.id);this.known.set(t.id,{...prior,archived:false,id:t.id,projectId,title:t.name||t.preview||t.id,status:runtimeStatus(t),pinned:t.section?.id==='01984de2-8f74-7c91-a3b2-5c5e937cf318',updatedAt:t.updatedAt,cwd:t.cwd});}}
    else if(this.management&&this.tools)try{const result=await this.tools.listThreads();for(const thread of [...result.pinnedThreads||[],...result.threads||[]])if(thread.kind==='codex'&&thread.hostId==='local'&&validId(thread.id)&&typeof thread.cwd==='string'&&path.resolve(thread.cwd)===project.root)this.known.set(thread.id,{id:thread.id,projectId,title:thread.title||thread.id,status:thread.status||'idle',updatedAt:thread.updatedAt});}catch{/* Known tasks stay available if listing is temporarily unavailable. */}
    for(const session of this.attached.values())if(projectId==='projectless'?this.known.get(session.desktop.threadId)?.projectId==='projectless':path.resolve(session.desktop.state.cwd)===project.root){try{const {data}=await session.listThreads(identity,projectId);for(const row of data)this.known.set(row.id,{...this.known.get(row.id),...row,projectId});}catch{/* A disconnected task stays in the list for reconnection. */}}
    return {data:[...this.known.values()].filter(t=>t.projectId===projectId&&!t.archived&&t.kind!=='side').sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0)),nextCursor:null};
  }
  override async snapshot(identity:Identity,projectId:string,id:string):Promise<any>{const result=await(await this.session(identity,projectId,id)).snapshot(identity,projectId,id);return {...result,cursor:this.hub.cursor};}
  override async models(identity:Identity,projectId?:string,threadId?:string):Promise<any>{return (threadId&&projectId?await this.session(identity,projectId,threadId):this.attached.get(this.anchor.threadId)!).models(identity);}
  private checkProjectIdle(projectId:string,except?:string){if(projectId==='projectless')return;const project=this.config.value.projects.find(p=>p.id===projectId);if(this.projectWrites.has(projectId)||[...this.attached.values()].some(s=>s.desktop.threadId!==except&&path.resolve(s.desktop.state.cwd)===project?.root&&s.hasActiveWork))throw new ConsoleError(409,'PROJECT_BUSY','此目录中已有任务运行，请等待完成后再发送。');}
  override async send(identity:Identity,projectId:string,id:string,input:any):Promise<any>{this.project(identity,projectId,'send');this.checkProjectIdle(projectId,id);const key='send:'+id;this.projectWrites.set(projectId,key);try{return(await this.session(identity,projectId,id)).send(identity,projectId,id,input);}finally{if(this.projectWrites.get(projectId)===key)this.projectWrites.delete(projectId);}}
  override async interrupt(identity:Identity,projectId:string,id:string):Promise<any>{this.project(identity,projectId,'send');return(await this.session(identity,projectId,id)).interrupt(identity,projectId,id);}
  override async createThread():Promise<never>{throw new ConsoleError(409,'DESKTOP_FIRST_MESSAGE_REQUIRED','请在新任务输入首条消息后创建。');}
  private record(identity:Identity,requestId:string){requireAdmin(identity);const value=this.creations.get(`${identity.uuid}:${requestId}`);if(!value)throw new ConsoleError(404,'CREATION_NOT_FOUND','未找到这次创建请求。');this.project(identity,value.projectId,'send');return value;}
  override async taskCreation(identity:Identity,requestId:string):Promise<any>{const record=this.record(identity,requestId);return this.result(identity,record);}
  private async result(identity:Identity,record:Creation){
    const {fingerprint,key,userId,...publicRecord}=record;
    if(record.threadId)try{
      if(record.messageAccepted===null&&(this.tools||this.bridge?.available)){const read=this.bridge?.available?await this.bridge.rpc('thread/turns/list',{threadId:record.threadId,limit:1,itemsView:'summary',sortDirection:'desc'}):await this.tools!.readThread(record.threadId);if((this.bridge?.available?read.data:read.thread?.id===record.threadId?read.turns:[])?.some((t:any)=>validId(t.id)&&['inProgress','completed','failed','interrupted'].includes(t.status))){record.messageAccepted=true;record.message=undefined;await this.save();publicRecord.messageAccepted=true;publicRecord.message=undefined;}}
      const snapshot=await this.snapshot(identity,record.projectId,record.threadId);return {...publicRecord,thread:{id:snapshot.id,title:snapshot.title,status:snapshot.status},attached:true};}catch{return {...publicRecord,attached:false,message:record.message||'任务已创建，输出连接尚未就绪。请检查创建状态，不要重发首条消息。'};}
    return publicRecord;
  }
  override async createTask(identity:Identity,projectId:string,input:any):Promise<any>{
    if(this.bridge?.available)return this.createNativeTask(identity,projectId,input);
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
  private async matchesProject(project:Project,thread:any){
    if(typeof thread.cwd!=='string')return false;const cwd=await fs.realpath(thread.cwd).catch(()=>null);if(!cwd)return false;
    if(project.id==='projectless')return thread.projectId==null&&isWithin(this.projectlessRoot,cwd)&&!this.config.value.projects.some(p=>isWithin(p.root,cwd));
    return cwd===project.root&&(!project.desktopProjectId||thread.projectId==null||thread.projectId===project.desktopProjectId);
  }
  private async featureCatalog(root:string,refresh=false){
    if(!this.bridge?.available)throw new ConsoleError(503,'DESKTOP_BRIDGE_OFFLINE','桌面功能接口未连接。');
    const cached=this.featureCatalogs.get(root);if(!refresh&&cached&&Date.now()-cached.at<60000)return cached.value;
    const value=readCatalog((m,p)=>this.bridge!.rpc(m,p),root,refresh);this.featureCatalogs.set(root,{at:Date.now(),value});return value;
  }
  override async extensions(identity:Identity,projectId:string,refresh=false){const project=this.project(identity,projectId);return publicCatalog(await this.featureCatalog(project.root,refresh));}
  override async mcp(identity:Identity,projectId:string,id?:string){this.project(identity,projectId);if(id)await this.session(identity,projectId,id);if(!this.bridge?.available)throw new ConsoleError(503,'DESKTOP_BRIDGE_OFFLINE','MCP 接口未连接。');return readMcp((m,p)=>this.bridge!.rpc(m,p),id);}
  override async rateLimits(identity:Identity){if(!identity.uuid)throw new ConsoleError(401,'LOGIN_REQUIRED','请登录。');if(!this.bridge?.available)throw new ConsoleError(503,'DESKTOP_BRIDGE_OFFLINE','额度接口未连接。');return normalizeRateLimits(await this.bridge.rpc('account/rateLimits/read',{}));}
  override async consumeRateLimitReset(identity:Identity,requestId:string,creditId?:string){requireAdmin(identity);if(!this.bridge?.available)throw new ConsoleError(503,'DESKTOP_BRIDGE_OFFLINE','额度接口未连接。');if(creditId!==undefined&&(typeof creditId!=='string'||!creditId||creditId.length>256))throw new ConsoleError(400,'INVALID_CREDIT_ID','无效的重置卡 ID。');if(!/^[-a-zA-Z0-9_]{8,100}$/.test(requestId))throw new ConsoleError(400,'INVALID_REQUEST_ID','无效请求 ID。');return this.receipts.run(identity.uuid+':rate-limit-reset:'+requestId,async()=>{const result=await this.bridge!.rpc('account/rateLimitResetCredit/consume',{idempotencyKey:requestId,...(creditId?{creditId}:{})});return {outcome:typeof result?.outcome==='string'?result.outcome:'unknown',rateLimits:await this.rateLimits(identity)};});}
  override async goal(identity:Identity,projectId:string,id:string,objective?:string){
    this.project(identity,projectId,objective===undefined?'view':'send');await this.session(identity,projectId,id);
    if(!this.bridge?.available)return super.goal(identity,projectId,id,objective);
    if(objective!==undefined&&(typeof objective!=='string'||!objective.trim()||objective.length>4000))throw new ConsoleError(400,'INVALID_GOAL','目标为 1–4000 字。');
    const result=await this.bridge.rpc(objective===undefined?'thread/goal/get':'thread/goal/set',{threadId:id,...(objective===undefined?{}:{objective:objective.trim(),status:'active'})});
    const g=result.goal;return {goal:g?{objective:String(g.objective||''),status:String(g.status||''),tokensUsed:g.tokensUsed,timeUsedSeconds:g.timeUsedSeconds}:null};
  }
  private async createNativeTask(identity:Identity,projectId:string,input:any):Promise<any>{
    requireAdmin(identity);const project=this.project(identity,projectId,'send');
    if(typeof input.text!=='string'||!input.text.trim()||input.text.length>64000||!/^[-a-zA-Z0-9_]{8,100}$/.test(input.requestId||''))throw new ConsoleError(400,'INVALID_MESSAGE','请输入消息并提供有效请求 ID。');
    if(input.environment!=='local'||input.confirmCurrentDirectory!==true)throw new ConsoleError(400,'DIRECTORY_CONFIRMATION_REQUIRED','请确认聊天的工作目录。');
    if(input.attachments?.length||input.references?.length)throw new ConsoleError(400,'DESKTOP_NEW_ATTACHMENTS','首条消息可选技能、插件；文件附件请在创建后添加。');
    const overrides=input.settingsOverrides||[];if(!Array.isArray(overrides)||overrides.some((k:any)=>!['model','effort','mode','access'].includes(k)))throw new ConsoleError(400,'INVALID_SETTINGS','无效的新任务设置。');
    const fingerprint=createHash('sha256').update(JSON.stringify({projectId,input})).digest('hex'),key=identity.uuid+':'+input.requestId,prior=this.creations.get(key);
    if(prior){if(prior.fingerprint!==fingerprint)throw new ConsoleError(409,'CREATION_CHANGED','该请求 ID 已用于另一条消息。');return this.result(identity,await(this.creating.get(key)||prior));}
    if(this.creations.size>=500)throw new ConsoleError(429,'CREATION_LIMIT','创建记录已达上限。');
    const content:any[]=[{type:'text',text:input.text,text_elements:[]}];
    if(input.extensions!==undefined&&(!Array.isArray(input.extensions)||input.extensions.length>12))throw new ConsoleError(400,'INVALID_EXTENSIONS','最多选择 12 个技能或插件。');
    if(input.extensions?.length)content.push(...resolveExtensions(await this.featureCatalog(project.root,true),input.extensions));
    if(projectId!=='projectless'&&await fs.realpath(project.root).catch(()=>null)!==project.root)throw new ConsoleError(409,'ROOT_CHANGED','项目目录已改变，请重新选择。');
    const start:any={threadSource:'user',projectId:projectId==='projectless'?null:project.desktopProjectId||null};
    if(overrides.includes('model')||overrides.includes('effort')){const {data}=await this.models(identity);const model=data.find((m:any)=>m.model===input.model);if(!model)throw new ConsoleError(400,'MODEL_UNAVAILABLE','请选择桌面目录中的模型。');if(input.effort&&!model.supportedReasoningEfforts.some((r:any)=>r.reasoningEffort===input.effort))throw new ConsoleError(400,'EFFORT_UNAVAILABLE','此模型不支持该推理强度。');start.model=model.model;}
    if(overrides.includes('mode')&&!['code','plan'].includes(input.mode))throw new ConsoleError(400,'INVALID_MODE','无效的协作模式。');
    let turnOverrides:any={};if(overrides.includes('access')){if(!['default','read-only','full'].includes(input.access))throw new ConsoleError(400,'INVALID_ACCESS','无效的访问权限。');if(input.access==='full'&&input.confirmFullAccess!==true)throw new ConsoleError(400,'ACCESS_CONFIRMATION_REQUIRED','请确认完全访问权限。');turnOverrides.sandboxPolicy=input.access==='full'?{type:'dangerFullAccess'}:input.access==='read-only'?{type:'readOnly'}:{type:'workspaceWrite',writableRoots:[project.root]};turnOverrides.approvalPolicy=input.access==='full'?'never':'on-request';turnOverrides.approvalsReviewer='user';}if(overrides.includes('effort'))turnOverrides.effort=input.effort||null;if(overrides.includes('model'))turnOverrides.model=start.model;if(overrides.includes('mode'))turnOverrides.collaborationMode={mode:input.mode==='plan'?'plan':'default',settings:{model:start.model||null,reasoning_effort:input.effort||null,developer_instructions:null}};
    const concurrent=this.creations.get(key);if(concurrent){if(concurrent.fingerprint!==fingerprint)throw new ConsoleError(409,'CREATION_CHANGED','创建请求内容已改变。');return this.result(identity,await(this.creating.get(key)||concurrent));}this.checkProjectIdle(projectId);
    const row:Creation={key,userId:identity.uuid,requestId:input.requestId,projectId,fingerprint,at:Date.now(),status:'submitting'};this.creations.set(key,row);this.projectWrites.set(projectId,key);
    const work=(async()=>{try{await this.save();
      const cwd=projectId==='projectless'?(await this.bridge!.host('projectless-thread-cwd',{createSplitDirectories:false,prompt:input.text.slice(0,120)})).cwd:project.root;
      if(typeof cwd!=='string'||!path.isAbsolute(cwd)||projectId==='projectless'&&!isWithin(this.projectlessRoot,await fs.realpath(cwd)))throw new Error('Unexpected projectless workspace');
      const created=await this.bridge!.rpc('thread/start',{...start,cwd,runtimeWorkspaceRoots:[cwd]});const t=created.thread;
      if(!validId(t?.id)||await fs.realpath(t.cwd)!==await fs.realpath(cwd))throw new Error('Unexpected created task');
      row.threadId=t.id;row.status='ready';row.messageAccepted=false;
      this.known.set(t.id,{id:t.id,projectId,title:input.text.trim().slice(0,60),cwd:t.cwd,status:'idle',updatedAt:Date.now()});await this.save();
      if(turnOverrides.sandboxPolicy?.type==='workspaceWrite')turnOverrides.sandboxPolicy.writableRoots=[cwd];
      if(turnOverrides.collaborationMode){turnOverrides.collaborationMode.settings.model ||= created.model;turnOverrides.collaborationMode.settings.reasoning_effort ||= created.reasoningEffort||null;}
      // Persist an ambiguous-send marker before the sole first-turn call. No automatic replay.
      row.messageAccepted=null;await this.save();
      try{await this.bridge!.rpc('turn/start',{threadId:t.id,clientUserMessageId:input.requestId,input:content,...turnOverrides});row.messageAccepted=true;}
      catch(error){row.messageAccepted=error instanceof ConsoleError&&error.code==='DESKTOP_BRIDGE_REJECTED'?false:null;row.message=row.messageAccepted===false?'任务已创建，首条消息被拒绝。草稿已保留，可检查后重新发送。':'任务已创建，首条消息结果未知，请先查看桌面输出。';}
    }catch(error){if(!row.threadId){row.status=error instanceof ConsoleError&&error.code==='DESKTOP_BRIDGE_REJECTED'?'failed':'unknown';row.message=row.status==='failed'?'桌面未能创建任务。':'创建结果未知，请检查桌面任务列表，不要重复提交。';}else row.message='任务已创建，首条消息尚未发送，请检查任务后继续。';}finally{if(this.projectWrites.get(projectId)===key)this.projectWrites.delete(projectId);}await this.save();return row;})();
    this.creating.set(key,work);try{return this.result(identity,await work);}finally{this.creating.delete(key);}
  }
  override async taskAction(identity:Identity,projectId:string,id:string,action:string,input:any):Promise<any>{
    const project=this.project(identity,projectId,'send');if(!this.bridge?.available)throw new ConsoleError(503,'DESKTOP_BRIDGE_OFFLINE','桌面功能接口未连接。');
    const session=await this.session(identity,projectId,id);
    if(['pin','archive','fork','side','feedback'].includes(action))requireAdmin(identity);
    if(!['rename','pin','archive','fork','side','compact','review','feedback'].includes(action))throw new ConsoleError(400,'INVALID_ACTION','未知操作。');
    if(!/^[-a-zA-Z0-9_]{8,100}$/.test(input.requestId||''))throw new ConsoleError(400,'INVALID_REQUEST_ID','无效请求 ID。');
    if(['archive','fork','side','compact','review','feedback'].includes(action)&&input.confirmed!==true)throw new ConsoleError(400,'CONFIRMATION_REQUIRED','请确认操作。');
    if(['archive','fork','side','compact','review'].includes(action)&&session.hasActiveWork)throw new ConsoleError(409,'THREAD_BUSY','请等待本轮完成。');
    if(['fork','side','review','compact'].includes(action))this.checkProjectIdle(projectId,id);
    if(action==='rename'&&(typeof input.name!=='string'||!input.name.trim()||input.name.length>120))throw new ConsoleError(400,'INVALID_TITLE','标题为 1–120 字。');
    if(action==='pin'&&typeof input.pinned!=='boolean')throw new ConsoleError(400,'INVALID_PIN','无效的置顶状态。');
    if(action==='review'&&(input.target!=='uncommittedChanges'&&!(input.target==='baseBranch'&&typeof input.branch==='string'&&input.branch.trim()&&input.branch.length<=200)))throw new ConsoleError(400,'INVALID_REVIEW','请选择未提交更改或填写比较分支。');
    if(action==='feedback'&&(typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>4000))throw new ConsoleError(400,'INVALID_FEEDBACK','请填写反馈内容。');
    return this.receipts.run(identity.uuid+':action:'+id+':'+action+':'+input.requestId,async()=>{
      const rpc=(method:string,params:any)=>this.bridge!.rpc(method,params);
      const row=this.known.get(id)!;
      switch(action){
        case 'rename':await rpc('thread/name/set',{threadId:id,name:input.name.trim()});row.title=input.name.trim();break;
        case 'pin':{requireAdmin(identity);const result=await this.bridge!.host('set-thread-pinned',{threadId:id,pinned:input.pinned,useAppServerPins:true});if(result?.success!==true)throw new ConsoleError(502,'PIN_NOT_CONFIRMED','桌面未确认置顶更改，请刷新状态。');row.pinned=input.pinned;break;}
        case 'archive':requireAdmin(identity);await rpc('thread/archive',{threadId:id});row.archived=true;break;
        case 'compact':await session.desktop.request('thread-follower-compact-thread',{conversationId:id},1);break;
        case 'review':await rpc('review/start',{threadId:id,target:input.target==='baseBranch'?{type:'baseBranch',branch:input.branch.trim()}:{type:'uncommittedChanges'},delivery:'inline'});break;
        case 'feedback':requireAdmin(identity);await rpc('feedback/upload',{threadId:id,classification:'bug',reason:input.reason.trim(),includeLogs:false,extraLogFiles:[]});break;
        case 'fork':case 'side':{
          requireAdmin(identity);if(input.environment&&input.environment!=='same-directory')throw new ConsoleError(400,'UNSUPPORTED_FORK_ENVIRONMENT','网页目前仅支持当前目录分支。');
          const reply=await rpc('thread/fork',{threadId:id,ephemeral:action==='side',threadSource:'user',excludeTurns:true,deferGoalContinuation:true});
          if(!validId(reply.thread?.id)||!await this.matchesProject(project,reply.thread))throw new ConsoleError(502,'FORK_OUTCOME_UNKNOWN','分支结果未知，请检查桌面。');
          const t=reply.thread;this.known.set(t.id,{id:t.id,projectId,cwd:t.cwd,title:t.name||'分支 · '+row.title,status:runtimeStatus(t),kind:action==='side'?'side':'thread'});await this.save();
          return {ok:true,thread:{id:t.id,title:this.known.get(t.id)!.title,status:runtimeStatus(t)},temporary:action==='side'};
        }
      }
      await this.save();return {ok:true,...(action==='pin'?{pinned:row.pinned}:{})};
    });
  }

}
