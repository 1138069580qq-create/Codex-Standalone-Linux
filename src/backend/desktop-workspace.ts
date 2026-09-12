import {ensureStorage} from './account-storage';
import {projectReference} from './files';
import {accountProfile,verifyAccountProfile} from './account-isolation';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { type UsageLedger } from './usage';
import { CodexConsoleService } from './service';
import { MAIN_TURN_LIMIT, readMainThreads, isMainThread } from './concurrency';
import { ConsoleError, requireAdmin, isWithin, validateConfig, type Project, type ConfigStore, type Identity } from './config';
import { CommandReceipts } from './receipts';
import { DesktopNativeSession } from './desktop-native-session';
import { DesktopIpc } from './desktop-ipc';
import { DesktopSessionService } from './desktop-session';
import { type DesktopBridgeApi } from './desktop-bridge';
import { readCatalog, publicCatalog, resolveExtensions, readMcp, type Catalog } from './extensions';
import { DesktopModelCatalog } from './desktop-settings';
import { normalizeRateLimits } from './limits';
import { prepareProjectDirectory,materializeProjectDirectory,normalizeProjectCreation } from './projects';
import { runtimeStatus } from './normalize';
import { renameStateFile } from './state-file';
import type { DesktopTaskTools } from './desktop-tools';
const validId=(id:any)=>typeof id==='string'&&/^[-a-zA-Z0-9_]{1,128}$/.test(id);
interface Creation {key:string;userId:string;requestId:string;projectId:string;fingerprint:string;at:number;status:'submitting'|'ready'|'failed'|'unknown';threadId?:string;clientThreadId?:string;messageAccepted?:boolean|null;message?:string}
interface KnownTask {ownerId?:string;id:string;projectId:string;title:string;status:string;updatedAt?:number;cwd?:string;kind?:string;pinned?:boolean;archived?:boolean}
/** Adds explicit, user-driven task creation and switching to existing desktop IPC sessions. */
export class DesktopWorkspaceService extends CodexConsoleService {
  private attached=new Map<string,DesktopSessionService>();private desktopOpening=new Map<string,Promise<DesktopSessionService>>();
  private known=new Map<string,KnownTask>();private creations=new Map<string,Creation>();private creating=new Map<string,Promise<Creation>>();
  private projectWrites=new Map<string,string>();private projectCreationQueue:Promise<unknown>=Promise.resolve();
  private submissions=new Map<string,{fingerprint:string;promise:Promise<any>}>();
  private savedProjects:any[]=[];private management=false;private initialized=false;private flushing=Promise.resolve();
  private pendingOwners=new Map<string,string>();
  override attachUsage(usage:UsageLedger){super.attachUsage(usage);for(const session of this.attached.values()){session.attachUsage(usage);const project=this.config.value.projects.find(p=>p.root===path.resolve(session.desktop.state?.cwd||""));if(project?.ownerId)usage.bind(session.desktop.threadId,{uuid:project.ownerId,elevated:false},project.id);}}
  private maySee(identity:Identity,projectId:string,id:string){if(projectId!=="projectless")return !this.usage?.owner(id)||this.usage.owner(id)===identity.uuid;const owner=this.usage?.owner(id)||this.known.get(id)?.ownerId||[...this.creations.values()].find(r=>r.threadId===id)?.userId||this.config.value.defaultOwnerId;return owner?owner===identity.uuid:identity.elevated;}
  private featureCatalogs=new Map<string,{at:number,value:Promise<Catalog>}>();
  private bridgeProjects:any[]=[];private desktopSavedProjects:any[]=[];private projectlessRoot='';private projectRefresh?:Promise<void>;private projectRefreshAt=0;
  constructor(config:ConfigStore,receipts:CommandReceipts,readonly anchor:DesktopIpc,readonly tools:DesktopTaskTools|undefined,readonly stateFile:string,private makeSession=(ipc:DesktopIpc)=>new DesktopSessionService(config,receipts,ipc),private makeIpc=(id:string)=>new DesktopIpc(anchor.endpoint,id),readonly bridge?:DesktopBridgeApi){
    super(config,receipts);this.addSession(this.newSession(anchor));
  }
  protected override async readMainTurnStates(){
    if(this.bridge?.available)return readMainThreads(params=>this.bridge!.rpc('thread/list',params));
    if(this.management&&this.tools){const result=await this.tools.listThreads();return [...result.pinnedThreads||[],...result.threads||[]].filter((t:any)=>t.kind==='codex'&&t.hostId==='local'&&isMainThread(t));}
    return [...this.attached.values()].map(s=>({id:s.desktop.threadId,status:s.desktop.state?.threadRuntimeStatus}));
  }
  private newSession(ipc:DesktopIpc,binding?:Project){return this.bridge?new DesktopSessionService(this.config,this.receipts,ipc,new DesktopModelCatalog(),this.bridge,binding):this.makeSession(ipc);}
  private addSession(session:DesktopSessionService){session.useTurnGate(this.turnGate);if(this.usage)session.attachUsage(this.usage);this.attached.set(session.desktop.threadId,session);session.hub.subscribe(event=>{const {cursor,...rest}=event;if(event.type==='connection')this.hub.publish({...rest,payload:{connected:this.status({uuid:'',elevated:false}).connected}});else this.hub.publish(rest);});}
  private async save(){const write=this.flushing.catch(()=>{}).then(async()=>{await fs.mkdir(path.dirname(this.stateFile),{recursive:true,mode:0o700});const data={version:1,tasks:[...this.known.values()],creations:[...this.creations.values()]};await fs.writeFile(this.stateFile+'.tmp',JSON.stringify(data),{mode:0o600});await renameStateFile(this.stateFile+'.tmp',this.stateFile);});this.flushing=write;await write;}
  async initialize(){
    if(this.initialized)return;this.initialized=true;
    try{const data=JSON.parse(await fs.readFile(this.stateFile,'utf8'));for(const row of data.tasks||[])if(validId(row.id)&&(row.projectId==='projectless'||this.config.value.projects.some(p=>p.id===row.projectId)))this.known.set(row.id,row);for(const row of data.creations||[])if(validId(row.requestId)&&typeof row.userId==='string'){if(row.status==='submitting')row.status='unknown';this.creations.set(row.key,row);}}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
    const project=this.config.value.projects.find(p=>p.root===path.resolve(this.anchor.state.cwd));if(!project)throw new Error('Desktop project is not configured');
    this.known.set(this.anchor.threadId,{id:this.anchor.threadId,projectId:project.id,title:this.anchor.state.title||'桌面任务',status:'idle'});
    if(this.bridge)try{await this.bridge.connect();await this.syncDesktopProjects();}catch{/* Capabilities stay unavailable if the opt-in bridge is offline. */}
    if(this.tools)try{this.management=await this.tools.discover();if(this.management)this.savedProjects=(await this.tools.listProjects()).projects||[];}catch{this.management=false;}
  }
  protected override async readAccountMetadata(){if(!this.bridge?.available)throw new ConsoleError(503,'DESKTOP_BRIDGE_OFFLINE','账户接口未连接。');return this.bridge.rpc('account/read',{refreshToken:false});}
  override async connect(){await this.initialize();if(this.bridge&&!this.bridge.available)try{await this.bridge.connect();await this.syncDesktopProjects(true);}catch{};for(const session of this.attached.values())await session.connect();}
  override disconnect(){this.invalidateSubscription();for(const session of this.attached.values())session.disconnect();this.tools?.close();this.bridge?.close();}
  override get hasActiveWork(){return this.turnGate.count>0||this.creating.size>0||this.projectWrites.size>0||[...this.attached.values()].some(s=>s.hasActiveWork);}
  override status(identity:Identity):any{
    const base=this.attached.get(this.anchor.threadId)!.status(identity),native=!!this.bridge?.available;
    return {...base,maxConcurrentTurns:MAIN_TURN_LIMIT,connected:[...this.attached.values()].some(s=>s.desktop.connected),capabilities:{...base.capabilities,accountIsolation:this.config.value.accountIsolation===true,switchThreads:native||this.management,createWithMessage:(native||this.management)&&!!identity.uuid,projects:native&&!!this.bridge?.app&&!!identity.uuid,projectless:native&&!!identity.uuid,extensions:native,mcp:native,quota:native,resetQuota:native&&identity.elevated,setGoal:native,taskActions:native,firstMessageExtensions:native},creationMode:native?'desktop-native':'desktop-current-directory'};
  }
  override project(identity:Identity,id:string,capability:'view'|'send'|'approve'|'files'='view'):Project{
    if(id==='projectless'){if(!identity.uuid)throw new ConsoleError(401,'LOGIN_REQUIRED','请登录。');if(!this.config.value.enabled||!this.bridge?.available||!this.projectlessRoot)throw new ConsoleError(503,'PROJECTLESS_UNAVAILABLE','无项目对话接口尚未连接。');if(capability==='files')throw new ConsoleError(403,'PROJECTLESS_FILES','无项目对话不开放项目文件浏览。');return {id,name:'无项目对话',root:this.projectlessRoot,ownerId:identity.uuid,grants:[]};}
    return super.project(identity,id,capability);
  }
  override projects(identity:Identity):any[]{
    const native=!!this.bridge?.available;
    const rows=super.projects(identity).filter(p=>p.id!=='projectless').map(project=>({...project,kind:'project',desktopProjectId:this.config.value.projects.find(p=>p.id===project.id)?.desktopProjectId,desktopSavedProjectId:this.config.value.projects.find(p=>p.id===project.id)?.desktopSavedProjectId,canCreateTask:!!identity.uuid&&(native?!!this.config.value.projects.find(p=>p.id===project.id)?.desktopSavedProjectId:this.management&&this.savedProjects.some(p=>p.projectKind==='local'&&typeof p.path==='string'&&path.resolve(p.path)===project.root)),creationEnvironment:'local'}));
    if(native&&identity.uuid&&this.projectlessRoot)rows.push({id:'projectless',name:'无项目对话',root:'',permissions:{view:true,send:true,approve:true,files:false},activeCount:0,kind:'projectless',desktopProjectId:undefined,canCreateTask:true,creationEnvironment:'local'});
    return rows;
  }
  override async refreshProjects(identity:Identity){if(this.bridge?.available&&identity.uuid)await this.syncDesktopProjects();return this.projects(identity);}
  private async syncDesktopProjects(force=false){
    if(this.projectRefresh){await this.projectRefresh;if(!force)return;}if(!force&&Date.now()-this.projectRefreshAt<10000)return;
    const work=(async()=>{
      const backend:any[]=[];let cursor:string|undefined;
      for(let page=0;page<20;page++){const result=await this.bridge!.rpc('project/list',{limit:100,...(cursor?{cursor}:{})});backend.push(...(result.data||[]));if(!result.nextCursor)break;if(result.nextCursor===cursor||page===19)throw new ConsoleError(502,'PROJECT_LIST_INCOMPLETE','桌面项目列表未完整返回。');cursor=result.nextCursor;}
      this.bridgeProjects=backend;
      if(!this.bridge!.app)throw new ConsoleError(503,'DESKTOP_PROJECTS_UNAVAILABLE','桌面已保存项目接口不可用。');
      const [saved,mapping]=await Promise.all([this.bridge!.app('projects.list',{}),this.bridge!.host('get-global-state',{key:'app-server-project-id-by-legacy-project-id-by-host'})]);
      if(!saved||typeof saved!=='object'||Array.isArray(saved))throw new ConsoleError(502,'PROJECT_SYNC_FAILED','桌面已保存项目列表无效。');
      this.desktopSavedProjects=Object.values(saved).filter((p:any)=>validId(p.id)&&typeof p.name==='string'&&Array.isArray(p.rootPaths));
      const maps=Object.values(mapping?.value||{}).filter((m:any)=>m&&typeof m==='object') as Record<string,string>[];
      const projects=this.config.value.projects.map(p=>{const copy={...p};delete copy.desktopSavedProjectId;return copy;});
      for(const savedProject of this.desktopSavedProjects){
        const mappedIds=new Set(maps.map(m=>m[savedProject.id]).filter(validId));
        for(const root of savedProject.rootPaths){if(typeof root!=='string')continue;const canonical=await fs.realpath(root).catch(()=>null);if(!canonical)continue;
          const matches=[];for(const p of backend){if(!validId(p.id))continue;for(const r of p.roots||[])if(typeof r.path==='string'&&await fs.realpath(r.path).catch(()=>null)===canonical){matches.push(p);break;}}
          const mapped=matches.filter(p=>mappedIds.has(p.id)||p.id===savedProject.id),chosen=mapped.length===1?mapped[0]:mapped.length===0&&matches.length===1?matches[0]:null;
          if(!chosen)continue;
          const prior=projects.find(p=>p.root===canonical);
          if(prior){if(prior.desktopSavedProjectId&&prior.desktopSavedProjectId!==savedProject.id)continue;Object.assign(prior,{name:savedProject.name.slice(0,100),desktopProjectId:chosen.id,desktopSavedProjectId:savedProject.id});continue;}
          const entry={id:'p-'+createHash('sha256').update(chosen.id+canonical).digest('hex').slice(0,20),name:savedProject.name.slice(0,100),root:canonical,ownerId:this.pendingOwners.get(canonical)||this.config.value.defaultOwnerId,grants:[],desktopProjectId:chosen.id,desktopSavedProjectId:savedProject.id};
          try{await validateConfig({...this.config.value,projects:[...projects,entry]});const privateDir=path.dirname(this.config.file);if(isWithin(canonical,privateDir)||isWithin(privateDir,canonical))continue;projects.push(entry);}catch{/* Never expose overlapping or private roots. */}
        }
      }
      if(JSON.stringify(projects)!==JSON.stringify(this.config.value.projects))await this.config.save({...this.config.value,projects});
      const root=await this.bridge!.host('projectless-workspace-root',{}).catch(()=>null);
      if(typeof root?.workspaceRoot==='string')this.projectlessRoot=await fs.realpath(root.workspaceRoot).catch(()=>path.resolve(root.workspaceRoot));
      this.projectRefreshAt=Date.now();
    })();this.projectRefresh=work;try{await work;}finally{this.projectRefresh=undefined;}
  }
  override async createProject(identity:Identity,input:any){
    if(!identity.uuid)throw new ConsoleError(401,"LOGIN_REQUIRED","请登录。");if(input?.folderName===undefined)requireAdmin(identity);input=await normalizeProjectCreation(input,identity.uuid);if(!this.bridge?.available||!this.bridge.app)throw new ConsoleError(503,'DESKTOP_BRIDGE_OFFLINE','桌面已保存项目接口未连接。');
    const prepared=await prepareProjectDirectory(this.config,input),canonical=prepared.root;
    return this.receipts.run(identity.uuid+':project:'+input.requestId,()=>{const work=this.projectCreationQueue.catch(()=>{}).then(async()=>{
      await materializeProjectDirectory(this.config,prepared,input.name.trim());
      this.pendingOwners.set(canonical,identity.uuid);
      await this.syncDesktopProjects(true);
      const prior=this.config.value.projects.find(p=>p.root===canonical);
      if(prior?.ownerId&&prior.ownerId!==identity.uuid)throw new ConsoleError(403,"PROJECT_FORBIDDEN","项目属于另一个网页账户。");
      if(!prior?.desktopSavedProjectId){
        const result=await this.bridge!.app!('projects.create',{name:input.name.trim(),root:canonical});
        if(!validId(result?.projectId)||!Array.isArray(result.rootPaths)||!result.rootPaths.some((r:any)=>typeof r==='string'&&path.resolve(r)===canonical))throw new ConsoleError(502,'PROJECT_OUTCOME_UNKNOWN','桌面项目创建结果未知，请刷新项目列表检查。');
        await this.syncDesktopProjects(true);
        const registered=this.config.value.projects.find(p=>p.root===canonical&&p.desktopSavedProjectId===result.projectId);
        if(!registered?.desktopProjectId)throw new ConsoleError(502,'PROJECT_SYNC_FAILED','项目未能同步到桌面项目列表，未创建聊天。');
      }
      const registered=this.config.value.projects.find(p=>p.root===canonical)!;
      if(!registered.ownerId){registered.ownerId=identity.uuid;await this.config.save(this.config.value);}
      this.pendingOwners.delete(canonical);
      // Only repair tasks previously created by this WebUI in this exact project. No new tasks/turns.
      for(const row of this.creations.values())if(row.threadId&&row.projectId===registered.id){
        const reply=await this.bridge!.rpc('thread/read',{threadId:row.threadId,includeTurns:false});const t=reply.thread;
        if(t?.id!==row.threadId||typeof t.cwd!=='string'||await fs.realpath(t.cwd).catch(()=>null)!==canonical||!this.bridgeProjects.some(p=>p.id===t.projectId&&(p.roots||[]).some((r:any)=>typeof r.path==='string'&&path.resolve(r.path)===canonical)))continue;
        await this.assignDesktopProject(registered,t.id,t.projectId);
      }
      return this.projects(identity).find(p=>p.id===registered.id);
    });this.projectCreationQueue=work;return work.finally(()=>this.pendingOwners.delete(canonical));});
  }
  private async assignDesktopProject(project:Project,threadId:string,currentProjectId?:string){
    if(!project.desktopProjectId||!project.desktopSavedProjectId||!this.bridge?.app)throw new ConsoleError(409,'DESKTOP_PROJECT_NOT_REGISTERED','该目录尚未保存为桌面项目，请先添加项目。');
    if(currentProjectId!==project.desktopProjectId)await this.bridge.rpc('thread/metadata/update',{threadId,projectId:project.desktopProjectId});
    await this.bridge.app('threads.assignProject',{threadId,projectId:project.desktopSavedProjectId});
  }
  private async session(identity:Identity,projectId:string,id:string){
    const project=this.project(identity,projectId);if(!this.maySee(identity,projectId,id))throw new ConsoleError(403,'THREAD_FORBIDDEN','此聊天属于另一个网页账户。');if(!validId(id))throw new ConsoleError(400,'INVALID_THREAD','无效的任务 ID。');
    const existing=this.attached.get(id);if(existing){this.usage?.bind(id,identity,projectId);if(projectId==='projectless'?this.known.get(id)?.projectId!=='projectless':path.resolve(existing.desktop.state.cwd)!==project.root)throw new ConsoleError(403,'THREAD_FORBIDDEN','任务不属于此项目。');if(!existing.desktop.connected)await existing.connect();if(await fs.realpath(existing.desktop.state.cwd).catch(()=>null)!==existing.project(identity,projectId).root)throw new ConsoleError(403,'THREAD_FORBIDDEN','任务目录已改变。');return existing;}
    const openingKey=projectId+':'+id;const inFlight=this.desktopOpening.get(openingKey);if(inFlight)return inFlight;
    const pending=(async()=>{
      if(!this.bridge?.available&&(!this.management||!this.tools))throw new ConsoleError(501,'DESKTOP_MANAGEMENT_UNAVAILABLE','当前桌面连接不支持切换任务。');
      const result=this.bridge?.available?await this.bridge.rpc('thread/read',{threadId:id,includeTurns:false}):await this.tools!.readThread(id),thread=result.thread;
      if(thread?.id!==id||(!this.bridge?.available&&(thread.kind!=='codex'||thread.hostId!=='local'))||typeof thread.cwd!=='string'||!(await this.matchesProject(project,thread)))throw new ConsoleError(403,'THREAD_FORBIDDEN','任务不属于此项目。');
      if(this.attached.size>=16)throw new ConsoleError(429,'DESKTOP_SESSION_LIMIT','已连接 16 个任务，请重启 WebUI 后再打开更多任务。');
      this.usage?.bind(id,identity,projectId,thread.model,thread.modelProvider);
      this.known.set(id,{...this.known.get(id),id,projectId,title:thread.name||thread.title||this.known.get(id)?.title||id,status:runtimeStatus(thread),updatedAt:thread.updatedAt,cwd:thread.cwd});
      const ipc=this.bridge?.watch?new DesktopNativeSession(this.anchor.endpoint,id,this.bridge):this.makeIpc(id);try{await ipc.connect();if(await fs.realpath(ipc.state.cwd)!==await fs.realpath(thread.cwd))throw new ConsoleError(403,'THREAD_FORBIDDEN','任务工作目录已改变。');const session=this.newSession(ipc,projectId==='projectless'?{...project,root:await fs.realpath(thread.cwd)}:undefined);this.addSession(session);await session.connect();await this.save();return session;}catch(error){ipc.close();throw error;}
    })();this.desktopOpening.set(openingKey,pending);try{return await pending;}finally{if(this.desktopOpening.get(openingKey)===pending)this.desktopOpening.delete(openingKey);}
  }
  override async listThreads(identity:Identity,projectId:string):Promise<any>{
    const project=this.project(identity,projectId);
    if(this.bridge?.available){const result=await this.bridge.rpc('thread/list',{limit:100,archived:false,modelProviders:[],...(projectId==='projectless'?{projectId:null}:{cwd:project.root})});for(const t of result.data||[])if(validId(t.id)&&this.maySee(identity,projectId,t.id)&&await this.matchesProject(project,t)){const prior=this.known.get(t.id);this.known.set(t.id,{...prior,archived:false,id:t.id,projectId,title:t.name||t.preview||t.id,status:runtimeStatus(t),pinned:t.section?.id==='01984de2-8f74-7c91-a3b2-5c5e937cf318',updatedAt:t.updatedAt,cwd:t.cwd});}}
    else if(this.management&&this.tools)try{const result=await this.tools.listThreads();for(const thread of [...result.pinnedThreads||[],...result.threads||[]])if(thread.kind==='codex'&&thread.hostId==='local'&&validId(thread.id)&&typeof thread.cwd==='string'&&path.resolve(thread.cwd)===project.root)this.known.set(thread.id,{id:thread.id,projectId,title:thread.title||thread.id,status:thread.status||'idle',updatedAt:thread.updatedAt});}catch{/* Known tasks stay available if listing is temporarily unavailable. */}
    for(const session of this.attached.values())if(projectId==='projectless'?this.known.get(session.desktop.threadId)?.projectId==='projectless':path.resolve(session.desktop.state.cwd)===project.root){try{const {data}=await session.listThreads(identity,projectId);for(const row of data)this.known.set(row.id,{...this.known.get(row.id),...row,projectId});}catch{/* A disconnected task stays in the list for reconnection. */}}
    return {data:[...this.known.values()].filter(t=>t.projectId===projectId&&this.maySee(identity,projectId,t.id)&&!t.archived&&t.kind!=='side').sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0)),nextCursor:null};
  }
  override async snapshot(identity:Identity,projectId:string,id:string):Promise<any>{const result=await(await this.session(identity,projectId,id)).snapshot(identity,projectId,id);return {...result,metrics:this.usageSnapshot(id),cursor:this.hub.cursor};}
  override async models(identity:Identity,projectId?:string,threadId?:string):Promise<any>{return (threadId&&projectId?await this.session(identity,projectId,threadId):this.attached.get(this.anchor.threadId)!).models(identity);}
  private checkProjectIdle(projectId:string,except?:string){if(projectId==='projectless')return;const project=this.config.value.projects.find(p=>p.id===projectId);if(this.projectWrites.has(projectId)||[...this.attached.values()].some(s=>s.desktop.threadId!==except&&path.resolve(s.desktop.state.cwd)===project?.root&&s.hasActiveWork))throw new ConsoleError(409,'PROJECT_BUSY','此目录中已有任务运行，请等待完成后再发送。');}
  override async send(identity:Identity,projectId:string,id:string,input:any):Promise<any>{this.project(identity,projectId,'send');this.checkProjectIdle(projectId,id);const key='send:'+id;this.projectWrites.set(projectId,key);try{return await(await this.session(identity,projectId,id)).send(identity,projectId,id,input);}finally{if(this.projectWrites.get(projectId)===key)this.projectWrites.delete(projectId);}}
  override async interrupt(identity:Identity,projectId:string,id:string):Promise<any>{this.project(identity,projectId,'send');return(await this.session(identity,projectId,id)).interrupt(identity,projectId,id);}
  override async createThread():Promise<never>{throw new ConsoleError(409,'DESKTOP_FIRST_MESSAGE_REQUIRED','请在新任务输入首条消息后创建。');}
  private record(identity:Identity,requestId:string){if(!identity.uuid)throw new ConsoleError(401,"LOGIN_REQUIRED","请登录。");const value=this.creations.get(`${identity.uuid}:${requestId}`);if(!value)throw new ConsoleError(404,'CREATION_NOT_FOUND','未找到这次创建请求。');this.project(identity,value.projectId,'send');return value;}
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
    this.project(identity,projectId,'send');
    const key=identity.uuid+':'+String(input?.requestId),fingerprint=createHash('sha256').update(JSON.stringify({projectId,input})).digest('hex'),existing=this.submissions.get(key);
    if(existing){if(existing.fingerprint!==fingerprint)throw new ConsoleError(409,'CREATION_CHANGED','创建请求内容已改变。');return existing.promise;}
    const isNew=!this.creations.has(key);if(isNew){this.checkProjectIdle(projectId);this.projectWrites.set(projectId,key);}
    const promise=this.createTaskOnce(identity,projectId,input);this.submissions.set(key,{fingerprint,promise});try{return await promise;}finally{if(this.submissions.get(key)?.promise===promise)this.submissions.delete(key);if(this.projectWrites.get(projectId)===key)this.projectWrites.delete(projectId);}
  }
  private async createTaskOnce(identity:Identity,projectId:string,input:any):Promise<any>{
    const project=this.project(identity,projectId,'send');
    if(!this.management||!this.tools)throw new ConsoleError(501,'DESKTOP_MANAGEMENT_UNAVAILABLE','桌面任务管理接口不可用。');
    if(!/^[-a-zA-Z0-9_]{8,100}$/.test(input?.requestId||'')||typeof input.text!=='string'||!input.text.trim()||input.text.length>64000)throw new ConsoleError(400,'INVALID_MESSAGE','请输入消息并提供有效请求 ID。');
    if(input.environment!=='local'||input.confirmCurrentDirectory!==true)throw new ConsoleError(400,'DIRECTORY_CONFIRMATION_REQUIRED','请确认在当前项目目录创建任务。');
    if(this.config.value.accountIsolation)throw new ConsoleError(503,'ISOLATION_UNAVAILABLE','当前旧版创建接口不支持账号隔离。');
    if(input.attachments?.length||input.references?.length||input.extensions?.length)throw new ConsoleError(400,'DESKTOP_FIRST_MESSAGE_TEXT_ONLY','新任务首条消息仅支持文本；创建后可继续添加附件。');
    const overrides=input.settingsOverrides||[];if(!Array.isArray(overrides)||overrides.some((v:any)=>!['model','effort'].includes(v)))throw new ConsoleError(400,'DESKTOP_NEW_SETTINGS','新任务权限和模式使用桌面设置；此处只能选择模型及强度。');
    const fingerprint=createHash('sha256').update(JSON.stringify({projectId,text:input.text,model:input.model,effort:input.effort,overrides,environment:input.environment})).digest('hex'),key=`${identity.uuid}:${input.requestId}`;
    const existing=this.creations.get(key);if(existing){if(existing.fingerprint!==fingerprint)throw new ConsoleError(409,'CREATION_CHANGED','此请求 ID 已用于另一条消息。请先检查原创建结果。');return this.result(identity,await(this.creating.get(key)||existing));}
    if(this.creations.size>=500)throw new ConsoleError(429,'CREATION_LIMIT','创建记录已达上限，请先由管理员整理。');
    const saved=(await this.tools.listProjects()).projects?.find((p:any)=>p.projectKind==='local'&&typeof p.path==='string'&&path.resolve(p.path)===project.root);if(!saved)throw new ConsoleError(409,'PROJECT_NOT_SAVED','请先在桌面中保存此项目，再从网页创建任务。');
    const args:any={prompt:input.text,title:input.text.trim().slice(0,60),target:{type:'project',projectId:saved.projectId,environment:{type:'local'}}};
    if(overrides.includes('model')||overrides.includes('effort')){const {data}=await this.models(identity);const selected=data.find((m:any)=>m.model===input.model);if(!selected)throw new ConsoleError(400,'MODEL_UNAVAILABLE','请选择桌面目录中的模型。');args.model=selected.model;if(input.effort){if(!selected.supportedReasoningEfforts.some((r:any)=>r.reasoningEffort===input.effort))throw new ConsoleError(400,'EFFORT_UNAVAILABLE','此模型不支持该推理强度。');args.thinking=input.effort;}}
    const slot=await this.turnGate.acquire();
    // Persist before the only mutating request. Reloads/timeouts never recreate a task.
    const row:Creation={key,userId:identity.uuid,requestId:input.requestId,projectId,fingerprint,at:Date.now(),status:'submitting'};this.creations.set(key,row);
    const work=(async()=>{try{await this.save();slot.submit();const reply=await this.tools!.createTask(args,createHash('sha256').update(key).digest('hex'));if(reply.hostId&&reply.hostId!=='local')throw new Error('Unexpected remote host');
      const id=reply.threadId||reply.conversationId;
      if(validId(id)){slot.bind(id);this.usage?.bind(id,identity,projectId,undefined,undefined,true);row.threadId=id;row.status='ready';row.messageAccepted=reply.threadId?true:reply.firstTurn?.status==='accepted'?true:['not-started','rejected','not-requested'].includes(reply.firstTurn?.status)?false:null;if(row.messageAccepted!==true)row.message=row.messageAccepted===false?'任务已创建，但首条消息未开始。可在该任务中手动重新发送。':'任务已创建，但首条消息是否开始尚未确认。请先查看输出，不要重复发送。';}
      else{row.status='unknown';if(typeof reply.clientThreadId==='string')row.clientThreadId=reply.clientThreadId;row.message='桌面创建结果尚未确认。请检查桌面任务列表，不要重复提交。';}
    }catch(error){row.status=error instanceof ConsoleError&&error.code==='DESKTOP_TOOL_REJECTED'?'failed':'unknown';row.message=row.status==='failed'?'桌面未能创建任务，请查看桌面错误。':'创建结果未知，请检查桌面任务列表，不要重复提交。';}await this.save();return row;})();this.creating.set(key,work);
    try{return await this.result(identity,await work);}finally{slot.finish(row.status==='failed'||row.messageAccepted===false?'rejected':row.messageAccepted===true?'running':'unknown');this.creating.delete(key);}
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
  override async configureLocalTools(identity:Identity,projectId:string,id:string,config:any){return(await this.session(identity,projectId,id)).configureLocalTools(identity,projectId,id,config);}
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
    const project=this.project(identity,projectId,'send');
    if(typeof input.text!=='string'||!input.text.trim()||input.text.length>64000||!/^[-a-zA-Z0-9_]{8,100}$/.test(input.requestId||''))throw new ConsoleError(400,'INVALID_MESSAGE','请输入消息并提供有效请求 ID。');
    if(input.environment!=='local'||input.confirmCurrentDirectory!==true)throw new ConsoleError(400,'DIRECTORY_CONFIRMATION_REQUIRED','请确认聊天的工作目录。');
    if(input.attachments?.length)throw new ConsoleError(400,'DESKTOP_NEW_ATTACHMENTS','首条消息请引用服务器文件库中的原文件。');if(input.references!==undefined&&(!Array.isArray(input.references)||input.references.length>12||input.references.some((r:unknown)=>typeof r!=='string'||!r.startsWith('@account/'))))throw new ConsoleError(400,'INVALID_REFERENCES','首条消息仅支持本账号文件库引用。');
    const overrides=input.settingsOverrides||[];if(!Array.isArray(overrides)||overrides.some((k:any)=>!['model','effort','mode','access'].includes(k)))throw new ConsoleError(400,'INVALID_SETTINGS','无效的新任务设置。');
    const fingerprint=createHash('sha256').update(JSON.stringify({projectId,input})).digest('hex'),key=identity.uuid+':'+input.requestId,prior=this.creations.get(key);
    if(prior){if(prior.fingerprint!==fingerprint)throw new ConsoleError(409,'CREATION_CHANGED','该请求 ID 已用于另一条消息。');return this.result(identity,await(this.creating.get(key)||prior));}
    if(this.creations.size>=500)throw new ConsoleError(429,'CREATION_LIMIT','创建记录已达上限。');
    const content:any[]=[{type:'text',text:input.text,text_elements:[]}];
    if(input.references?.length){if(!this.config.value.accountIsolation)throw new ConsoleError(503,'STORAGE_ISOLATION_REQUIRED','服务器尚未启用账号隔离文件库。');const root=await ensureStorage(this.config.file,identity);for(const ref of input.references)content[0].text+='\n\nAccount file reference (server original): '+path.join(root,await projectReference(root,ref.slice(9)));}
    if(input.extensions!==undefined&&(!Array.isArray(input.extensions)||input.extensions.length>12))throw new ConsoleError(400,'INVALID_EXTENSIONS','最多选择 12 个技能或插件。');
    if(input.extensions?.length)content.push(...resolveExtensions(await this.featureCatalog(project.root,true),input.extensions));
    if(projectId!=='projectless'&&await fs.realpath(project.root).catch(()=>null)!==project.root)throw new ConsoleError(409,'ROOT_CHANGED','项目目录已改变，请重新选择。');
    if(projectId!=='projectless'){await this.syncDesktopProjects(true);Object.assign(project,this.project(identity,projectId,'send'));if(!this.project(identity,projectId).desktopSavedProjectId)delete project.desktopSavedProjectId;}
    if(projectId!=='projectless'&&(!project.desktopProjectId||!project.desktopSavedProjectId))throw new ConsoleError(409,'DESKTOP_PROJECT_NOT_REGISTERED','该目录尚未保存为桌面项目，请先添加项目；不会改成无项目聊天发送。');
    const start:any={threadSource:'user',ephemeral:false,projectId:projectId==='projectless'?null:project.desktopProjectId};
    if(overrides.includes('model')||overrides.includes('effort')){const {data}=await this.models(identity);const model=data.find((m:any)=>m.model===input.model);if(!model)throw new ConsoleError(400,'MODEL_UNAVAILABLE','请选择桌面目录中的模型。');if(input.effort&&!model.supportedReasoningEfforts.some((r:any)=>r.reasoningEffort===input.effort))throw new ConsoleError(400,'EFFORT_UNAVAILABLE','此模型不支持该推理强度。');start.model=model.model;}
    if(overrides.includes('mode')&&!['code','plan'].includes(input.mode))throw new ConsoleError(400,'INVALID_MODE','无效的协作模式。');
    let turnOverrides:any={};if(overrides.includes('access')){if(!['default','read-only','full'].includes(input.access))throw new ConsoleError(400,'INVALID_ACCESS','无效的访问权限。');if(input.access==='full'&&input.confirmFullAccess!==true)throw new ConsoleError(400,'ACCESS_CONFIRMATION_REQUIRED','请确认完全访问权限。');turnOverrides.sandboxPolicy=input.access==='full'?{type:'dangerFullAccess'}:input.access==='read-only'?{type:'readOnly'}:{type:'workspaceWrite',writableRoots:[project.root]};turnOverrides.approvalPolicy=input.access==='full'?'never':'on-request';turnOverrides.approvalsReviewer='user';}if(overrides.includes('effort'))turnOverrides.effort=input.effort||null;if(overrides.includes('model'))turnOverrides.model=start.model;if(overrides.includes('mode'))turnOverrides.collaborationMode={mode:input.mode==='plan'?'plan':'default',settings:{model:start.model||null,reasoning_effort:input.effort||null,developer_instructions:null}};

    const concurrent=this.creations.get(key);if(concurrent){if(concurrent.fingerprint!==fingerprint)throw new ConsoleError(409,'CREATION_CHANGED','创建请求内容已改变。');return this.result(identity,await(this.creating.get(key)||concurrent));}this.checkProjectIdle(projectId);
    const slot=await this.turnGate.acquire();
    const admitted=this.creations.get(key);if(admitted){slot.finish('rejected');if(admitted.fingerprint!==fingerprint)throw new ConsoleError(409,'CREATION_CHANGED','创建请求内容已改变。');return this.result(identity,await(this.creating.get(key)||admitted));}
    try{this.checkProjectIdle(projectId);}catch(error){slot.finish('rejected');throw error;}
    const row:Creation={key,userId:identity.uuid,requestId:input.requestId,projectId,fingerprint,at:Date.now(),status:'submitting'};this.creations.set(key,row);this.projectWrites.set(projectId,key);
    const work=(async()=>{try{await this.save();
      const cwd=projectId==='projectless'?(await this.bridge!.host('projectless-thread-cwd',{createSplitDirectories:false,prompt:input.text.slice(0,120)})).cwd:project.root;
      if(typeof cwd!=='string'||!path.isAbsolute(cwd)||projectId==='projectless'&&!isWithin(this.projectlessRoot,await fs.realpath(cwd)))throw new Error('Unexpected projectless workspace');
      const isolated=this.config.value.accountIsolation?await accountProfile(this.config,identity,cwd,input.access,(m,p)=>this.bridge!.rpc(m,p)):null;
      const created=await this.bridge!.rpc('thread/start',{...start,cwd,runtimeWorkspaceRoots:[cwd],...(isolated?{approvalPolicy:'never',config:isolated.config}:{})});if(isolated){verifyAccountProfile(created,isolated);delete turnOverrides.sandboxPolicy;turnOverrides.approvalPolicy='never';}const t=created.thread;
      if(!validId(t?.id)||await fs.realpath(t.cwd)!==await fs.realpath(cwd))throw new Error('Unexpected created task');
      this.usage?.bind(t.id,identity,projectId,start.model||created.model||t.model,t.modelProvider,true);
      slot.bind(t.id);row.threadId=t.id;row.status='ready';row.messageAccepted=false;
      this.known.set(t.id,{id:t.id,projectId,title:input.text.trim().slice(0,60),cwd:t.cwd,status:'idle',updatedAt:Date.now()});await this.save();
      if(projectId!=='projectless')await this.assignDesktopProject(project,t.id,t.projectId);
      if(turnOverrides.sandboxPolicy?.type==='workspaceWrite')turnOverrides.sandboxPolicy.writableRoots=[cwd];
      if(turnOverrides.collaborationMode){turnOverrides.collaborationMode.settings.model ||= created.model;turnOverrides.collaborationMode.settings.reasoning_effort ||= created.reasoningEffort||null;}
      // Persist an ambiguous-send marker before the sole first-turn call. No automatic replay.
      row.messageAccepted=null;await this.save();
      try{slot.submit();const sent=await this.bridge!.rpc('turn/start',{threadId:t.id,clientUserMessageId:input.requestId,input:content,...turnOverrides});row.messageAccepted=true;slot.finish(sent.turn?.status&&runtimeStatus(sent.turn)!=='running'?'complete':'running',sent.turn?.id);}
      catch(error){row.messageAccepted=error instanceof ConsoleError&&error.code==='DESKTOP_BRIDGE_REJECTED'?false:null;row.message=row.messageAccepted===false?'任务已创建，首条消息被拒绝。草稿已保留，可检查后重新发送。':'任务已创建，首条消息结果未知，请先查看桌面输出。';}
    }catch(error){if(!row.threadId){row.status=error instanceof ConsoleError&&error.code==='DESKTOP_BRIDGE_REJECTED'?'failed':'unknown';row.message=row.status==='failed'?'桌面未能创建任务。':'创建结果未知，请检查桌面任务列表，不要重复提交。';}else row.message='任务已创建，首条消息尚未发送，请检查任务后继续。';}finally{slot.finish(row.status==='failed'||row.messageAccepted===false?'rejected':row.messageAccepted===true?'running':'unknown');if(this.projectWrites.get(projectId)===key)this.projectWrites.delete(projectId);}await this.save();return row;})();
    this.creating.set(key,work);try{return this.result(identity,await work);}finally{this.creating.delete(key);}
  }
  override async taskAction(identity:Identity,projectId:string,id:string,action:string,input:any):Promise<any>{
    const project=this.project(identity,projectId,'send');if(!this.bridge?.available)throw new ConsoleError(503,'DESKTOP_BRIDGE_OFFLINE','桌面功能接口未连接。');
    const session=await this.session(identity,projectId,id);
    if(this.config.value.accountIsolation&&['review','compact'].includes(action))throw new ConsoleError(503,'ISOLATED_ACTION_UNAVAILABLE','隔离模式暂不支持此后台模型操作，请在普通消息中提出请求。');

    if(!['rename','pin','archive','fork','side','compact','review','feedback'].includes(action))throw new ConsoleError(400,'INVALID_ACTION','未知操作。');
    if(!/^[-a-zA-Z0-9_]{8,100}$/.test(input.requestId||''))throw new ConsoleError(400,'INVALID_REQUEST_ID','无效请求 ID。');
    if(['archive','fork','side','compact','review','feedback'].includes(action)&&input.confirmed!==true)throw new ConsoleError(400,'CONFIRMATION_REQUIRED','请确认操作。');
    if(['archive','fork','side','compact','review'].includes(action)&&session.hasActiveWork)throw new ConsoleError(409,'THREAD_BUSY','请等待本轮完成。');
    if(['fork','side','review','compact'].includes(action))this.checkProjectIdle(projectId,id);
    if(action==='rename'&&(typeof input.name!=='string'||!input.name.trim()||input.name.length>120))throw new ConsoleError(400,'INVALID_TITLE','标题为 1–120 字。');
    if(action==='pin'&&typeof input.pinned!=='boolean')throw new ConsoleError(400,'INVALID_PIN','无效的置顶状态。');
    if(action==='review'&&(input.target!=='uncommittedChanges'&&!(input.target==='baseBranch'&&typeof input.branch==='string'&&input.branch.trim()&&input.branch.length<=200)))throw new ConsoleError(400,'INVALID_REVIEW','请选择未提交更改或填写比较分支。');
    if(action==='feedback'&&(typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>4000))throw new ConsoleError(400,'INVALID_FEEDBACK','请填写反馈内容。');
    return this.receipts.run(identity.uuid+':action:'+id+':'+action+':'+input.requestId,async markSubmitted=>{
      const rpc=(method:string,params:any)=>this.bridge!.rpc(method,params);
      const row=this.known.get(id)!;
      switch(action){
        case 'rename':await rpc('thread/name/set',{threadId:id,name:input.name.trim()});row.title=input.name.trim();break;
        case 'pin':{const result=await this.bridge!.host('set-thread-pinned',{threadId:id,pinned:input.pinned,useAppServerPins:true});if(result?.success!==true)throw new ConsoleError(502,'PIN_NOT_CONFIRMED','桌面未确认置顶更改，请刷新状态。');row.pinned=input.pinned;break;}
        case 'archive':await rpc('thread/archive',{threadId:id});row.archived=true;break;
        case 'compact':await this.mainAction(id,()=>session.desktop.request('thread-follower-compact-thread',{conversationId:id},1),markSubmitted);break;
        case 'review':await this.mainAction(id,()=>rpc('review/start',{threadId:id,target:input.target==='baseBranch'?{type:'baseBranch',branch:input.branch.trim()}:{type:'uncommittedChanges'},delivery:'inline'}),markSubmitted);break;
        case 'feedback':await rpc('feedback/upload',{threadId:id,classification:'bug',reason:input.reason.trim(),includeLogs:false,extraLogFiles:[]});break;
        case 'fork':case 'side':{
          if(input.environment&&input.environment!=='same-directory')throw new ConsoleError(400,'UNSUPPORTED_FORK_ENVIRONMENT','网页目前仅支持当前目录分支。');
          const reply=await rpc('thread/fork',{threadId:id,ephemeral:action==='side',threadSource:'user',excludeTurns:true,deferGoalContinuation:true});
          if(!validId(reply.thread?.id)||!await this.matchesProject(project,reply.thread))throw new ConsoleError(502,'FORK_OUTCOME_UNKNOWN','分支结果未知，请检查桌面。');
          const t=reply.thread;this.usage?.bind(t.id,identity,projectId,t.model,t.modelProvider);this.known.set(t.id,{ownerId:identity.uuid,id:t.id,projectId,cwd:t.cwd,title:t.name||'分支 · '+row.title,status:runtimeStatus(t),kind:action==='side'?'side':'thread'});await this.save();
          return {ok:true,thread:{id:t.id,title:this.known.get(t.id)!.title,status:runtimeStatus(t)},temporary:action==='side'};
        }
      }
      await this.save();return {ok:true,...(action==='pin'?{pinned:row.pinned}:{})};
    },{trackSubmission:['compact','review'].includes(action)});
  }

}
