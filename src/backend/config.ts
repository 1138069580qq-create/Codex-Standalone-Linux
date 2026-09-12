import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { randomUUID } from "crypto";

export class ConsoleError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message);
    this.name = "ConsoleError";
  }
}
export type Capability = "view" | "send" | "approve" | "files";
export interface Identity {
  uuid: string;
  elevated: boolean;
  role?: number;
}
export interface Project {
  downloadHosts?: string[];
  ownerId?: string;
  desktopProjectId?: string;
  desktopSavedProjectId?: string;
  id: string;
  name: string;
  root: string;
  grants: Array<{ userId: string; permissions: Capability[] }>;
}
export interface ConsoleConfig {
  accountIsolation?: boolean;
  defaultOwnerId?: string;
  enabled: boolean;
  transport: {
    type: "unix" | "websocket";
    endpoint: string;
    bearerTokenEnv?: string;
  };
  maxConcurrentTurns: number;
  projects: Project[];
}
export const defaultConfig = (): ConsoleConfig => ({
  enabled: false,
  transport: { type: "unix", endpoint: "" },
  maxConcurrentTurns: 5,
  projects: []
});
const capabilities: Capability[] = ["view", "send", "approve", "files"];
export function isWithin(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel));
}
function invalid(message: string): never {
  throw new ConsoleError(400, "INVALID_CONFIG", message);
}
export async function validateConfig(value: unknown): Promise<ConsoleConfig> {
  const input = value as ConsoleConfig;
  if(input?.accountIsolation!==undefined&&typeof input.accountIsolation!=="boolean")invalid("Invalid account isolation setting.");
  if (!input || typeof input.enabled !== "boolean" || !input.transport)
    invalid("Invalid console configuration.");
  const tr = input.transport;
  if (!["unix", "websocket"].includes(tr.type))
    invalid(
      "Attach-only: connect the existing desktop Codex backend using unix or websocket. Starting another Codex is not allowed."
    );
  if (Object.keys(tr).some((key) => !["type", "endpoint", "bearerTokenEnv"].includes(key)))
    invalid(
      "Attach-only transport accepts no executable, arguments, CODEX_HOME or process-launch settings."
    );
  if (typeof tr.endpoint !== "string" || tr.endpoint.length > 2048 || tr.endpoint.includes("\0"))
    invalid("Invalid endpoint.");
  if (tr.type === "unix" && (input.enabled || tr.endpoint) && !path.isAbsolute(tr.endpoint))
    invalid("Unix socket path must be absolute.");
  if (tr.type === "websocket") {
    let u: URL;
    try {
      u = new URL(tr.endpoint);
    } catch {
      invalid("Invalid WebSocket URL.");
    }
    if (
      !["ws:", "wss:"].includes(u!.protocol) ||
      u!.username ||
      u!.password ||
      u!.search ||
      u!.hash
    )
      invalid("Use a WebSocket URL without embedded credentials.");
    if (u!.protocol === "ws:" && !["127.0.0.1", "[::1]", "localhost"].includes(u!.hostname))
      invalid("Non-loopback WebSockets must use TLS (wss).");
  }
  if (tr.bearerTokenEnv && !/^[A-Z_][A-Z0-9_]{0,100}$/.test(tr.bearerTokenEnv))
    invalid("Specify an environment variable name, not a token.");
  if (
    !Number.isInteger(input.maxConcurrentTurns) ||
    input.maxConcurrentTurns < 1 ||
    input.maxConcurrentTurns > 8
  )
    invalid("Concurrency must be between 1 and 8.");
  if (!Array.isArray(input.projects) || input.projects.length > 100)
    invalid("At most 100 projects are supported.");
  const ids = new Set<string>();
  const projects: Project[] = [];
  const home = await fs.realpath(os.homedir()).catch(() => os.homedir());
  const privateHome = await fs
    .realpath(process.env.CODEX_HOME || path.join(home, ".codex"))
    .catch(() => path.resolve(process.env.CODEX_HOME || path.join(home, ".codex")));
  for (const p of input.projects) {
    if (!p || typeof p.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(p.id) || ids.has(p.id))
      invalid("Project ids must be unique URL-safe identifiers.");
    if (typeof p.name !== "string" || !p.name.trim() || p.name.length > 100)
      invalid("Project name is required (max 100 characters).");
    if (typeof p.root !== "string" || !path.isAbsolute(p.root) || p.root.includes("\0"))
      invalid("Project roots must be absolute existing directories.");
    let root: string;
    try {
      root = await fs.realpath(p.root);
      if (!(await fs.stat(root)).isDirectory()) invalid("Project root is not a directory.");
    } catch {
      invalid("Project directory is not available on the WebUI host.");
    }
    if (
      root! === path.parse(root!).root ||
      root! === home ||
      isWithin(root!, privateHome) ||
      isWithin(privateHome, root!)
    )
      invalid(
        "Do not expose the filesystem root, home directory or Codex credential directory as a project."
      );
    if (projects.some((prior) => isWithin(prior.root, root!) || isWithin(root!, prior.root)))
      invalid(
        "Project roots must not overlap. Add worktrees as separate, non-overlapping projects."
      );
    if (!Array.isArray(p.grants) || p.grants.length > 200) invalid("Invalid project grants.");
    const users = new Set<string>();
    const grants = p.grants.map((g) => {
      if (
        !g ||
        typeof g.userId !== "string" ||
        !g.userId ||
        g.userId.length > 128 ||
        users.has(g.userId)
      )
        invalid("Grant user ids must be unique panel user UUIDs.");
      if (!Array.isArray(g.permissions) || g.permissions.some((c) => !capabilities.includes(c)))
        invalid("Invalid permission.");
      if (g.permissions.some((c) => c !== "view") && !g.permissions.includes("view"))
        invalid("send, approve and files also require view.");
      users.add(g.userId);
      return { userId: g.userId, permissions: Array.from(new Set(g.permissions)) };
    });
    if (p.downloadHosts !== undefined && (!Array.isArray(p.downloadHosts) || p.downloadHosts.length > 10 ||
        p.downloadHosts.some(h => typeof h !== "string" || h.length > 253 || !/^(?=.{1,253}$)[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(h))))
      invalid("Downloads require up to ten exact lowercase HTTPS hostnames, not URLs or wildcards.");
    if(p.ownerId!==undefined && (typeof p.ownerId!=="string" || !/^[-a-zA-Z0-9_]{1,128}$/.test(p.ownerId))) invalid("Invalid project owner.");
    projects.push({ ...(p.ownerId?{ownerId:p.ownerId}:{}), id: p.id, name: p.name.trim(), root: root!, grants, ...(p.downloadHosts ? {downloadHosts: [...new Set(p.downloadHosts)]} : {}), ...(typeof p.desktopProjectId==='string' && /^[-a-zA-Z0-9_]{1,128}$/.test(p.desktopProjectId)?{desktopProjectId:p.desktopProjectId}:{}), ...(typeof p.desktopSavedProjectId==='string' && /^[-a-zA-Z0-9_]{1,128}$/.test(p.desktopSavedProjectId)?{desktopSavedProjectId:p.desktopSavedProjectId}:{}) });
    ids.add(p.id);
  }
  return {
    ...(typeof input.defaultOwnerId==="string" && /^[-a-zA-Z0-9_]{1,128}$/.test(input.defaultOwnerId)?{defaultOwnerId:input.defaultOwnerId}:{}),
    ...(input.accountIsolation===true?{accountIsolation:true}:{}),
    enabled: input.enabled,
    transport: {
      type: tr.type,
      endpoint: tr.endpoint,
      ...(tr.bearerTokenEnv ? { bearerTokenEnv: tr.bearerTokenEnv } : {})
    },
    maxConcurrentTurns: 5,
    projects
  };
}
export function permissions(project: Project, identity: Identity): Record<Capability, boolean> {
  const list =
    project.ownerId && project.ownerId !== identity.uuid ? [] :
    project.ownerId === identity.uuid ? (project.grants.find(g=>g.userId===identity.uuid)?.permissions||capabilities) :
    identity.uuid && identity.elevated
      ? capabilities
      : project.grants.find((g) => g.userId === identity.uuid)?.permissions || [];
  return capabilities.reduce<Record<Capability, boolean>>(
    (result, c) => {
      result[c] = Boolean(identity.uuid) && list.includes(c);
      return result;
    },
    { view: false, send: false, approve: false, files: false }
  );
}
export function requireProject(
  config: ConsoleConfig,
  identity: Identity,
  id: string,
  capability: Capability = "view"
): Project {
  const p = config.projects.find((v) => v.id === id);
  if (!p || !permissions(p, identity)[capability])
    throw new ConsoleError(403, "PROJECT_FORBIDDEN", "Project access denied.");
  return p;
}
export function requireAdmin(identity: Identity): void {
  if (!identity.uuid || !identity.elevated)
    throw new ConsoleError(403, "ADMIN_REQUIRED", "A signed-in administrator is required.");
}
export class ConfigStore {
  value: ConsoleConfig = defaultConfig();
  constructor(readonly file: string) {}
  private protectStore(config: ConsoleConfig): void {
    const stateDir = path.resolve(path.dirname(this.file));
    if (config.projects.some((p) => isWithin(p.root, stateDir) || isWithin(stateDir, p.root)))
      invalid("Project roots must not expose the panel Codex configuration/receipt directory.");
  }
  async load(): Promise<void> {
    try {
      const value = await validateConfig(JSON.parse(await fs.readFile(this.file, "utf8")));
      this.protectStore(value);
      this.value = value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  async save(value: unknown): Promise<void> {
    const valid = await validateConfig(value);
    if(this.value.accountIsolation&&!valid.accountIsolation)throw new ConsoleError(409,"ISOLATION_REQUIRED","账号隔离已启用，不能通过网页关闭。");
    this.protectStore(valid);
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = this.file + "." + randomUUID() + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(valid, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await fs.rename(tmp, this.file);
    this.value = valid;
  }
}
