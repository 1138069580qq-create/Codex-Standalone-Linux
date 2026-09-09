import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { ConsoleError } from "./config";
import { MAX_UPLOAD_BYTES, safeUploadName, uploadProjectBuffer } from "./files";

export const CHUNK_BYTES = 256 * 1024;
const TTL = 15 * 60 * 1000;
interface Upload {
  id: string; owner: string; root: string; name: string; hash: string; size: number;
  offset: number; chunks: Buffer[]; touched: number; result?: { path: string }; committing?: Promise<{ path: string }>;
}
export async function readBounded(stream: Readable, limit: number, timeoutMs = 20000): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  const timer = setTimeout(() => stream.destroy(new ConsoleError(408, "TRANSFER_TIMEOUT", "Transfer timed out.")), timeoutMs);
  try {
    for await (const part of stream) {
      const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
      size += chunk.length;
      if (size > limit) throw new ConsoleError(413, "TRANSFER_TOO_LARGE", "Transfer exceeds the size limit.");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
  } catch(error) { stream.destroy(); throw error; } finally { clearTimeout(timer); }
}
/** Bounded volatile staging: no temporary disk writes, no cross-user dedup oracle. */
export class UploadSessions {
  private entries = new Map<string, Upload>();
  clear() { this.entries.clear(); }
  constructor(private save = uploadProjectBuffer, private now = Date.now) {}
  private prune() {
    for (const [id, entry] of this.entries) if (!entry.committing && this.now() - entry.touched > TTL) this.entries.delete(id);
  }
  begin(owner: string, root: string, name: string, size: number, hash: string) {
    this.prune(); safeUploadName(name);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_UPLOAD_BYTES || typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))
      throw new ConsoleError(400, "INVALID_UPLOAD", "A file size and SHA-256 digest are required.");
    for (const entry of this.entries.values()) {
      if (entry.owner === owner && entry.root === root && entry.name === name && entry.size === size && entry.hash === hash) {
        entry.touched = this.now(); return this.state(entry);
      }
    }
    const active = [...this.entries.values()].filter(e => !e.result);
    if (this.entries.size >= 128 || active.filter(e => e.owner === owner).length >= 4 || active.reduce((n,e) => n + e.size, 0) + size > 64 * 1024 * 1024)
      throw new ConsoleError(429, "UPLOAD_CAPACITY", "Upload capacity is full; finish an existing upload or wait.");
    const entry: Upload = { id: randomUUID(), owner, root, name, size, hash, offset: 0, chunks: [], touched: this.now() };
    this.entries.set(entry.id, entry); return this.state(entry);
  }
  private get(owner: string, root: string, id: string) {
    this.prune(); const entry = this.entries.get(id);
    if (!entry || entry.owner !== owner || entry.root !== root) throw new ConsoleError(404, "UPLOAD_NOT_FOUND", "Upload expired or is unavailable.");
    entry.touched = this.now(); return entry;
  }
  private state(e: Upload) { return { id: e.id, offset: e.offset, chunkBytes: CHUNK_BYTES, ...(e.result || {}) }; }
  status(owner:string, root:string, id:string) { return this.state(this.get(owner,root,id)); }
  append(owner: string, root: string, id: string, offset: number, data: Buffer) {
    const entry = this.get(owner, root, id);
    if (!Number.isSafeInteger(offset) || offset < 0 || !data.length || data.length > CHUNK_BYTES) throw new ConsoleError(400, "INVALID_CHUNK", "Invalid upload chunk.");
    if (entry.committing || entry.result) return this.state(entry);
    // A lost response may cause a retry; acknowledge only byte-identical already received chunks.
    if (offset < entry.offset) {
      let cursor = 0;
      for (const chunk of entry.chunks) { if (cursor === offset && chunk.equals(data)) return this.state(entry); cursor += chunk.length; }
    }
    if (offset !== entry.offset || offset + data.length > entry.size) throw new ConsoleError(409, "UPLOAD_OFFSET", "Upload offset does not match; resume before retrying.");
    entry.chunks.push(Buffer.from(data)); entry.offset += data.length; return this.state(entry);
  }
  async commit(owner: string, root: string, id: string) {
    const entry = this.get(owner, root, id);
    if (entry.result) return entry.result;
    if (entry.committing) return entry.committing;
    if (entry.offset !== entry.size) throw new ConsoleError(409, "UPLOAD_INCOMPLETE", "Upload is incomplete.");
    const data = Buffer.concat(entry.chunks, entry.size);
    if (createHash("sha256").update(data).digest("hex") !== entry.hash) {
      this.entries.delete(id); throw new ConsoleError(400, "UPLOAD_HASH", "Upload checksum did not match.");
    }
    entry.committing = this.save(root, entry.name, data).then(result => { entry.result = result; entry.chunks = []; return result; });
    try { return await entry.committing; } finally { entry.committing = undefined; }
  }
}
