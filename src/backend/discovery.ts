import { promises as fs } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import { CodexRpcClient } from "./transport";

const execFileAsync = promisify(execFile);
const CODEX_PROCESS = /(?:^|[\\/ ])(?:codex|chatgpt|openai)(?:$|[\\/ ]|-)/i;
const MAX_SCAN_ENTRIES = 1200;
const MAX_CANDIDATES = 24;
const MAX_ERROR = 240;

export interface DiscoveredCodexEndpoint {
  type: "unix" | "websocket";
  endpoint: string;
  source: "explicit-env" | "runtime-socket" | "socket-owner" | "process-args" | "loopback-listener";
  verified: boolean;
  serverInfo?: string;
  error?: string;
}
export interface DiscoveryOptions {
  roots?: string[];
  ssOutput?: string;
  maxCandidates?: number;
  probe?: (candidate: { type: "unix" | "websocket"; endpoint: string }) => Promise<string>;
}

function shortError(error: unknown): string {
  return String(error instanceof Error ? error.message : error || "Probe failed.").slice(
    0,
    MAX_ERROR
  );
}
function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}
function validWebSocket(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return (
      ["ws:", "wss:"].includes(url.protocol) &&
      isLoopbackHost(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}
function validUnix(endpoint: string): boolean {
  return endpoint.startsWith("/") && !endpoint.includes("\0");
}
async function ownedByCurrentUser(target: string): Promise<boolean> {
  if (typeof process.getuid !== "function") return true;
  try {
    return (await fs.stat(target)).uid === process.getuid();
  } catch {
    return false;
  }
}
async function processOwnedByCurrentUser(pid: string): Promise<boolean> {
  if (typeof process.getuid !== "function") return true;
  try {
    const status = await fs.readFile(`/proc/${pid}/status`, "utf8");
    return status.match(/^Uid:\s+(\d+)/m)?.[1] === String(process.getuid());
  } catch {
    return false;
  }
}
function addCandidate(
  map: Map<string, DiscoveredCodexEndpoint>,
  candidate: DiscoveredCodexEndpoint
): void {
  if (
    candidate.type === "unix" ? !validUnix(candidate.endpoint) : !validWebSocket(candidate.endpoint)
  )
    return;
  const key = `${candidate.type}:${candidate.endpoint}`;
  if (!map.has(key)) map.set(key, candidate);
}
async function walkSocketRoots(
  roots: string[],
  map: Map<string, DiscoveredCodexEndpoint>
): Promise<void> {
  let inspected = 0;
  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > 4 || inspected >= MAX_SCAN_ENTRIES) return;
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (inspected++ >= MAX_SCAN_ENTRIES) return;
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isSocket() && /codex|chatgpt|openai|app[-_.]?server/i.test(entry.name)) {
        if (await ownedByCurrentUser(full))
          addCandidate(map, {
            type: "unix",
            endpoint: full,
            source: "runtime-socket",
            verified: false
          });
      } else if (entry.isDirectory()) await walk(full, depth + 1);
    }
  }
  for (const root of roots) await walk(root, 0);
}
function parseSs(output: string, map: Map<string, DiscoveredCodexEndpoint>): void {
  const unix = /u_str\s+LISTEN\s+\S+\s+\S+\s+(\/\S+)\s+\S+\s+\S+\s+\S+\s+users:\(\(\"([^\"]+)\"/gi;
  let match: RegExpExecArray | null;
  while ((match = unix.exec(output)))
    if (CODEX_PROCESS.test(match[2]))
      addCandidate(map, {
        type: "unix",
        endpoint: match[1],
        source: "socket-owner",
        verified: false
      });
  const tcp =
    /tcp\s+LISTEN\s+\S+\s+\S+\s+(127\.0\.0\.1|\[::1\]):(\d+)\s+\S+.*?users:\(\(\"([^\"]+)\"/gi;
  while ((match = tcp.exec(output)))
    if (CODEX_PROCESS.test(match[3]))
      addCandidate(map, {
        type: "websocket",
        endpoint: `ws://${match[1] === "[::1]" ? "[::1]" : match[1]}:${match[2]}`,
        source: "loopback-listener",
        verified: false
      });
}
async function scanProcessArgs(map: Map<string, DiscoveredCodexEndpoint>): Promise<void> {
  if (process.platform !== "linux") return;
  let entries: string[];
  try {
    entries = await fs.readdir("/proc");
  } catch {
    return;
  }
  for (const pid of entries.filter((value) => /^\d+$/.test(value)).slice(0, MAX_SCAN_ENTRIES)) {
    if (!(await processOwnedByCurrentUser(pid))) continue;
    let args: string;
    try {
      args = (await fs.readFile(`/proc/${pid}/cmdline`)).toString("utf8").split("\0").join(" ");
    } catch {
      continue;
    }
    if (!CODEX_PROCESS.test(args)) continue;
    const listen = args.match(
      /--listen\s+(unix:\/\/[^\s]+|wss?:\/\/127\.0\.0\.1:\d+|wss?:\/\/\[::1\]:\d+)/i
    )?.[1];
    if (!listen) continue;
    if (listen.startsWith("unix://"))
      addCandidate(map, {
        type: "unix",
        endpoint: listen.slice("unix://".length),
        source: "process-args",
        verified: false
      });
    else
      addCandidate(map, {
        type: "websocket",
        endpoint: listen,
        source: "process-args",
        verified: false
      });
  }
}
async function defaultSsOutput(): Promise<string> {
  const outputs: string[] = [];
  for (const args of [["-lxnp"], ["-ltnp"]]) {
    try {
      outputs.push(
        (await execFileAsync("ss", args, { timeout: 2000, maxBuffer: 1024 * 1024 })).stdout
      );
    } catch {
      // Discovery degrades to runtime directories and process arguments.
    }
  }
  return outputs.join("\n");
}
async function probeCandidate(candidate: {
  type: "unix" | "websocket";
  endpoint: string;
}): Promise<string> {
  const peer = new CodexRpcClient({
    type: candidate.type,
    endpoint: candidate.endpoint,
    connectTimeoutMs: 1200,
    requestTimeoutMs: 1500,
    maxFrameBytes: 512 * 1024
  });
  try {
    await peer.connect();
    const info = peer.serverInfo as any;
    return String(info?.userAgent || info?.serverInfo || info?.name || "Codex app-server").slice(
      0,
      160
    );
  } finally {
    peer.close();
  }
}

/** Discover only local endpoints of an already-running Codex service. Never starts a process. */
export async function discoverExistingCodex(
  options: DiscoveryOptions = {}
): Promise<DiscoveredCodexEndpoint[]> {
  const map = new Map<string, DiscoveredCodexEndpoint>();
  const explicit = process.env.CODEX_EXISTING_ENDPOINT || "";
  if (explicit.startsWith("/") || validWebSocket(explicit))
    addCandidate(map, {
      type: explicit.startsWith("/") ? "unix" : "websocket",
      endpoint: explicit,
      source: "explicit-env",
      verified: false
    });
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const roots =
    options.roots ||
    [
      process.env.XDG_RUNTIME_DIR,
      uid === undefined ? undefined : `/run/user/${uid}`,
      "/tmp"
    ].filter((value): value is string => Boolean(value));
  await walkSocketRoots(roots, map);
  parseSs(options.ssOutput === undefined ? await defaultSsOutput() : options.ssOutput, map);
  await scanProcessArgs(map);
  const candidates = [...map.values()].slice(0, options.maxCandidates || MAX_CANDIDATES);
  const probe = options.probe || probeCandidate;
  for (const candidate of candidates) {
    try {
      candidate.serverInfo = await probe(candidate);
      candidate.verified = true;
    } catch (error) {
      candidate.error = shortError(error);
    }
  }
  return candidates;
}
