import {accountProfile,verifyAccountProfile,isolateAccountThread} from './account-isolation';
import {STORAGE_ID,storagePath,ensureStorage} from './account-storage';
import { IsolatedHistoryReader } from './history-reader';
import { promises as fs } from "fs";
import { randomUUID, createHash } from "crypto";
import path from "node:path";
import { CodexRpcClient } from "./transport";
import {
  ConsoleError,
  ConfigStore,
  Identity,
  Project,
  requireProject,
  requireAdmin,
  permissions
} from "./config";
import { normalizeSubscription, unavailableSubscription, type AccountSubscription } from "./subscription";
import { UsageLedger } from "./usage";
import { accountDirectoryName } from "./projects";
import { ReplayHub } from "./events";
import { normalizeTokenUsage, restoredTokenUsage, type TokenUsage } from "./context";
import { textPrefix } from "./text";
import { MainTurnGate, MAIN_TURN_LIMIT, readMainThreads } from "./concurrency";
import {
  MAX_ITEM_CHARS,
  normalizeItem,
  runtimeStatus,
  threadTitle,
  TimelineItem, turnTiming, type TurnTiming
} from "./normalize";
import { prepareProjectDirectory,materializeProjectDirectory,normalizeProjectCreation,defaultProjectDirectory } from './projects';
import { CommandReceipts } from "./receipts";
import { attachmentPath, projectReference } from "./files";
import { discoverExistingCodex, type DiscoveredCodexEndpoint } from "./discovery";
import { normalizeRateLimits, type CodexRateLimits } from "./limits";

import { readCatalog, publicCatalog, resolveExtensions, accessPolicy, readMcp, type Catalog } from "./extensions";

interface Session {
  root?:string;
  tokenUsage?: TokenUsage|null;
  contextReadAt?: number;
  historyWarning?: {code:string;message:string};
  id: string;
  projectId: string;
  title: string;
  status: string;
  turnId?: string;
  lastCompletedTurnId?: string;
  items: Map<string, TimelineItem>;
  turns: Map<string, TurnTiming>;
  truncated: boolean;
  touched: number;
}
interface Pending {
  id: string;
  rawId: string | number;
  method: string;
  params: any;
  kind: "command" | "file" | "question" | "unsupported";
  threadId: string;
  turnId?: string;
  description: string;
  questions?: any[];
}
export class CodexConsoleService {
  readonly hub = new ReplayHub();
  protected turnGate = new MainTurnGate(() => this.readMainTurnStates());
  useTurnGate(gate: MainTurnGate) { this.turnGate = gate; }
  protected readMainTurnStates(): Promise<any[]> { return readMainThreads(params => this.rpc().request('thread/list', params)); }
  protected async mainAction(id: string, dispatch: () => Promise<any>, markSubmitted: () => void) {
    const slot = await this.turnGate.acquire(id); let outcome: 'running' | 'unknown' = 'unknown';
    try { slot.submit(); markSubmitted(); const result = await dispatch(); outcome = 'running'; slot.finish(outcome); return result; }
    finally { slot.finish(outcome); }
  }
  usage?: UsageLedger;
  attachUsage(usage:UsageLedger){this.usage=usage;}
  usageSnapshot(id:string){const owner=this.usage?.owner(id);return owner?this.usage!.metrics({uuid:owner,elevated:false},id):undefined;}
  private projectQueue:Promise<unknown>=Promise.resolve();
  private catalogs = new Map<string, { at: number; value: Promise<Catalog> }>();
  private peer?: CodexRpcClient;
  private connecting?: Promise<void>;
  private sessions = new Map<string, Session>();
  private pending = new Map<string, Pending>();
  private opening = new Map<string, Promise<Session>>();
  private reservations = new Set<string>();
  private modelsCache?: { at: number; data: any[] };
  private limitsCache?: CodexRateLimits;
  protected invalidateSubscription(){this.subscriptionCache=undefined;}
  private subscriptionCache?:{at:number;value:Promise<AccountSubscription>};
  protected readAccountMetadata():Promise<any>{return this.rpc().request("account/read",{refreshToken:false});}
  async subscription(identity:Identity):Promise<AccountSubscription>{
    if(!identity.uuid)throw new ConsoleError(401,"LOGIN_REQUIRED","请登录。");
    const now=Date.now();if(this.subscriptionCache&&now-this.subscriptionCache.at<1800000)return this.subscriptionCache.value;
    const value=(async()=>{try{return normalizeSubscription(await this.readAccountMetadata());}catch{return unavailableSubscription();}})();
    this.subscriptionCache={at:now,value};return value;
  }
  private reason = "Codex is not configured or connected.";
  private deltas = new Map<
    string,
    { threadId: string; itemId: string; offset: number; text: string }
  >();
  private deltaTimer?: ReturnType<typeof setTimeout>;
  constructor(
    readonly config: ConfigStore,
    readonly receipts: CommandReceipts,
    private factory = (options: any) => new CodexRpcClient(options),
    private historyReader = new IsolatedHistoryReader()
  ) {}
  status(identity: Identity) {
    return {
      configured: this.config.value.enabled,
      connected: this.peer?.connected || false,
      transport: this.config.value.transport.type,
      serverVersion: (this.peer?.serverInfo as any)?.userAgent,
      desktopSync: "unverified",
      processPolicy: "attach-only",
      userId: identity.uuid,
      admin: identity.elevated,
      reason: this.peer?.connected ? undefined : this.reason,
      capabilities:{accountIsolation:this.config.value.accountIsolation===true,projects:!!identity.uuid,projectless:!!identity.uuid,taskActions:true,quota:true,resetQuota:!!identity.uuid&&identity.elevated},
      maxConcurrentTurns: MAIN_TURN_LIMIT
    };
  }
  async discover(identity: Identity): Promise<DiscoveredCodexEndpoint[]> {
    if (!identity.elevated)
      throw new ConsoleError(
        403,
        "ADMIN_REQUIRED",
        "A administrator is required to discover the existing Codex endpoint."
      );
    return discoverExistingCodex();
  }
  async activeWork(): Promise<boolean> {
    if(this.status({uuid:'',elevated:false}).connected) await this.turnGate.synchronize();
    return this.hasActiveWork;
  }
  get hasActiveWork(): boolean {
    return (
      this.turnGate.count > 0 || this.reservations.size > 0 ||
      this.pending.size > 0 ||
      [...this.sessions.values()].some((s) => s.status === "running")
    );
  }
  async connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    this.connecting = this.connectOnce();
    try {
      await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }
  private async connectOnce(): Promise<void> {
    if (!this.config.value.enabled)
      throw new ConsoleError(409, "NOT_CONFIGURED", "Enable and configure Codex first.");
    if (this.peer?.connected) return;
    this.disconnect();
    if (!["unix", "websocket"].includes(this.config.value.transport.type))
      throw new ConsoleError(
        400,
        "ATTACH_ONLY",
        "Only connecting to the existing Codex backend is permitted."
      );
    const peer = this.factory(this.config.value.transport);
    this.peer = peer;
    peer.on("notification", (message: any) => {
      if (this.peer !== peer) return;
      try {
        this.notification(message);
      } catch {
        peer.close();
      }
    });
    peer.on("request", (message: any) => {
      if (this.peer !== peer) return;
      try {
        this.serverRequest(message);
      } catch {
        peer.close();
      }
    });
    peer.on("disconnect", () => {
      if (this.peer !== peer) return;
      this.flushDeltas();
      this.pending.clear();
      this.historyReader.cancelAll();
      this.sessions.clear();
      this.opening.clear();
      this.reservations.clear();
      this.reason =
        "Codex disconnected. Reconnect explicitly; pending commands will not be resent.";
      this.hub.publish({ type: "connection", payload: { connected: false } });
      this.hub.reset("backend-disconnected");
    });
    try {
      await peer.connect();
      if (this.peer !== peer)
        throw new ConsoleError(
          409,
          "CONNECTION_CHANGED",
          "Connection changed during initialization."
        );
      this.reason = "";
      this.hub.publish({ type: "connection", payload: { connected: true } });
    } catch (error) {
      this.reason = "Could not connect to Codex. Check the server-side configuration and logs.";
      peer.close();
      throw error;
    }
  }
  disconnect(): void {
    this.historyReader.cancelAll();
    this.flushDeltas();
    const old = this.peer;
    this.peer = undefined;
    old?.close();
    this.pending.clear();
    this.sessions.clear();
    this.opening.clear();
    this.modelsCache = undefined;
    this.limitsCache=undefined;
    this.subscriptionCache=undefined;
    this.catalogs.clear();
    this.reason = "Codex is disconnected.";
    this.hub.publish({ type: "connection", payload: { connected: false } });
    this.hub.reset("connection-changed");
  }
  private rpc(): CodexRpcClient {
    if (!this.peer?.connected) throw new ConsoleError(503, "CODEX_OFFLINE", this.reason);
    return this.peer;
  }
  project(
    identity: Identity,
    id: string,
    capability: "view" | "send" | "approve" | "files" = "view"
  ): Project {
    if (!this.config.value.enabled)
      throw new ConsoleError(409, "DISABLED", "Codex console is disabled.");
    if(id===STORAGE_ID){if(!['view','files'].includes(capability))throw new ConsoleError(403,'STORAGE_FILES_ONLY','文件库仅保存文件，请在对话中引用。');return {id,name:'我的文件库',root:storagePath(this.config.file,identity),ownerId:identity.uuid,grants:[]};}
    if(id==='projectless'){if(!identity.uuid)throw new ConsoleError(401,'LOGIN_REQUIRED','请登录。');if(capability==='files')throw new ConsoleError(403,'PROJECTLESS_FILES','无项目对话不开放项目文件浏览。');return {id,name:'无项目对话',root:path.dirname(this.config.file)+'-chats'+(identity.uuid===this.config.value.defaultOwnerId?'':'-'+accountDirectoryName(identity.uuid)),ownerId:identity.uuid,grants:[]};}
    return requireProject(this.config.value, identity, id, capability);
  }
  async refreshProjects(identity: Identity) { return this.projects(identity); }
  async projectDirectory(identity: Identity) { if(!identity.uuid)throw new ConsoleError(401,"LOGIN_REQUIRED","请登录。"); return defaultProjectDirectory(identity.uuid); }
  async createProject(identity:Identity,input:any):Promise<any>{
    if(!identity.uuid)throw new ConsoleError(401,"LOGIN_REQUIRED","请登录。");if(input?.folderName===undefined)requireAdmin(identity);input=await normalizeProjectCreation(input,identity.uuid);const prepared=await prepareProjectDirectory(this.config,input),canonical=prepared.root;
    const existing=this.config.value.projects.find(p=>p.root===canonical);if(existing){this.project(identity,existing.id,"send");return this.projects(identity).find(p=>p.id===existing.id);}
    const p={id:'p-'+createHash('sha256').update(canonical).digest('hex').slice(0,20),name:input.name.trim(),root:canonical,ownerId:identity.uuid,grants:[]};
    return this.receipts.run(identity.uuid+':project:'+input.requestId,async markSubmitted=>{await materializeProjectDirectory(this.config,prepared,p.name);const work=this.projectQueue.catch(()=>{}).then(async()=>{const prior=this.config.value.projects.find(v=>v.root===p.root);if(prior){this.project(identity,prior.id,"send");return this.projects(identity).find(v=>v.id===prior.id);}markSubmitted();await this.config.save({...this.config.value,projects:[...this.config.value.projects,p]});return this.projects(identity).find(v=>v.id===p.id);});this.projectQueue=work;return work;},{trackSubmission:true});
  }
  async taskAction(identity:Identity,projectId:string,id:string,action:string,input:any):Promise<any>{
    const project=this.project(identity,projectId,'send');const thread=await this.verifyThread(project,id);
    if(!['rename','pin','archive','fork','side','compact','review','feedback'].includes(action)||!/^[-a-zA-Z0-9_]{8,100}$/.test(input.requestId||''))throw new ConsoleError(400,'INVALID_ACTION','无效的操作或请求 ID。');

    if(this.config.value.accountIsolation&&['compact','review'].includes(action))throw new ConsoleError(409,'ISOLATED_ACTION_UNAVAILABLE','账号隔离模式下，请通过普通对话提交请求。');
    if(!['rename','pin'].includes(action)&&input.confirmed!==true)throw new ConsoleError(400,'CONFIRMATION_REQUIRED','请确认操作。');
    if(['archive','fork','side','compact','review'].includes(action)&&runtimeStatus(thread)==='running')throw new ConsoleError(409,'THREAD_BUSY','请等待当前消息结束。');
    if(action==='rename'&&(typeof input.name!=='string'||!input.name.trim()||input.name.length>120))throw new ConsoleError(400,'INVALID_TITLE','标题为 1–120 字。');
    if(action==='pin'&&typeof input.pinned!=='boolean')throw new ConsoleError(400,'INVALID_PIN','无效的置顶状态。');
    if(action==='review'&&input.target!=='uncommittedChanges'&&!(input.target==='baseBranch'&&typeof input.branch==='string'&&input.branch.trim()&&input.branch.length<=200))throw new ConsoleError(400,'INVALID_REVIEW','请选择审查范围。');
    if(action==='feedback'&&(typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>4000))throw new ConsoleError(400,'INVALID_FEEDBACK','请填写反馈内容。');
    return this.receipts.run(identity.uuid+':action:'+id+':'+action+':'+input.requestId,async markSubmitted=>{
      const rpc=(m:string,p:any)=>this.rpc().request<any>(m,p);
      if(action==='rename'){await rpc('thread/name/set',{threadId:id,name:input.name.trim()});const session=this.sessions.get(id);if(session)session.title=input.name.trim();}
      if(action==='pin'){await rpc('thread/section/move',{threadId:id,sectionId:input.pinned?'01984de2-8f74-7c91-a3b2-5c5e937cf318':null});return {ok:true,pinned:input.pinned};}
      if(action==='archive')await rpc('thread/archive',{threadId:id});
      if(action==='compact')await this.mainAction(id,()=>rpc('thread/compact/start',{threadId:id}),markSubmitted);
      if(action==='review'){await this.open(project,id);await this.mainAction(id,()=>rpc('review/start',{threadId:id,target:input.target==='baseBranch'?{type:'baseBranch',branch:input.branch.trim()}:{type:'uncommittedChanges'},delivery:'inline'}),markSubmitted);}
      if(action==='feedback')await rpc('feedback/upload',{threadId:id,classification:'bug',reason:input.reason.trim(),includeLogs:false,extraLogFiles:[]});
      if(action==='fork'||action==='side'){if(input.environment&&input.environment!=='same-directory')throw new ConsoleError(400,'INVALID_ENVIRONMENT','此连接仅支持当前目录分支。');const r=await rpc('thread/fork',{threadId:id,ephemeral:action==='side',threadSource:'user',excludeTurns:true,deferGoalContinuation:true});if(!await this.sameRoot(project,r.thread?.cwd))throw new ConsoleError(502,'FORK_OUTCOME_UNKNOWN','分支结果未知，请检查 Codex。');this.usage?.bind(r.thread.id,identity,projectId,r.thread.model,r.thread.modelProvider);return {ok:true,thread:{id:r.thread.id,title:threadTitle(r.thread),status:runtimeStatus(r.thread)},temporary:action==='side'};}
      return {ok:true};
    }, {trackSubmission:['compact','review'].includes(action)});
  }
  projects(identity: Identity):any[] {
    const projects=this.config.value.projects
      .filter((p) => permissions(p, identity).view)
      .map((p) => ({
        id: p.id,
        name: p.name,
        root: p.root,
        permissions: permissions(p, identity),kind:"project",
        activeCount: [...this.sessions.values()].filter(
          (s) => s.projectId === p.id && s.status === "running"
        ).length
      }));
    if(identity.uuid)projects.push({id:"projectless",name:"无项目对话",root:"",permissions:{view:true,send:true,approve:true,files:false},kind:"projectless",activeCount:0});
    return projects;
  }
  async rateLimits(identity: Identity): Promise<CodexRateLimits> {
    if(!identity.uuid)throw new ConsoleError(401,"LOGIN_REQUIRED","请登录。");
    if (this.limitsCache && Date.now() - this.limitsCache.fetchedAt < 300_000)
      return this.limitsCache;
    const raw = await this.rpc().request<any>("account/rateLimits/read", {});
    this.limitsCache = normalizeRateLimits(raw);
    return this.limitsCache;
  }
  async consumeRateLimitReset(identity: Identity, requestId: string, creditId?: string) {
    if (!identity.uuid || !identity.elevated)
      throw new ConsoleError(
        403,
        "ADMIN_REQUIRED",
        "Only a administrator may consume a shared reset credit."
      );
    if (typeof requestId !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(requestId))
      throw new ConsoleError(400, "INVALID_REQUEST_ID", "A valid idempotency key is required.");
    if (
      creditId !== undefined &&
      (typeof creditId !== "string" || !creditId || creditId.length > 256)
    )
      throw new ConsoleError(400, "INVALID_CREDIT_ID", "Invalid reset credit id.");
    return this.receipts.run(`${identity.uuid}:rate-limit-reset:${requestId}`, async () => {
      const result = await this.rpc().request<any>("account/rateLimitResetCredit/consume", {
        idempotencyKey: requestId,
        ...(creditId ? { creditId } : {})
      });
      this.limitsCache = undefined;
      const rateLimits = await this.rateLimits(identity);
      return {
        outcome: typeof result?.outcome === "string" ? result.outcome : "unknown",
        rateLimits
      };
    });
  }

  private async catalogFor(root: string, refresh = false): Promise<Catalog> {
    const cached=this.catalogs.get(root);
    if (!refresh && cached && Date.now()-cached.at<60_000) return cached.value;
    const value=readCatalog((method,params)=>this.rpc().request(method,params),root,refresh);
    this.catalogs.set(root,{at:Date.now(),value});
    return value;
  }
  async extensions(identity: Identity, projectId: string, refresh = false) {
    const project=this.project(identity,projectId);
    return publicCatalog(await this.catalogFor(project.root,refresh));
  }
  async mcp(identity: Identity, projectId: string, threadId?: string) {
    const project=this.project(identity,projectId);
    if(threadId) await this.verifyThread(project,threadId);
    try { return await readMcp((method,params)=>this.rpc().request(method,params),threadId); }
    catch { throw new ConsoleError(502,"MCP_UNAVAILABLE","此 Codex 未提供 MCP 状态。"); }
  }
  async goal(identity: Identity, projectId: string, id: string, objective?: string) {
    const project=this.project(identity,projectId,objective===undefined?"view":"send");
    await this.verifyThread(project,id);
    if(objective!==undefined && (typeof objective!=="string" || !objective.trim() || objective.length>4000))
      throw new ConsoleError(400,"INVALID_GOAL","目标不能为空，最多 4000 字符。");
    try {
      const result=await this.rpc().request<any>(objective===undefined?"thread/goal/get":"thread/goal/set",{threadId:id,...(objective===undefined?{}:{objective:objective.trim()})});
      const g=result.goal;
      return {goal:g?{objective:String(g.objective||"").slice(0,4000),status:String(g.status||""),tokensUsed:g.tokensUsed,timeUsedSeconds:g.timeUsedSeconds}:null};
    } catch { throw new ConsoleError(502,"GOAL_UNAVAILABLE","此 Codex 未能读取或保存目标。"); }
  }
  async models(identity: Identity, _projectId?: string, _threadId?: string) {
    if (
      !this.config.value.projects.some((p) => permissions(p, identity).view) &&
      !identity.uuid
    )
      throw new ConsoleError(403, "PROJECT_FORBIDDEN", "No authorized projects.");
    if (!this.modelsCache || Date.now() - this.modelsCache.at > 60000) {
      const result = await this.rpc().request<any>("model/list", {
        limit: 100,
        includeHidden: false
      });
      this.modelsCache = { at: Date.now(), data: result.data || [] };
    }
    return { data: this.modelsCache.data };
  }
  async listThreads(identity: Identity, projectId: string, cursor?: string) {
    const project = this.project(identity, projectId);
    const result = await this.rpc().request<any>("thread/list", {
      cwd: project.root,
      limit: 40,
      cursor: cursor || null,
      archived: false,
      sortKey: "updated_at"
    });
    const list = [];
    for (const thread of result.data || []) {
      if (await this.sameRoot(project, thread.cwd))
        list.push({
          id: thread.id,
          title: threadTitle(thread),
          status: runtimeStatus(thread),
          pinned:thread.section?.id==="01984de2-8f74-7c91-a3b2-5c5e937cf318",updatedAt: thread.updatedAt
        });
    }
    return { data: list, nextCursor: result.nextCursor || null };
  }
  private async sameRoot(project: Project, cwd: unknown): Promise<boolean> {
    if (typeof cwd !== "string") return false;
    return (await fs.realpath(cwd).catch(() => "")) === project.root;
  }
  private async verifyThread(project: Project, id: string): Promise<any> {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id))
      throw new ConsoleError(400, "INVALID_THREAD", "Invalid thread id.");
    if ((await fs.realpath(project.root).catch(() => "")) !== project.root)
      throw new ConsoleError(
        409,
        "ROOT_CHANGED",
        "Project root changed; reconfigure before continuing."
      );
    const { thread } = await this.rpc().request<any>("thread/read", {
      threadId: id,
      includeTurns: false
    });
    if (!thread || !(await this.sameRoot(project, thread.cwd)))
      throw new ConsoleError(
        403,
        "THREAD_FORBIDDEN",
        "Conversation does not belong to this project."
      );
    return thread;
  }
  private recordTurn(session:Session,turn:any,now?:number){
    if(!turn?.id)return;const previous=session.turns.get(turn.id);
    if(previous?.finishedAt!==undefined&&turn.status==='inProgress')return;
    session.turns.set(turn.id,turnTiming(turn,previous,now));
    while(session.turns.size>40)session.turns.delete(session.turns.keys().next().value!);
  }
  private trim(session: Session): void {
    let size = [...session.items.values()].reduce((n, i) => n + i.text.length, 0);
    while (session.items.size > 200 || size > 512 * 1024) {
      const id = session.items.keys().next().value as string;
      size -= session.items.get(id)!.text.length;
      session.items.delete(id);
      session.truncated = true;
    }
  }
  private evict(): void {
    if (this.sessions.size < 60) return;
    const oldest = [...this.sessions.values()]
      .filter(
        (s) =>
          s.status !== "running" && ![...this.pending.values()].some((p) => p.threadId === s.id)
      )
      .sort((a, b) => a.touched - b.touched)[0];
    if (!oldest) throw new ConsoleError(503, "SESSION_LIMIT", "Too many active conversations.");
    this.sessions.delete(oldest.id);
    // Do not unsubscribe/unload desktop-owned work just because a browser changes projects.
  }
  private async open(project: Project, id: string): Promise<Session> {
    // A loading session already exists for live events, but is not a usable snapshot yet.
    const inFlight = this.opening.get(id);
    if (inFlight) return inFlight;
    const current = this.sessions.get(id);
    if (current && current.projectId === project.id) {
      current.touched = Date.now();
      return current;
    }
    const promise = (async () => {
      const thread = await this.verifyThread(project, id);
      this.evict();
      const session: Session = {
        id,
        projectId: project.id,
        root:project.root,
        title: threadTitle(thread),
        status: runtimeStatus(thread),
        items: new Map(),
        turns: new Map(),
        truncated: false,
        touched: Date.now()
      };
      this.sessions.set(id, session);
      try {
        const resumed = await this.rpc().request<any>("thread/resume", {
          threadId: id,
          excludeTurns: true
        });
        session.status = runtimeStatus(resumed.thread || thread);
        const restored=await restoredTokenUsage({...thread,...resumed.thread});
        if(!session.tokenUsage)session.tokenUsage=restored;
        const owner=this.peer;
        const history = await this.historyReader.read(this.config.value.transport,id,()=>this.peer===owner&&!!owner?.connected);
        session.historyWarning=history.warning;
        const live = new Map(session.items);
        session.items.clear();
        for (const turn of [...(history.data || [])].reverse()) {
          if (turn.status === "inProgress") session.turnId = turn.id;
          if(!session.turns.has(turn.id))session.turns.set(turn.id,turnTiming(turn));
          for (const raw of turn.items || []) {
            const item = normalizeItem(raw, this.config.value.projects.find(project=>project.id===session.projectId)?.root, turn.id);
            session.items.set(item.id, item);
          }
        }
        for (const [key, item] of live) session.items.set(key, item);
        session.truncated = Boolean(history.nextCursor);
        this.trim(session);
        return session;
      } catch (error) {
        if(this.sessions.get(id)===session)this.sessions.delete(id);
        throw error;
      }
    })();
    this.opening.set(id, promise);
    try {
      return await promise;
    } finally {
      if(this.opening.get(id)===promise)this.opening.delete(id);
    }
  }
  async snapshot(identity: Identity, projectId: string, id: string) {
    const project = this.project(identity, projectId);
    const thread=await this.verifyThread(project, id);
    this.usage?.bind(id,identity,projectId,thread.model,thread.modelProvider,false,thread.serviceTier);
    const session = await this.open(project, id);
    if(session.tokenUsage?.last==null||session.tokenUsage.contextWindow==null){
      const supplied=normalizeTokenUsage(thread.tokenUsage??thread.latestTokenUsageInfo);
      if(supplied||!session.contextReadAt||Date.now()-session.contextReadAt>15000){
        session.contextReadAt=Date.now();const before=session.tokenUsage;
        const restored=supplied||await restoredTokenUsage(thread);
        // A live event arriving during the read always wins over disk/history.
        if(restored&&session.tokenUsage===before)session.tokenUsage={total:before?.total??restored.total,last:before?.last??restored.last,contextWindow:before?.contextWindow??restored.contextWindow};
      }
    }
    this.flushDeltas();
    return {
      id,
      title: session.title,
      status: session.status,
      turnId: session.turnId,
      items: [...session.items.values()],
      ...(session.historyWarning?{historyWarning:session.historyWarning}:{}),
      turns: [...session.turns.values()],
      tokenUsage: session.tokenUsage,
      metrics: this.usageSnapshot(id),
      pending: [...this.pending.values()]
        .filter((p) => p.threadId === id)
        .map((p) => this.publicPending(p)),
      truncated: session.truncated,
      cursor: this.hub.cursor
    };
  }
  async createTask(_identity: Identity, _projectId: string, _input: any): Promise<any> { throw new ConsoleError(501, 'CREATION_UNAVAILABLE', 'This connection does not support combined task creation.'); }
  async taskCreation(_identity: Identity, _requestId: string): Promise<any> { throw new ConsoleError(404, 'CREATION_NOT_FOUND', 'Task creation is not available on this connection.'); }
  async createThread(identity: Identity, projectId: string, title?: string, requestId?: string) {
    const project = this.project(identity, projectId, "send");
    if(projectId==="projectless")await fs.mkdir(project.root,{mode:0o700,recursive:false}).catch(e=>{if(e.code!=="EEXIST")throw e;});
    if (title !== undefined && (typeof title !== "string" || title.length > 120))
      throw new ConsoleError(400, "INVALID_TITLE", "Title is too long.");
    if ((await fs.realpath(project.root).catch(() => "")) !== project.root)
      throw new ConsoleError(
        409,
        "ROOT_CHANGED",
        "Project root changed; reconfigure before continuing."
      );
    if (requestId !== undefined && (typeof requestId !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(requestId)))
      throw new ConsoleError(400, "INVALID_REQUEST_ID", "Invalid request ID.");
    const create = async () => {
    const isolated=this.config.value.accountIsolation?await accountProfile(this.config,identity,project.root,undefined,(m,p)=>this.rpc().request(m,p)):null;
    const result = await this.rpc().request<any>("thread/start", {
      cwd: project.root,
      runtimeWorkspaceRoots: [project.root],
      ...(projectId==="projectless"?{projectId:null,threadSource:"user"}:{}),
      approvalPolicy: isolated?"never":"on-request",
      approvalsReviewer: "user",
      ...(isolated?{config:isolated.config}:{sandbox:"workspace-write"})
    });
    if(isolated){verifyAccountProfile(result,isolated);}
    const thread = result.thread;
    if (!(await this.sameRoot(project, thread.cwd)))
      throw new ConsoleError(502, "ROOT_MISMATCH", "Codex returned a different working directory.");
    this.usage?.bind(thread.id,identity,projectId,thread.model,thread.modelProvider,true,thread.serviceTier);
    if (title?.trim())
      await this.rpc().request("thread/name/set", { threadId: thread.id, name: title.trim() });
    this.evict();
    this.sessions.set(thread.id, {
      id: thread.id,
      projectId,
      root:project.root,
      title: title?.trim() || threadTitle(thread),
      status: runtimeStatus(thread),
      items: new Map(),
        turns: new Map(),
      touched: Date.now(),
      truncated: false
    });
    return {
      id: thread.id,
      title: title?.trim() || threadTitle(thread),
      status: runtimeStatus(thread)
    };
    };
    return requestId ? this.receipts.run(`${identity.uuid}:create:${projectId}:${requestId}`, create) : create();
  }
  async send(identity: Identity, projectId: string, id: string, input: any) {
    const project = this.project(identity, projectId, "send");
    if(this.config.value.accountIsolation&&input?.delivery==="steer")throw new ConsoleError(409,"ISOLATED_TURN_REQUIRED","请等待当前轮结束后发送，账号隔离不允许中途切换权限。");
    if(input?.delivery!==undefined && input.delivery!=="steer")throw new ConsoleError(400,"INVALID_DELIVERY","不支持的发送方式。");
    if (
      !input ||
      typeof input.text !== "string" ||
      !input.text.trim() ||
      input.text.length > 64000 ||
      typeof input.requestId !== "string" ||
      !/^[a-zA-Z0-9_-]{8,100}$/.test(input.requestId)
    )
      throw new ConsoleError(
        400,
        "INVALID_MESSAGE",
        "A non-empty message and unique request id are required (max 64000 characters)."
      );
    if (input.mode !== undefined && !["code", "plan"].includes(input.mode))
      throw new ConsoleError(400, "INVALID_MODE", "Unknown collaboration mode.");
    const thread = await this.verifyThread(project, id);
    const session = await this.open(project, id);
    const { data: models } = await this.models(identity);
    const model = input.model
      ? models.find((m: any) => m.model === input.model || m.id === input.model)
      : models.find((m: any) => m.isDefault) || models[0];
    if (!model)
      throw new ConsoleError(400, "MODEL_UNAVAILABLE", "Select an available Codex model.");
    if (
      input.effort &&
      !(model.supportedReasoningEfforts || []).some((e: any) => e.reasoningEffort === input.effort)
    )
      throw new ConsoleError(
        400,
        "EFFORT_UNAVAILABLE",
        "This reasoning level is not supported by the selected model."
      );
    const policy=this.config.value.accountIsolation?{approvalPolicy:"never"}:accessPolicy(identity,project.root,input.access,input.confirmFullAccess);
    const content: any[] = [{ type: "text", text: input.text }];
    if (input.extensions !== undefined) {
      // Refresh before a send so revoked or disabled skills cannot be selected from a stale browser cache.
      if (!Array.isArray(input.extensions) || input.extensions.length > 12)
        throw new ConsoleError(400,"INVALID_EXTENSIONS","最多选择 12 个技能或插件。");
      if (input.extensions.length) content.push(...resolveExtensions(await this.catalogFor(project.root,true),input.extensions));
    }
    if (input.references !== undefined) {
      if (!Array.isArray(input.references) || input.references.length > 12 || input.references.some((v: unknown)=>typeof v!=="string"))
        throw new ConsoleError(400,"INVALID_REFERENCES","最多引用 12 个文件或文件夹。");
      for(const rel of [...new Set<string>(input.references)]) {
        if(rel.startsWith('@account/')){if(!this.config.value.accountIsolation)throw new ConsoleError(503,'STORAGE_ISOLATION_REQUIRED','服务器尚未启用账号隔离文件库。');const root=await ensureStorage(this.config.file,identity),name=await projectReference(root,rel.slice(9));content[0].text += `\n\nAccount file reference (server original): ${path.join(root,name)}`;}
        else{this.project(identity,projectId,"files");content[0].text += `\n\nProject reference: ${await projectReference(project.root,rel)}`;}
      }
    }
    if (
      input.attachments !== undefined &&
      (!Array.isArray(input.attachments) || input.attachments.length > 5)
    )
      throw new ConsoleError(
        400,
        "INVALID_ATTACHMENTS",
        "At most five uploaded attachments are allowed."
      );
    for (const rel of input.attachments || []) {
      this.project(identity, projectId, "files");
      if (typeof rel !== "string")
        throw new ConsoleError(400, "INVALID_ATTACHMENTS", "Invalid attachment.");
      const absolute = await attachmentPath(project.root, rel);
      if (/\.(png|jpe?g|webp)$/i.test(absolute))
        content.push({ type: "localImage", path: absolute });
      else content[0].text += `\n\nAttached project file: ${rel}`;
    }
    if(input.delivery==='steer')return this.receipts.run(`${identity.uuid}:${id}:${input.requestId}`,async markSubmitted=>{
      if(session.status!=='running'||runtimeStatus(thread)!=='running'||!session.turnId)throw new ConsoleError(409,'NO_ACTIVE_TURN','当前轮已结束，消息未发送；可加入队列。');
      if(typeof input.expectedTurnId!=='string'||input.expectedTurnId!==session.turnId)throw new ConsoleError(409,'TURN_CHANGED','运行中的轮次已改变，请刷新后确认再发送。');
      markSubmitted();
      const result=await this.rpc().request<any>('turn/steer',{threadId:id,expectedTurnId:input.expectedTurnId,input:content});
      return {turnId:result.turnId||session.turnId,status:'running',steered:true};
    },{trackSubmission:true});
    return this.receipts.run(`${identity.uuid}:${id}:${input.requestId}`, async markSubmitted => {
      const slot = await this.turnGate.acquire(id);
      let held = false, outcome: 'running' | 'complete' | 'rejected' | 'unknown' = 'rejected';
      try {
      if (
        runtimeStatus(thread) === "running" ||
        session.status === "running" ||
        this.reservations.has(project.root)
      )
        throw new ConsoleError(
          409,
          "THREAD_BUSY",
          "This conversation or project is busy. Refresh before sending again."
        );
      if (
        [...this.sessions.values()].some((s) => s.root === project.root && s.status === "running")
      )
        throw new ConsoleError(
          409,
          "PROJECT_BUSY",
          "Only one task may modify this project at a time. Use a separate worktree project for parallel edits."
        );
      this.reservations.add(project.root); held = true;
        const running = await this.rpc().request<any>("thread/list", {
          cwd: project.root,
          limit: 100,
          archived: false
        });
        if ((running.data || []).some((t: any) => runtimeStatus(t) === "running"))
          throw new ConsoleError(
            409,
            "PROJECT_BUSY",
            "A task is already running in this project, possibly in another Codex client."
          );
        const peer = this.rpc();
        if(this.config.value.accountIsolation)await isolateAccountThread(this.config,identity,project.root,id,input.access,(m,p)=>peer.request(m,p));
        this.usage?.bind(id,identity,projectId,model.model,thread.modelProvider,false,thread.serviceTier);
        markSubmitted(); slot.submit(); outcome = 'unknown';
        const result = await peer.request<any>("turn/start", {
          threadId: id,
          input: content,
          cwd: project.root,
          runtimeWorkspaceRoots: [project.root],
          ...policy,
          approvalsReviewer: "user",
          model: model.model,
          collaborationMode: {
            mode: input.mode === "plan" ? "plan" : "default",
            settings: {
              model: model.model,
              reasoning_effort: input.effort || model.defaultReasoningEffort || null,
              developer_instructions: null
            }
          }
        });
        session.turnId = result.turn.id;
        if(session.lastCompletedTurnId!==result.turn.id)this.recordTurn(session,result.turn,Date.now());
        if (session.lastCompletedTurnId !== result.turn.id)
          session.status = result.turn.status === "inProgress" ? "running" : result.turn.status;
        this.hub.publish({
          type: "status",
          projectId,
          threadId: id,
          payload: { status: session.status, turnId: session.turnId,turns:[...session.turns.values()],metrics:this.usageSnapshot(id) }
        });
        outcome = session.status === "running" ? "running" : "complete"; slot.finish(outcome, result.turn.id);
        return { turnId: result.turn.id, status: session.status };
      } finally {
        slot.finish(outcome); if (held) this.reservations.delete(project.root);
      }
    }, { trackSubmission: true });
  }
  async interrupt(identity: Identity, projectId: string, id: string) {
    const project = this.project(identity, projectId, "send");
    await this.verifyThread(project, id);
    const session = await this.open(project, id);
    if (!session.turnId || session.status !== "running")
      throw new ConsoleError(
        409,
        "NOT_RUNNING",
        "There is no known active turn to interrupt. Refresh first."
      );
    await this.rpc().request("turn/interrupt", { threadId: id, turnId: session.turnId });
    return { ok: true };
  }
  private publicPending(p: Pending) {
    return {
      id: p.id,
      kind: p.kind,
      threadId: p.threadId,
      turnId: p.turnId,
      description: p.description,
      questions: p.questions,
      decisions:
        p.kind === "command" || p.kind === "file"
          ? (p.params.availableDecisions || ["accept", "decline", "cancel"]).filter(
              (d: unknown) => typeof d === "string" && ["accept", "decline", "cancel"].includes(d)
            )
          : []
    };
  }
  async answer(identity: Identity, projectId: string, id: string, pendingId: string, answer: any) {
    const p = this.pending.get(pendingId);
    const project = this.project(identity, projectId, p?.kind === "question" ? "send" : "approve");
    await this.verifyThread(project, id);
    if (!p || this.pending.get(pendingId) !== p || p.threadId !== id)
      throw new ConsoleError(
        409,
        "APPROVAL_EXPIRED",
        "This request has already been resolved or expired."
      );
    if (p.kind === "unsupported")
      throw new ConsoleError(
        409,
        "DESKTOP_REQUIRED",
        "This request type must be handled in a compatible Codex client."
      );
    let result: any;
    if (p.kind === "question") {
      if (!answer?.answers || typeof answer.answers !== "object")
        throw new ConsoleError(400, "INVALID_ANSWER", "Answers are required.");
      const valid: Record<string, { answers: string[] }> = {};
      for (const q of p.questions || []) {
        const a = answer.answers[q.id]?.answers;
        if (
          !Array.isArray(a) ||
          a.length === 0 ||
          a.length > 20 ||
          a.some((v) => typeof v !== "string" || v.length > 8192)
        )
          throw new ConsoleError(
            400,
            "INVALID_ANSWER",
            "Each question needs a bounded text answer."
          );
        valid[q.id] = { answers: a };
      }
      result = { answers: valid };
    } else {
      const decisions = this.publicPending(p).decisions;
      if (!decisions.includes(answer?.decision))
        throw new ConsoleError(400, "INVALID_DECISION", "Select one of the available decisions.");
      result = { decision: answer.decision };
    }
    this.rpc().respond(p.rawId, result);
    this.pending.delete(pendingId);
    this.hub.publish({
      type: "approvalResolved",
      projectId,
      threadId: id,
      payload: { id: pendingId }
    });
    return { ok: true };
  }
  private serverRequest(message: any): void {
    const { method, params = {}, id: rawId } = message;
    const session = this.sessions.get(params.threadId);
    if (!session) {
      this.peer?.reject(rawId, {
        code: -32602,
        message: "Thread is not attached to an authorized project console."
      });
      return;
    }
    const kind =
      method === "item/commandExecution/requestApproval"
        ? "command"
        : method === "item/fileChange/requestApproval"
          ? "file"
          : method === "item/tool/requestUserInput"
            ? "question"
            : "unsupported";
    if (this.pending.size >= 200) {
      this.peer?.reject(rawId, { code: -32000, message: "Pending request limit reached." });
      return;
    }
    const p: Pending = {
      id: randomUUID(),
      rawId,
      method,
      params,
      kind,
      threadId: session.id,
      turnId: params.turnId,
      description: String(params.command || params.reason || method).slice(0, 16000),
      questions: kind === "question" ? params.questions : undefined
    };
    this.pending.set(p.id, p);
    this.hub.publish({
      type: "approval",
      projectId: session.projectId,
      threadId: session.id,
      payload: this.publicPending(p)
    });
  }
  private notification({ method, params: p = {} }: any): void {
    if (method === "serverRequest/resolved") {
      for (const [key, pending] of this.pending)
        if (pending.rawId === p.requestId) {
          this.pending.delete(key);
          const session = this.sessions.get(pending.threadId);
          if (session)
            this.hub.publish({
              type: "approvalResolved",
              projectId: session.projectId,
              threadId: session.id,
              payload: { id: key }
            });
        }
      return;
    }
    if (
      method === "account/rateLimits/updated" ||
      method === "account/rateLimitResetCredit/updated"
    ) {
      this.limitsCache = undefined;
      this.hub.publish({ type: "limits", payload: { stale: true } });
      return;
    }
    if(method==="account/updated"||method==="account/login/completed"){this.subscriptionCache=undefined;this.limitsCache=undefined;this.hub.publish({type:"limits",payload:{stale:true}});return;}
    if (method === "skills/changed") { this.catalogs.clear(); return; }
    const id = p.threadId || p.thread?.id;
    if(id)this.usage?.observe(id,method,p);
    if (id && ['turn/started','turn/completed','thread/status/changed'].includes(method)) {
      // Only user/main threads are admitted or discovered by the gate; subagent events never reserve a slot.
      if (method === 'turn/completed') this.turnGate.observe(id, 'idle', p.turn?.id);
      else if (this.sessions.has(id)) this.turnGate.observe(id, method === 'turn/started' ? 'running' : runtimeStatus({status:p.status}), p.turn?.id);
    }
    const session = this.sessions.get(id);
    if (!session) return;
    session.touched = Date.now();
    if (method === "thread/tokenUsage/updated") {
      session.tokenUsage=normalizeTokenUsage(p.tokenUsage);
      this.hub.publish({type:"status",projectId:session.projectId,threadId:id,payload:{status:session.status,tokenUsage:session.tokenUsage,metrics:this.usageSnapshot(id)}});
      return;
    }
    if (method === "error") {
      const item: TimelineItem = {
        id: `error-${randomUUID()}`,
        type: "other",
        text: String(p.error?.message || "Codex reported an error.").slice(0, MAX_ITEM_CHARS),
        status: "failed",turnId:session.turnId
      };
      session.items.set(item.id, item);
      this.trim(session);
      this.hub.publish({ type: "item", projectId: session.projectId, threadId: id, payload: item });
      return;
    }
    if (
      method === "thread/status/changed" ||
      method === "turn/started" ||
      method === "turn/completed"
    ) {
      this.flushDeltas();
      session.status =
        method === "turn/started"
          ? "running"
          : method === "turn/completed"
            ? p.turn?.status === "failed"
              ? "failed"
              : "idle"
            : runtimeStatus({ status: p.status });
      if (p.turn?.id) {session.turnId = p.turn.id;this.recordTurn(session,p.turn,Date.now());}
      if (method === "turn/completed") session.lastCompletedTurnId = p.turn?.id;
      if (method === "turn/completed") {
        for (const [key, pending] of this.pending)
          if (pending.threadId === id) {
            this.pending.delete(key);
            this.hub.publish({
              type: "approvalResolved",
              projectId: session.projectId,
              threadId: id,
              payload: { id: key }
            });
          }
      }
      this.hub.publish({
        type: "status",
        projectId: session.projectId,
        threadId: id,
        payload: { status: session.status, turnId: session.turnId,turns:[...session.turns.values()],metrics:this.usageSnapshot(id) }
      });
      return;
    }
    if (method === "item/started" || method === "item/completed") {
      this.flushDeltas();
      const prior=session.items.get(String(p.item?.id));
      const item = normalizeItem(p.item,this.config.value.projects.find(project=>project.id===session.projectId)?.root,p.turnId||session.turnId);
      item.startedAt ??= prior?.startedAt ?? (method==="item/started"?Date.now():undefined);
      if(method==="item/completed") {item.finishedAt ??= Date.now();if(item.durationMs===undefined&&item.startedAt!==undefined)item.durationMs=Math.max(0,item.finishedAt-item.startedAt);}
      session.items.set(item.id, item);
      this.trim(session);
      this.hub.publish({ type: "item", projectId: session.projectId, threadId: id, payload: item });
      return;
    }
    if (
      method === "item/agentMessage/delta" ||
      method === "item/commandExecution/outputDelta" ||
      method === "item/plan/delta"
    ) {
      let item = session.items.get(p.itemId);
      if (!item) {
        item = {
          id: p.itemId,
          turnId: p.turnId||session.turnId,
          type: method.includes("agentMessage")
            ? "agentMessage"
            : method.includes("plan")
              ? "plan"
              : "commandExecution",
          text: "",
          ...(method.includes("agentMessage") ? { role: "assistant" as const } : {})
        };
        session.items.set(item.id, item);
        this.hub.publish({
          type: "item",
          projectId: session.projectId,
          threadId: id,
          payload: { ...item }
        });
      }
      if(item.truncated)return;
      const incoming=String(p.delta || "");
      if(item.text.length+incoming.length>MAX_ITEM_CHARS){
        this.flushDeltas();item.text=textPrefix(item.text+incoming,MAX_ITEM_CHARS);item.truncated=true;
        this.hub.publish({type:"item",projectId:session.projectId,threadId:id,payload:{...item}});return;
      }
      const text = incoming;
      if (!text) {
        item.truncated = true;
        return;
      }
      const key = `${id}:${item.id}`;
      const batch = this.deltas.get(key) || {
        threadId: id,
        itemId: item.id,
        offset: item.text.length,
        text: ""
      };
      item.text += text;
      batch.text += text;
      this.deltas.set(key, batch);
      this.trim(session);
      if (!this.deltaTimer) this.deltaTimer = setTimeout(() => this.flushDeltas(), 100);
    }
  }
  private flushDeltas(): void {
    if (this.deltaTimer) clearTimeout(this.deltaTimer);
    this.deltaTimer = undefined;
    for (const batch of this.deltas.values()) {
      const session = this.sessions.get(batch.threadId);
      if (session)
        this.hub.publish({
          type: "delta",
          projectId: session.projectId,
          threadId: batch.threadId,
          payload: { itemId: batch.itemId, text: batch.text, offset: batch.offset }
        });
    }
    this.deltas.clear();
  }
}
