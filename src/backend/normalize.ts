import path from "node:path";
import {textPrefix} from "./text";

export interface TimelineItem {
  id: string;
  type: string;
  role?: "user" | "assistant";
  text: string;
  status?: string;
  turnId?: string;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  images?: Array<{ path?: string; src?: string; alt?: string }>;
  files?: Array<{ path: string; kind?: string }>;
  truncated?: boolean;
}
export const MAX_ITEM_CHARS = 64 * 1024;
export interface TurnTiming {
  id: string;
  status: string;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
}
// Explicit protocol units: durationMs is milliseconds; startedAt/completedAt are Unix seconds.
export function turnTiming(turn: any, previous?: TurnTiming, now?: number): TurnTiming {
  const epoch = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v * 1000 : undefined;
  const startedAt = epoch(turn?.startedAt) ?? previous?.startedAt ?? (turn?.status === "inProgress" ? now : undefined);
  const finishedAt = epoch(turn?.completedAt) ?? (turn?.status !== "inProgress" ? previous?.finishedAt ?? now : undefined);
  const explicit = typeof turn?.durationMs === "number" && Number.isFinite(turn.durationMs) && turn.durationMs >= 0 ? turn.durationMs : undefined;
  return { id: String(turn?.id ?? previous?.id ?? ""), status: String(turn?.status ?? previous?.status ?? "unknown"),
    ...(startedAt !== undefined ? { startedAt } : {}), ...(finishedAt !== undefined ? { finishedAt } : {}),
    ...(explicit !== undefined ? { durationMs: explicit } : startedAt !== undefined && finishedAt !== undefined
      ? { durationMs: Math.max(0, finishedAt - startedAt) } : {}) };
}
export function imageReference(value: unknown, root?: string): { path?: string; src?: string } | undefined {
  if (typeof value !== "string" || !value || value.length > 4096 || /[\x00-\x1f]/.test(value)) return;
  if (/^https:\/\//i.test(value)) {
    try { const url = new URL(value); if (!url.username && !url.password) return { src: url.href }; } catch {}
    return;
  }
  let relative = value;
  if (path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    if (!root) return;
    const paths = /^[a-z]:/i.test(root) || root.startsWith("\\\\") ? path.win32 : path.posix;
    relative = paths.relative(root, value);
    if (paths.isAbsolute(relative)) return;
  }
  relative = relative.replace(/\\/g, "/");
  const parts = relative.split("/");
  if (parts.some(p => p === ".." || p.includes(":") || /^(?:\.git|\.ssh|\.codex|auth\.json)$/i.test(p) || /^\.env/i.test(p))) return;
  relative = parts.filter(p => p && p !== ".").join("/");
  if (relative && /\.(?:png|jpe?g|webp|gif|avif|tiff?)$/i.test(relative)) return { path: relative };
}
export function normalizeItem(item: any, root?: string, turnId?: string): TimelineItem {
  const type = String(item?.type || "other");
  let text = "";
  if (type === "userMessage")
    text = (Array.isArray(item.content) ? item.content : [])
      .map((c: any) =>
        c.type === "text"
          ? c.text
          : c.type === "image" || c.type === "localImage"
            ? "[attachment]"
            : ""
      )
      .filter(Boolean)
      .join("\n");
  else if (type === "agentMessage") text = String(item.text || "");
  else if (type === "commandExecution")
    text = [item.command, item.aggregatedOutput].filter(Boolean).join("\n");
  else if (type === "fileChange")
    text = (item.changes || [])
      .map(
        (c: any) => `${typeof c.kind === "string" ? c.kind : c.kind?.type || "update"} ${c.path}`
      )
      .join("\n");
  // Only explicit public summaries, never raw reasoning/encrypted reasoning data.
  else if (type === "reasoning")
    text = Array.isArray(item.summary)
      ? item.summary.filter((v: unknown) => typeof v === "string").join("\n")
      : "";
  else if (type === "plan") text = String(item.text || "");
  else text = typeof item?.text === "string" ? item.text : type;
  const images: Array<{ path?: string; src?: string; alt?: string }> = [];
  const addImage = (value: unknown, alt?: string) => {
    const image = imageReference(value, root);
    if (image && images.length < 8 && !images.some(i => i.path === image.path && i.src === image.src))
      images.push({ ...image, ...(alt ? { alt: alt.slice(0, 160) } : {}) });
  };
  if (type === "imageGeneration" || type === "imageGenerationCall" || type === "imageView") {
    for (const key of ["path", "outputPath", "imagePath", "url"]) addImage(item[key]);
  }
  for (const c of Array.isArray(item.content) ? item.content.slice(0, 30) : [])
    if (["image", "localImage", "image_url", "output_image"].includes(c?.type)) addImage(c.path ?? c.url ?? c.image_url?.url);
  // Never relay base64 image payloads or private reasoning as preview data.
  if (type === "agentMessage") for (const m of text.slice(0, MAX_ITEM_CHARS).matchAll(/!\[([^\]]*)\]\((?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\)/g)) addImage(m[2] || m[3], m[1]);
  const epoch=(v:unknown)=>typeof v==="number"&&Number.isFinite(v)&&v>=0?(v<1e12?v*1000:v):undefined;
  const startedAt=epoch(item.startedAt),finishedAt=epoch(item.completedAt??item.finishedAt);
  const truncated = !!item.truncated || text.length > MAX_ITEM_CHARS;
  return {
    id: String(item.id),
    type,
    ...(turnId ? { turnId } : {}),
    ...(startedAt!==undefined?{startedAt}:{}),...(finishedAt!==undefined?{finishedAt}:{}),
    ...(images.length ? { images } : {}),
    ...(typeof item.durationMs === "number" && Number.isFinite(item.durationMs) && item.durationMs >= 0 ? { durationMs: item.durationMs } : {}),
    ...(type === "userMessage"
      ? { role: "user" as const }
      : type === "agentMessage"
        ? { role: "assistant" as const }
        : {}),
    text: textPrefix(text, MAX_ITEM_CHARS),
    ...(typeof item.status === "string" ? { status: item.status } : {}),
    ...(type === "fileChange"
      ? {
          files: (item.changes || []).map((c: any) => ({
            path: String(c.path),
            kind: typeof c.kind === "string" ? c.kind : c.kind?.type
          }))
        }
      : {}),
    ...(truncated ? { truncated: true } : {})
  };
}
export function runtimeStatus(thread: any): string {
  const status = typeof thread?.status === "string" ? thread.status : thread?.status?.type;
  if (status === "active" || status === "inProgress") return "running";
  if (status === "systemError" || status === "failed") return "failed";
  return status || "idle";
}
export function threadTitle(thread: any): string {
  return String(thread.name || thread.preview || thread.id).slice(0, 120);
}
