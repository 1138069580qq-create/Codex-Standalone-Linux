import { randomBytes, randomUUID, scrypt as derive, timingSafeEqual, createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { ConsoleError, type Identity } from "./backend/config";
const scrypt = promisify(derive);
export type User = { id: string; username: string; passwordHash: string; admin: boolean; revision: string };
export const publicUser = ({ id, username, admin }: User) => ({ id, username, admin });
const invalid = (message: string): never => { throw new ConsoleError(400, "INVALID_USER", message); };
export async function hashPassword(password: string): Promise<string> {
  if (typeof password !== "string" || password.length < 12 || password.length > 256)
    invalid("Password must contain 12–256 characters.");
  const salt = randomBytes(16).toString("hex");
  const hash = await scrypt(password, salt, 64) as Buffer;
  return `scrypt$1$${salt}$${hash.toString("hex")}`;
}
export async function verifyPassword(password: unknown, encoded: string): Promise<boolean> {
  if (typeof password !== "string" || password.length > 256) return false;
  const parts = encoded.split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt" || parts[1] !== "1" ||
      !/^[a-f0-9]{32}$/.test(parts[2]) || !/^[a-f0-9]{128}$/.test(parts[3])) return false;
  const actual = await scrypt(password, parts[2], 64) as Buffer;
  return timingSafeEqual(actual, Buffer.from(parts[3], "hex"));
}
export class UserStore {
  users: User[] = [];
  private writing: Promise<unknown> = Promise.resolve();
  constructor(readonly file: string) {}
  async load() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, "utf8"));
      if (!Array.isArray(parsed) || parsed.length > 100) throw new Error("Invalid user database");
      const names = new Set<string>(); const ids = new Set<string>();
      for (const u of parsed) {
        if (!u || typeof u.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(u.id) || ids.has(u.id) ||
          typeof u.username !== "string" || !/^[a-zA-Z0-9_.@-]{1,80}$/.test(u.username) || names.has(u.username.toLowerCase()) ||
          typeof u.admin !== "boolean" || typeof u.revision !== "string" ||
          !/^scrypt\$1\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(u.passwordHash)) throw new Error("Invalid user database");
        names.add(u.username.toLowerCase()); ids.add(u.id);
      }
      this.users = parsed;
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
  async upsert(input: { id?: string; username: string; password?: string; admin: boolean }) {
    const update = this.writing.then(async () => {
      if (!input || typeof input.username !== "string" || !/^[a-zA-Z0-9_.@-]{1,80}$/.test(input.username) || typeof input.admin !== "boolean")
        invalid("Use a username of 1–80 letters, numbers, '.', '@', '_' or '-'.");
      const old = input.id ? this.users.find(u => u.id === input.id) : undefined;
      if (input.id && !old) invalid("User does not exist.");
      if (this.users.some(u => u.id !== old?.id && u.username.toLowerCase() === input.username.toLowerCase())) invalid("Username already exists.");
      if (!old && this.users.length >= 100) invalid("At most 100 users.");
      const user: User = { id: old?.id || randomUUID(), username: input.username, admin: input.admin,
        passwordHash: input.password ? await hashPassword(input.password) : old?.passwordHash || invalid("Password required."), revision: randomUUID() };
      const next = [...this.users.filter(u => u.id !== user.id), user];
      if (!next.some(u => u.admin)) invalid("At least one administrator must remain.");
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      await fs.writeFile(temp, JSON.stringify(next, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      await fs.rename(temp, this.file);
      this.users = next;
      return publicUser(user);
    });
    this.writing = update.catch(() => {});
    return update;
  }
}
type Session = { userId: string; revision: string; csrf: string; expires: number; touched: number };
export class Sessions {
  private records = new Map<string, Session>();
  private digest(token: string) { return createHash("sha256").update(token).digest("hex"); }
  create(user: User) {
    const now = Date.now();
    for (const [key, value] of this.records) if (value.expires <= now || now - value.touched > 30 * 60_000) this.records.delete(key);
    // Bound total sessions and sessions per account; oldest sessions expire first.
    for (const [key, value] of this.records) {
      if (this.records.size >= 1000 || (value.userId === user.id && [...this.records.values()].filter(v => v.userId === user.id).length >= 8)) this.records.delete(key);
    }
    const token = randomBytes(32).toString("base64url");
    const session = { userId: user.id, revision: user.revision, csrf: randomBytes(24).toString("base64url"), expires: now + 12 * 3600_000, touched: now };
    this.records.set(this.digest(token), session);
    return { token, ...session };
  }
  get(token: string, users: UserStore) {
    const key = this.digest(token); const session = this.records.get(key); const now = Date.now();
    const user = session && users.users.find(u => u.id === session.userId && u.revision === session.revision);
    if (!session || !user || session.expires <= now || now - session.touched > 30 * 60_000) { this.records.delete(key); return null; }
    session.touched = now;
    return { session, user, identity: { uuid: user.id, elevated: user.admin } as Identity };
  }
  revoke(token: string) { this.records.delete(this.digest(token)); }
}
export class RateLimiter {
  private buckets = new Map<string, { at: number; count: number }>();
  take(key: string, limit: number, windowMs: number) {
    const now = Date.now();
    if (this.buckets.size >= 4096) for (const [k, b] of this.buckets) if (now >= b.at) this.buckets.delete(k);
    const old = this.buckets.get(key);
    if (!old && this.buckets.size >= 4096) throw new ConsoleError(429, "RATE_LIMIT", "Try again later.");
    const bucket = old && old.at > now ? old : { at: now + windowMs, count: 0 };
    this.buckets.set(key, bucket);
    if (++bucket.count > limit) throw new ConsoleError(429, "RATE_LIMIT", "Too many attempts. Try again later.");
  }
}
