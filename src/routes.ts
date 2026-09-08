import path from "node:path";
import { PassThrough } from "node:stream";
import { promises as fs } from "node:fs";
import type Koa from "koa";
import Router from "@koa/router";
import { ConfigStore, ConsoleError, type Identity, requireAdmin, permissions } from "./backend/config";
import { CommandReceipts } from "./backend/receipts";
import { CodexConsoleService } from "./backend/service";
import { listProjectFiles, openProjectDownload, uploadProjectFile, projectDiff } from "./backend/files";

export type ServiceFactory = (config: ConfigStore, receipts: CommandReceipts) => CodexConsoleService;

export async function createCodexRoutes(config: ConfigStore, publicOrigin: string,
  sessionIdentity: (ctx: Koa.Context) => Identity | null, factory?: ServiceFactory) {
  const receipts = new CommandReceipts(path.join(path.dirname(config.file), "receipts.json"));
  await receipts.load();
  const service = factory ? factory(config, receipts) : new CodexConsoleService(config, receipts);
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
        if (c.method !== "GET") {
          rateLimit(who, "writes", 40);
          const origin = c.get("origin");
          if (origin && origin !== publicOrigin)
            throw new ConsoleError(403, "ORIGIN_DENIED", "Cross-origin writes are not permitted.");
        }
        const result = await handler(c, who);
        if (result !== undefined) c.body = result;
      } catch (error) {
        const known = error instanceof ConsoleError;
        c.status = known ? error.status : 502;
        // Koa's outer protocol leaves non-200 object bodies intact.
        c.body = {
          status: c.status,
          data: {
            code: known ? error.code : "BACKEND_ERROR",
            message: known
              ? error.message
              : "Codex operation failed. Verify its connection, login and project configuration."
          },
          time: Date.now()
        };
        if (!known)
          console.warn(
            "Codex operation failed (%s); request bodies and upstream errors omitted.",
            c.path
          );
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
    wrap((c, who) => service.listThreads(who, param(c, "projectId", 64), param(c, "cursor")))
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
    wrap((c, who) => service.snapshot(who, param(c, "projectId", 64), c.params.id))
  );
  router.post(
    "/threads/:id/messages",
    wrap((c, who) => {
      const b = body(c);
      return service.send(who, b.projectId, c.params.id, b);
    })
  );
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
  router.get(
    "/files/content",
    wrap(async (c, who) => {
      const download = await openProjectDownload(
        await root(who, param(c, "projectId", 64), "files"),
        param(c, "path")
      );
      c.type = "application/octet-stream";
      c.attachment(download.name);
      c.length = download.size;
      c.set("Cache-Control", "no-store");
      c.set("X-Content-Type-Options", "nosniff");
      c.body = download.stream;
    })
  );
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
  router.get(
    "/account/limits",
    wrap((_c, who) => service.rateLimits(who))
  );
  router.post(
    "/account/limits/reset",
    wrap((c, who) => {
      const b = body(c);
      return service.consumeRateLimitReset(who, b.requestId, b.creditId);
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
      if (service.hasActiveWork)
        throw new ConsoleError(
          409,
          "TASKS_ACTIVE",
          "Stop or finish active tasks before reconfiguring the backend."
        );
      // New ACLs apply before any new event can be forwarded. All old streams are closed.
      await config.save(body(c));
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
      await service.connect();
      return service.status(who);
    })
  );
  router.post(
    "/admin/disconnect",
    wrap((_c, who) => {
      requireAdmin(who);
      if (service.hasActiveWork)
        throw new ConsoleError(
          409,
          "TASKS_ACTIVE",
          "Stop or finish active tasks before disconnecting the backend."
        );
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
        try{return Boolean(config.value.enabled && user && service.project(user,projectId));}catch{return false;}
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
    close() { for (const stream of streams) stream.destroy(); service.disconnect(); } };
}
