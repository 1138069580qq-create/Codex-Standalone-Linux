import path from "node:path";
import os from "node:os";
export function settings(env = process.env) {
  const host = env.CODEX_WEBUI_HOST || "127.0.0.1";
  const port = Number(env.CODEX_WEBUI_PORT || 3210);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid CODEX_WEBUI_PORT");
  const dataDir = path.resolve(env.CODEX_WEBUI_DATA || path.join(os.homedir(), ".local/share/codex-webui"));
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(host);
  if (!loopback && !env.CODEX_WEBUI_ORIGIN) throw new Error("Non-loopback binding requires CODEX_WEBUI_ORIGIN=https://your-host");
  const origin = env.CODEX_WEBUI_ORIGIN || `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
  const url = new URL(origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.username || url.password || (!loopback && url.protocol !== 'https:'))
    throw new Error("CODEX_WEBUI_ORIGIN must be an exact origin; public binding requires HTTPS.");
  if (url.protocol === 'http:' && !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) throw new Error("Remote origins require HTTPS.");
  return { host, port, dataDir, origin, secureCookies: url.protocol === "https:" };
}
