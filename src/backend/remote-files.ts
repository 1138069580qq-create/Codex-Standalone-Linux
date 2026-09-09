import https from "node:https";
import dns from "node:dns";
import { isIP } from "node:net";
import { ConsoleError } from "./config";
import { uploadProjectBuffer, MAX_UPLOAD_BYTES } from "./files";
import { readBounded } from "./transfers";

// Deliberately IPv4-only: reject special-use space, private networks and IPv6 translation tricks.
export function publicAddress(ip: string): boolean {
  if (isIP(ip) !== 4) return false;
  const [a,b,c] = ip.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || b === 2 || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
}
export function allowedUrl(value: string, hosts: string[]): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new ConsoleError(400, "INVALID_URL", "A valid HTTPS URL is required."); }
  if (value.length > 4096 || url.protocol !== "https:" || url.username || url.password || url.hash ||
      (url.port && url.port !== "443") || !hosts.includes(url.hostname) || isIP(url.hostname) || url.hostname.endsWith("."))
    throw new ConsoleError(403, "DOWNLOAD_HOST", "This HTTPS host is not allowed for the project.");
  return url;
}
export interface RemoteResponse { data: Buffer; status: number; location?: string; }
export type Request = (url: URL, options?: { method?: string; headers?: Record<string,string>; body?: string; limit?: number }) => Promise<RemoteResponse>;
export const requestPublic: Request = async (url, options = {}) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const addresses = await Promise.race([dns.promises.lookup(url.hostname, { family: 4, all: true }), new Promise<never>((_,reject) => {
      timer = setTimeout(() => reject(new ConsoleError(504, "DNS_TIMEOUT", "Download DNS lookup timed out.")), 3000);
    })]);
    if (!addresses.length || addresses.some((a: { address: string }) => !publicAddress(a.address))) throw new ConsoleError(403, "PRIVATE_ADDRESS", "Non-public download addresses are blocked.");
    const pinned = addresses[0].address;
    return await new Promise<RemoteResponse>((resolve,reject) => {
      const req = https.request(url, {
        method: options.method || "GET", agent: false,
        // Pin the validated address; TLS still validates the original hostname.
        lookup: ((_host: string, opts: any, cb: any) => opts?.all ? cb(null, [{ address: pinned, family: 4 }]) : cb(null, pinned, 4)) as any,
        headers: { "User-Agent": "Codex-Standalone-WebUI", "Accept-Encoding": "identity", ...options.headers }
      }, async res => {
        try {
          const data = await readBounded(res, options.limit ?? MAX_UPLOAD_BYTES, 15000);
          resolve({ data, status: res.statusCode || 502, ...(res.headers.location ? { location: res.headers.location } : {}) });
        } catch (error) { req.destroy(); reject(error); }
      });
      const deadline = setTimeout(() => req.destroy(new ConsoleError(504, "DOWNLOAD_TIMEOUT", "Download timed out.")), 18000);
      req.once("close", () => clearTimeout(deadline)); req.once("error", reject);
      req.end(options.body);
    });
  } finally { if (timer) clearTimeout(timer); }
};
export async function downloadExternal(root: string, name: string, source: string, hosts: string[], request = requestPublic) {
  let url = allowedUrl(source, hosts);
  for (let hop = 0; hop < 4; hop++) {
    const response = await request(url);
    if ([301,302,303,307,308].includes(response.status) && response.location) {
      url = allowedUrl(new URL(response.location, url).href, hosts); continue;
    }
    if (response.status !== 200) throw new ConsoleError(502, "DOWNLOAD_FAILED", "The upstream download failed.");
    return uploadProjectBuffer(root, name, response.data);
  }
  throw new ConsoleError(502, "DOWNLOAD_REDIRECTS", "Too many download redirects.");
}
