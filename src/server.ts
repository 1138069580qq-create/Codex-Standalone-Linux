import Koa from "koa";
import Router from "@koa/router";
import bodyParser from "koa-bodyparser";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { gzip, gzipSync, brotliCompressSync } from "node:zlib";
import { promisify } from "node:util";
import { UserStore, Sessions, RateLimiter, hashPassword, verifyPassword, publicUser } from "./auth";
import { ConsoleError, requireAdmin } from "./backend/config";
import { ProtectedConfigStore } from "./protected-config";
import { RegistrationQueue } from "./registration";
import { CHUNK_BYTES, readBounded } from "./backend/transfers";
import { settings } from "./settings";
import { createCodexRoutes, type ServiceFactory } from "./routes";
const zip = promisify(gzip);
const staticDir = path.resolve(__dirname, "../public");
export async function createApp(options = settings(), serviceFactory?: ServiceFactory) {
  const app = new Koa();
  // Explicit external origin, never trust arbitrary X-Forwarded-* headers.
  app.proxy = false;
  app.silent = true;
  const users = new UserStore(path.join(options.dataDir, "users.json")); await users.load();
  if (!users.users.some(u => u.admin)) throw new Error("No administrator. Run npm run user:add -- --username admin --admin first.");
  const config = new ProtectedConfigStore(path.join(options.dataDir, "config.json")); await config.load();
  // Preserve old data and assign an explicit owner before serving any account.
  const defaultOwnerId=config.value.defaultOwnerId||users.users.find(u=>u.admin)!.id;
  if(!config.value.defaultOwnerId||config.value.projects.some(p=>!p.ownerId)) {
    await config.save({...config.value,defaultOwnerId,projects:config.value.projects.map(p=>({...p,ownerId:p.ownerId||(p.grants.filter(g=>g.permissions.includes("view")).length===1?p.grants.find(g=>g.permissions.includes("view"))!.userId:defaultOwnerId)}))});
  }
  const registrations = new RegistrationQueue(path.join(options.dataDir,"registrations.json"),users); await registrations.load();
  const sessions = new Sessions(); const limiter = new RateLimiter();
  const cookieName = options.secureCookies ? "__Host-codex_webui" : "codex_webui";
  // A normal-cost dummy hash prevents the missing-user path becoming a username oracle.
  const dummy = await hashPassword("not-a-real-login-" + Date.now());
  let authInFlight = 0; let parsing = 0;
  const token = (ctx: Koa.Context) => ctx.cookies.get(cookieName, { signed: false }) || "";
  const current = (ctx: Koa.Context) => sessions.get(token(ctx), users);
  const routes = await createCodexRoutes(config, options.origin, ctx => current(ctx)?.identity || null, serviceFactory, () => users.users.map(publicUser), id=>{const user=users.users.find(u=>u.id===id);return user?{uuid:user.id,elevated:user.admin}:null;});
  function setCookie(ctx: Koa.Context, value: string, maxAge: number) {
    // TLS may terminate at the configured reverse proxy. Origin is startup-validated.
    ctx.cookies.secure = options.secureCookies;
    ctx.cookies.set(cookieName, value, { httpOnly: true, sameSite: "strict", secure: options.secureCookies,
      signed: false, overwrite: true, path: "/", maxAge });
  }
  app.use(async (ctx, next) => {
    ctx.set("X-Content-Type-Options", "nosniff");
    ctx.set("Referrer-Policy", "no-referrer");
    ctx.set("X-Frame-Options", "DENY");
    ctx.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    ctx.set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; media-src 'self'; frame-src 'self' https:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (options.secureCookies) ctx.set("Strict-Transport-Security", "max-age=31536000");
    ctx.set("Cache-Control", "no-store");
    try { await next(); }
    catch (error) {
      const known = error instanceof ConsoleError;
      const status = known ? error.status : Number((error as any).status);
      ctx.status = status >= 400 && status <= 599 ? status : 500;
      ctx.body = { status: ctx.status, data: { code: known ? error.code : "REQUEST_FAILED",
        message: known ? error.message : "Request failed. Check input and server configuration." } };
    }
    if (ctx.status === 429) ctx.set("Retry-After", "60");
    // SSE and downloads are streams: deliberately never buffer/compress them here.
    if (ctx.body && typeof ctx.body === "object" && !Buffer.isBuffer(ctx.body) && typeof (ctx.body as any).pipe !== "function") {
      const data = Buffer.from(JSON.stringify(ctx.body)); ctx.type = "application/json";
      ctx.vary("Accept-Encoding");
      if (data.length >= 1024 && ctx.acceptsEncodings("gzip", "identity") === "gzip") {
        ctx.body = await zip(data); ctx.set("Content-Encoding", "gzip");
      } else ctx.body = data;
    }
  });
  app.use(async (ctx, next) => {
    if (!ctx.path.startsWith("/api/")) return next();
    limiter.take(`http:${ctx.ip}`, 600, 60_000);
    if (!["GET", "HEAD"].includes(ctx.method)) {
      if (ctx.get("origin") && ctx.get("origin") !== options.origin) throw new ConsoleError(403, "ORIGIN_DENIED", "Cross-origin request denied.");
      if (ctx.get("sec-fetch-site") === "cross-site") throw new ConsoleError(403, "ORIGIN_DENIED", "Cross-site request denied.");
      if (!["/api/login", "/api/register"].includes(ctx.path)) {
        const active = current(ctx);
        if (!active) throw new ConsoleError(401, "LOGIN_REQUIRED", "Sign in first.");
        if (ctx.get("x-csrf-token") !== active.session.csrf) throw new ConsoleError(403, "CSRF_DENIED", "Session token missing. Reload and sign in again.");
      }
    }
    if (!["/api/login", "/api/register", "/api/session"].includes(ctx.path) && !current(ctx)) throw new ConsoleError(401, "LOGIN_REQUIRED", "Sign in first.");
    if (["/api/login", "/api/register"].includes(ctx.path) && ctx.method === "POST") {
      if (ctx.path === "/api/register") limiter.take(`register:${ctx.ip}`, 5, 15 * 60_000);
      limiter.take(`login:${ctx.ip}`, 12, 15 * 60_000);
      if (Number(ctx.get("content-length")) > 4096) throw new ConsoleError(413, "BODY_TOO_LARGE", "Login request too large.");
    }
    return next();
  });
  const parse = bodyParser({ enableTypes: ["json"], jsonLimit: "6mb", strict: true });
  const parseLogin = bodyParser({ enableTypes: ["json"], jsonLimit: "4kb", strict: true });
  app.use(async (ctx, next) => {
    if (!["POST", "PUT", "PATCH"].includes(ctx.method)) return next();
    if (ctx.method === "PUT" && /^\/api\/codex\/uploads\/[^/]+$/.test(ctx.path)) {
      if (!ctx.is("application/octet-stream")) throw new ConsoleError(415,"BINARY_REQUIRED","Send application/octet-stream.");
      if (parsing >= 4) throw new ConsoleError(429,"BODY_BUSY","Too many concurrent uploads.");
      if(Number(ctx.get("content-length"))>CHUNK_BYTES)throw new ConsoleError(413,"TRANSFER_TOO_LARGE","Chunk exceeds 256 KiB.");
      parsing++;try { ctx.request.body=await readBounded(ctx.req,CHUNK_BYTES); } finally { parsing--; }
      return next();
    }
    if (!ctx.is("application/json")) throw new ConsoleError(415, "JSON_REQUIRED", "Send application/json.");
    if (parsing >= 4) throw new ConsoleError(429, "BODY_BUSY", "Too many uploads; try again later.");
    parsing++;
    try { await (["/api/login", "/api/register"].includes(ctx.path) ? parseLogin : parse)(ctx, async () => {}); } finally { parsing--; }
    await next();
  });
  const auth = new Router();
  auth.get("/api/session", ctx => {
    const active = current(ctx);
    if (!active) throw new ConsoleError(401, "LOGIN_REQUIRED", "Sign in first.");
    ctx.body = { user: publicUser(active.user), csrf: active.session.csrf };
  });
  auth.post("/api/login", async ctx => {
    if (authInFlight >= 4) throw new ConsoleError(429, "AUTH_BUSY", "Try again later.");
    const body = ctx.request.body as any;
    if (!body || typeof body.username !== "string" || body.username.length > 80 || typeof body.password !== "string" || body.password.length > 256)
      throw new ConsoleError(400, "INVALID_LOGIN", "Invalid login input.");
    const user = users.users.find(u => u.username.toLowerCase() === body.username.toLowerCase());
    authInFlight++;
    let valid: boolean;
    try { valid = await verifyPassword(body.password, user?.passwordHash || dummy); } finally { authInFlight--; }
    if (!valid || !user) throw new ConsoleError(401, "INVALID_LOGIN", "Invalid username or password.");
    sessions.revoke(token(ctx));
    const created = sessions.create(user); setCookie(ctx, created.token, 12 * 3600_000);
    ctx.body = { user: publicUser(user), csrf: created.csrf };
  });
  auth.post("/api/register", async ctx => {
    if (authInFlight >= 4) throw new ConsoleError(429, "AUTH_BUSY", "请求较多，请稍后再试。");
    const body = ctx.request.body as any;
    if (!body || Array.isArray(body) || typeof body.username !== "string" || typeof body.password !== "string" ||
        Object.keys(body).some(key => !["username", "password"].includes(key)))
      throw new ConsoleError(400, "INVALID_REGISTRATION", "注册只需用户名和密码，不能设置账户权限。");
    authInFlight++;
    try {
      ctx.body = await registrations.submit(body.username, body.password);
      ctx.status = 202;
    } finally { authInFlight--; }
  });
  auth.post("/api/logout", ctx => { sessions.revoke(token(ctx)); setCookie(ctx, "", 0); routes.closeStreams(); ctx.body = { ok: true }; });
  auth.get("/api/admin/users", ctx => { requireAdmin(current(ctx)!.identity); ctx.body = users.users.map(publicUser); });
  auth.put("/api/admin/users", async ctx => {
    const who = current(ctx)!; requireAdmin(who.identity);
    limiter.take(`users:${who.user.id}`, 10, 60_000);
    ctx.body = await users.upsert(ctx.request.body as any);
    // Role/password changes revoke affected sessions immediately, including open SSE.
    routes.closeStreams();
  });
  auth.get("/api/admin/registrations",ctx=>{requireAdmin(current(ctx)!.identity);ctx.body=registrations.list();});
  auth.post("/api/admin/registrations/:id",async ctx=>{const who=current(ctx)!;requireAdmin(who.identity);limiter.take(`review:${who.user.id}`,30,60000);ctx.body=await registrations.review(ctx.params.id,(ctx.request.body as any)?.decision);});
  app.use(auth.routes()).use(auth.allowedMethods());
  app.use(routes.router.routes()).use(routes.router.allowedMethods());
  const assets = new Map<string, { raw: Buffer; gzip: Buffer; br: Buffer; etag: string; type: string }>();
  const allowed = [["/", "index.html", "text/html"], ["/features.js", "features.js", "text/javascript"], ["/app.js", "app.js", "text/javascript"], ["/queue.js", "queue.js", "text/javascript"], ["/state.js", "state.js", "text/javascript"], ["/usage.js", "usage.js", "text/javascript"], ["/style.css", "style.css", "text/css"]];
  const assetVersions = new Map<string,string>();
  for(const [route,filename] of allowed) if(route !== "/") assetVersions.set(route,createHash("sha256").update(await fs.readFile(path.join(staticDir,filename))).digest("hex").slice(0,12));
  for (const [route, filename, type] of allowed) {
    let raw = await fs.readFile(path.join(staticDir, filename));
    if(route === "/") {
      let html=raw.toString("utf8");
      for(const [asset,version] of assetVersions) html=html.replaceAll(`"${asset}"`,`"${asset}?v=${version}"`);
      raw=Buffer.from(html);
    }
    assets.set(route, { raw, gzip: gzipSync(raw), br: brotliCompressSync(raw), etag: `W/"${createHash("sha256").update(raw).digest("hex").slice(0, 20)}"`, type });
  }
  app.use(ctx => {
    if (ctx.path === "/healthz" && ["GET", "HEAD"].includes(ctx.method)) { ctx.body = { ok: true }; return; }
    if (!["GET", "HEAD"].includes(ctx.method)) { ctx.status = 405; return; }
    const asset = assets.get(ctx.path);
    if (!asset) { ctx.status = 404; ctx.body = { error: "Not found" }; return; }
    ctx.type = asset.type; ctx.set("ETag", asset.etag); ctx.vary("Accept-Encoding");
    ctx.set("Cache-Control", ctx.path === "/" ? "no-cache" : "public, max-age=3600, must-revalidate");
    if (ctx.get("if-none-match") === asset.etag) { ctx.status = 304; return; }
    const encoding = ctx.acceptsEncodings("br", "gzip", "identity");
    if (encoding === "br" || encoding === "gzip") { ctx.body = asset[encoding]; ctx.set("Content-Encoding", encoding); }
    else ctx.body = asset.raw;
  });
  return { app, config, users, service: routes.service, close: routes.close };
}
async function main() {
  const opts = settings(); const runtime = await createApp(opts);
  const server = runtime.app.listen(opts.port, opts.host, () => console.log(`Codex WebUI listening on ${opts.origin} (attach-only; no Codex process launched)`));
  server.requestTimeout = 30_000; server.headersTimeout = 15_000; server.keepAliveTimeout = 5_000;
  server.on("error", () => { console.error("Could not listen. Check host/port and permissions."); runtime.close(); process.exitCode = 1; });
  let closing = false;
  const stop = () => {
    if (closing) return; closing = true; runtime.close();
    server.close(() => { process.exitCode = 0; });
    setTimeout(() => { server.closeAllConnections(); }, 5000).unref();
  };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
}
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
