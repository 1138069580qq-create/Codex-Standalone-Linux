import {historySync} from './backend/history-sync';
import {STORAGE_ID,ensureStorage} from './backend/account-storage';
import {randomUUID} from 'node:crypto';
import {publicBackendError} from './backend/errors';
import path from "node:path";
import { installFileRoutes } from "./file-routes";
import { PassThrough } from "node:stream";
import { promises as fs } from "node:fs";
import type Koa from "koa";
import Router from "@koa/router";
import { ConfigStore, ConsoleError, type Identity, requireAdmin, permissions } from "./backend/config";
import { CommandReceipts } from "./backend/receipts";
import { MessageQueue } from "./backend/message-queue";
import { UsageLedger } from "./backend/usage";
import { CodexConsoleService } from "./backend/service";
import { listProjectFiles, openProjectDownload, uploadProjectFile, projectDiff } from "./backend/files";

export type ServiceFactory = (config: ConfigStore, receipts: CommandReceipts) => CodexConsoleService;

export async function createCodexRoutes(config: ConfigStore, publicOrigin: string,
  sessionIdentity: (ctx: Koa.Context) => Identity | null, factory?: ServiceFactory, listMembers: () => readonly {id:string;username:string}[] = () => [], resolveQueueUser?: (id:string)=>Identity|null) {
  const receipts = new CommandReceipts(path.join(path.dirname(config.file), "receipts.json"));
  await receipts.load();
  const service = factory ? factory(config, receipts) : new CodexConsoleService(config, receipts);
  const usage=new UsageLedger(path.join(path.dirname(config.file),"usage.sqlite"));service.attachUsage(usage);
  const queue=new MessageQueue(path.join(path.dirname(config.file),"message-queue.json"),service,resolveQueueUser);await queue.load();
  let sampledAt=0;let sampling:Promise<void>|undefined;
  async function sampleQuota(who:Identity){
    if(sampling)return sampling;if(Date.now()-sampledAt<300000)return;
    sampledAt=Date.now();sampling=(async()=>{await Promise.all([
      (async()=>{try{usage.sample(await service.rateLimits(who));}catch{/* Preserve the last valid quota sample. */}})(),
      (async()=>{usage.syncSubscription(await service.subscription(who));})()
    ]);})();
    try{await sampling;}finally{sampling=undefined;}
  }
  // Reattach only to the configured, existing endpoint. Never launch Codex or replay writes.
  let reconnectAllowed=true, reconnecting:Promise<void>|undefined, lastReconnectAt=0;
  async function recoverReadConnection(who:Identity,projectId:string){
    if(projectId!=='projectless')service.project(who,projectId);
    else if(!who.uuid||!config.value.enabled)throw new ConsoleError(403,'PROJECT_FORBIDDEN','Project access denied.');
    if(service.status(who).connected)return;
    if(!reconnectAllowed)throw new ConsoleError(503,'CODEX_DISCONNECTED','管理员已断开连接，请管理员重新连接。');
    if(reconnecting)return reconnecting;
    if(Date.now()-lastReconnectAt<5000)throw new ConsoleError(503,'CODEX_OFFLINE','Codex 暂未连接，正在等待恢复。');
    lastReconnectAt=Date.now();
    const work=service.connect();reconnecting=work;
    try{await work;}finally{if(reconnecting===work)reconnecting=undefined;}
  }
  const streams = new Set<PassThrough>();
  const router = new Router({ prefix: "/api/codex" });
  function identity(c: Koa.Context): Identity {
    const who = sessionIdentity(c);
    if (!who) throw new ConsoleError(401, "LOGIN_REQUIRED", "Sign in first.");
    return who;
  }
  const rateBuckets = new Map<string, number[]>();
  function rateLimit(who: Identity, key: string, limit: number, window = 60000): void {
    const now = Date.now();
    const id = who.uuid + ":" + key;
    const times = (rateBuckets.get(id) || []).filter((t) => now - t < window);
    if (times.length >= limit)
      throw new ConsoleError(429, "RATE_LIMIT", "Too many requests. Please wait before retrying.");
    times.push(now);
    rateBuckets.set(id, times);
    if (rateBuckets.size > 2000)
      for (const [k, v] of rateBuckets) if (now - v[v.length - 1] > window) rateBuckets.delete(k);
  }
  function wrap(
    handler: (c: Koa.ParameterizedContext, who: Identity) => Promise<unknown> | unknown
  ): Koa.Middleware {
    return async (c) => {
      try {
        const who = identity(c);
        c.set("Cache-Control", "no-store");
        c.set("X-Content-Type-Options", "nosniff");
        rateLimit(who, "requests", 240);
        if (!["GET","HEAD"].includes(c.method)) {
          if(!(c.method==='POST'&&/^\/api\/codex\/threads\/[^/]+\/sync$/.test(c.path)))rateLimit(who, c.method==="PUT"&&c.path.includes("/uploads/")?"chunks":"writes", c.method==="PUT"&&c.path.includes("/uploads/")?240:40);
          const origin = c.get("origin");
          if (origin && origin !== publicOrigin)
            throw new ConsoleError(403, "ORIGIN_DENIED", "Cross-origin writes are not permitted.");
        }
        const result = await handler(c, who);
        if (result !== undefined) c.body = result;
      } catch (error) {
        const info=publicBackendError(error),requestId=randomUUID();c.status=info.status;
        c.body={status:c.status,data:{...info,requestId},time:Date.now()};
        if(!(error instanceof ConsoleError))console.warn('Codex operation failed %s',JSON.stringify({requestId,code:info.code,rpcCode:'rpcCode' in info?info.rpcCode:undefined}));
      }
    };
  }
  function param(c: Koa.ParameterizedContext, key: string, max = 2048): string {
    const v = c.query[key];
    if (v === undefined) return "";
    if (typeof v !== "string" || v.length > max)
      throw new ConsoleError(400, "INVALID_PARAMETER", `Invalid ${key}.`);
    return v;
  }
  function body(c: Koa.ParameterizedContext): any {
    const b = (c.request as any).body;
    if (!b || typeof b !== "object" || Array.isArray(b))
      throw new ConsoleError(400, "INVALID_BODY", "A JSON object is required.");
    return b;
  }
  async function root(who: Identity, projectId: string, capability: "view" | "files") {
    const p = service.project(who, projectId, capability);
    if(projectId===STORAGE_ID){if(!config.value.accountIsolation)throw new ConsoleError(503,"STORAGE_ISOLATION_REQUIRED","服务器尚未启用账号隔离文件库。");await ensureStorage(config.file,who);}
    if (!config.value.enabled)
      throw new ConsoleError(409, "DISABLED", "Codex console is disabled.");
    if ((await fs.realpath(p.root).catch(() => "")) !== p.root)
      throw new ConsoleError(
        409,
        "ROOT_CHANGED",
        "The project root changed; reconfigure it before continuing."
      );
    return p.root;
  }
  router.get(
    "/status",
    wrap((_c, who) => service.status(who))
  );
  router.get(
    "/projects",
    wrap((_c, who) => service.refreshProjects(who))
  );
  router.get('/projects/default-directory',wrap((_c,who)=>service.projectDirectory(who)));
  router.post('/projects',wrap((c,who)=>{rateLimit(who,'project-create',10);return service.createProject(who,body(c));}));
  router.post('/threads/:id/actions/:action',wrap((c,who)=>{rateLimit(who,'task-action',20);const b=body(c);return service.taskAction(who,b.projectId,c.params.id,c.params.action,b);}));
  router.get(
    "/models",
    wrap((c, who) => service.models(who, param(c, "projectId", 64) || undefined, param(c, "threadId", 128) || undefined))
  );
  router.post('/task-creations',wrap((c,who)=>{rateLimit(who,'create',10);const b=body(c);return service.createTask(who,b.projectId,b);}));
  router.get('/task-creations/:id',wrap((c,who)=>{rateLimit(who,'creation-status',60);return service.taskCreation(who,c.params.id);}));
  router.get("/extensions",wrap((c,who)=>{ rateLimit(who,"extensions",30); return service.extensions(who,param(c,"projectId",64),c.query.refresh==="1"); }));
  router.get("/mcp",wrap((c,who)=>service.mcp(who,param(c,"projectId",64),param(c,"threadId",128)||undefined)));
  router.get("/threads/:id/goal",wrap((c,who)=>service.goal(who,param(c,"projectId",64),c.params.id)));
  router.put("/threads/:id/goal",wrap((c,who)=>{ const b=body(c); return service.goal(who,b.projectId,c.params.id,b.objective); }));
  router.get(
    "/threads",
    wrap(async(c,who)=>{const projectId=param(c,"projectId",64);await recoverReadConnection(who,projectId);const result=await service.listThreads(who,projectId,param(c,"cursor"));return {...result,connection:service.status(who)};})
  );
  router.post(
    "/threads",
    wrap((c, who) => {
      rateLimit(who, "create", 10);
      const b = body(c);
      return service.createThread(who, b.projectId, b.title, b.requestId);
    })
  );
  router.get(
    "/threads/:id",
    wrap(async(c,who)=>{const projectId=param(c,"projectId",64);await recoverReadConnection(who,projectId);const snapshot=await service.snapshot(who,projectId,c.params.id);return {...snapshot,connection:service.status(who),queue:queue.rows(who,projectId,c.params.id)};})
  );
  router.post('/threads/:id/sync',wrap(async(c,who)=>{const b=body(c);await recoverReadConnection(who,b.projectId);const snapshot=await service.snapshot(who,b.projectId,c.params.id);return historySync({...snapshot,connection:service.status(who),queue:queue.rows(who,b.projectId,c.params.id)},b);}));
  router.get('/threads/:id/meta',wrap(async(c,who)=>{const projectId=param(c,'projectId',64);await recoverReadConnection(who,projectId);const {items,turns,...meta}=await service.snapshot(who,projectId,c.params.id);return {...meta,connection:service.status(who)};}));
  router.post(
    "/threads/:id/messages",
    wrap((c, who) => {
      const b = body(c);
      return service.send(who, b.projectId, c.params.id, b);
    })
  );
  router.get('/threads/:id/queue',wrap((c,who)=>queue.list(who,param(c,'projectId',64),c.params.id)));
  router.post('/threads/:id/queue',wrap((c,who)=>{const b=body(c);return queue.enqueue(who,b.projectId,c.params.id,b);}));
  router.patch('/threads/:id/queue/:messageId',wrap((c,who)=>{const b=body(c);return queue.change(who,b.projectId,c.params.id,c.params.messageId,b);}));
  router.post(
    "/threads/:id/interrupt",
    wrap((c, who) => service.interrupt(who, body(c).projectId, c.params.id))
  );
  router.post(
    "/threads/:id/approvals/:requestId",
    wrap((c, who) => {
      const b = body(c);
      return service.answer(who, b.projectId, c.params.id, c.params.requestId, b);
    })
  );
  router.get(
    "/files",
    wrap(async (c, who) =>
      listProjectFiles(await root(who, param(c, "projectId", 64), "files"), param(c, "path") || ".")
    )
  );
  const fileFeatures=installFileRoutes(router,{root,wrap,project:(who,id)=>service.project(who,id,"files"),snapshot:(who,id,threadId)=>service.snapshot(who,id,threadId)});
  router.post(
    "/files",
    wrap(async (c, who) => {
      rateLimit(who, "upload", 10);
      const b = body(c);
      return uploadProjectFile(await root(who, b.projectId, "files"), b.name, b.base64);
    })
  );
  router.get(
    "/diff",
    wrap(async (c, who) =>
      projectDiff(
        await root(who, param(c, "projectId", 64), "files"),
        param(c, "path") || undefined
      )
    )
  );
  router.get(
    "/admin/discover",
    wrap((_c, who) => {
      requireAdmin(who);
      rateLimit(who, "discover", 6);
      return service.discover(who);
    })
  );
  router.get("/account/usage",wrap(async(_c,who)=>{await sampleQuota(who);return usage.overview(who);}));
  router.get("/account/usage/members",wrap(async(_c,who)=>{requireAdmin(who);rateLimit(who,"usage-members",12);await sampleQuota(who);return usage.memberOverview(who,listMembers());}));
  router.get("/account/usage/details",wrap((c,who)=>{rateLimit(who,"usage-details",12);const range=param(c,"range",8)||"today",before=Number(param(c,"before",20))||undefined,offsetMinutes=Number(param(c,"offset",6))||0;if(!["today","yesterday","month","7d","30d","all","custom"].includes(range)||before!==undefined&&(!Number.isSafeInteger(before)||before<1)||!Number.isInteger(offsetMinutes)||Math.abs(offsetMinutes)>840)throw new ConsoleError(400,"INVALID_USAGE_FILTER","统计筛选条件无效。");const start=param(c,'start',20),end=param(c,'end',20);if(range==='custom'&&(!start||!end||!Number.isSafeInteger(Number(start))||!Number.isSafeInteger(Number(end))||Number(start)<0||Number(end)<Number(start)))throw new ConsoleError(400,'INVALID_USAGE_FILTER','统计日期无效。');return usage.details(who,{range,before,offsetMinutes,...(range==='custom'?{start:Number(start),end:Number(end)}:{}),model:param(c,"model",128)||undefined,provider:param(c,"provider",128)||undefined});}));
  router.get("/account/usage/records/:id",wrap((c,who)=>{const id=Number(c.params.id);if(!Number.isSafeInteger(id)||id<1)throw new ConsoleError(400,"INVALID_USAGE_ID","无效的记录 ID。");return usage.detail(who,id);}));
  router.get("/account/usage/settings",wrap((_c,who)=>usage.settings(who)));
  router.put("/account/usage/settings",wrap((c,who)=>{rateLimit(who,"usage-settings",3);return usage.configure(who,body(c));}));
  router.get(
    "/account/limits",
    wrap((_c, who) => service.rateLimits(who))
  );
  router.post(
    "/account/limits/reset",
    wrap(async (c, who) => {
      requireAdmin(who);rateLimit(who,"quota-reset",3);
      const b = body(c);
      try{usage.sample(await service.rateLimits(who,true));}catch{/* Missing pre-reset sampling stays an explicit observation gap. */}
      const result=await service.consumeRateLimitReset(who,b.requestId,b.creditId);
      usage.recordReset(who,b.requestId,b.creditId,result);
      sampledAt=0;return result;
    })
  );
  router.get(
    "/admin/config",
    wrap((_c, who) => {
      requireAdmin(who);
      return config.value;
    })
  );
  router.put(
    "/admin/config",
    wrap(async (c, who) => {
      requireAdmin(who);
      if (await service.activeWork())
        throw new ConsoleError(
          409,
          "TASKS_ACTIVE",
          "Stop or finish active tasks before reconfiguring the backend."
        );
      // New ACLs apply before any new event can be forwarded. All old streams are closed.
      await config.save({...body(c),defaultOwnerId:config.value.defaultOwnerId,projects:body(c).projects?.map((p:any)=>({...p,ownerId:p.ownerId||config.value.defaultOwnerId}))});
      reconnectAllowed=false;
      for (const stream of streams) stream.end();
      service.disconnect();
      return { ok: true };
    })
  );
  router.post(
    "/admin/connect",
    wrap(async (_c, who) => {
      requireAdmin(who);
      rateLimit(who, "connect", 6);
      reconnectAllowed=true;lastReconnectAt=0;
      await service.connect();
      return service.status(who);
    })
  );
  router.post(
    "/admin/disconnect",
    wrap(async (_c, who) => {
      requireAdmin(who);
      if (await service.activeWork())
        throw new ConsoleError(
          409,
          "TASKS_ACTIVE",
          "Stop or finish active tasks before disconnecting the backend."
        );
      reconnectAllowed=false;
      service.disconnect();
      return { ok: true };
    })
  );
  router.get(
    "/events",
    wrap(async (c, who) => {
      const projectId = param(c, "projectId", 64);
      const threadId = param(c, "threadId", 128);
      const cursor = c.get("Last-Event-ID") || param(c, "cursor");
      if (cursor.length > 256) throw new ConsoleError(400, "INVALID_CURSOR", "Event cursor is too long.");
      await recoverReadConnection(who,projectId);
      await service.snapshot(who, projectId, threadId);
      const owned = [...streams].filter((s: any) => s.codexUserId === who.uuid).length;
      if (owned >= 6 || streams.size >= 100)
        throw new ConsoleError(429, "STREAM_LIMIT", "Too many active console connections.");
      const stream = new PassThrough({ highWaterMark: 64 * 1024 });
      stream.on("error", () => {});
      (stream as any).codexUserId = who.uuid;
      streams.add(stream);
      c.status = 200;
      c.type = "text/event-stream";
      c.set("Cache-Control", "no-store, no-transform");
      c.set("X-Accel-Buffering", "no");
      c.set("X-Content-Type-Options", "nosniff");
      c.body = stream;
      stream.write(": connected\n\n");
      const allowed = () => {
        const user = sessionIdentity(c);
        try{return Boolean(config.value.enabled && user && service.project(user,projectId) && (!usage.owner(threadId)||usage.owner(threadId)===user.uuid));}catch{return false;}
      };
      const write = (event: any) => {
        if (stream.destroyed || stream.writableEnded) return;
        if (!allowed()) {
          stream.end();
          return;
        }
        if (!stream.write(`id: ${event.cursor}\nevent: codex\ndata: ${JSON.stringify(event)}\n\n`))
          stream.destroy();
      };
      if (cursor) {
        const replay = service.hub.replay(cursor, projectId, threadId);
        if (replay === null)
          write({
            cursor: service.hub.cursor,
            type: "reset",
            payload: { reason: "cursor-expired" }
          });
        else for (const event of replay) write(event);
      } else
        write({
          cursor: service.hub.cursor,
          type: "reset",
          payload: { reason: "snapshot-required" }
        });
      const unsubscribe = service.hub.subscribe((event) => {
        if (service.hub.matches(event, projectId, threadId)) write(event);
      });
      const heartbeat = setInterval(() => {
        if (!allowed()) stream.end();
        else if (!stream.write(": heartbeat\n\n")) stream.destroy();
      }, 20000);
      // Reauthenticate periodically; no indefinitely valid stream survives a logout/ban.
      const expiry = setTimeout(() => stream.end(), 600000);
      const cleanup = () => {
        clearInterval(heartbeat);
        clearTimeout(expiry);
        unsubscribe();
        streams.delete(stream);
      };
      stream.once("close", cleanup);
      c.res.once("close", () => stream.destroy());
    })
  );
  return { router, service, closeStreams() { for (const stream of streams) stream.destroy(); },
    close() { fileFeatures.close(); void queue.close(); for (const stream of streams) stream.destroy(); service.disconnect(); usage.close(); } };
}
