import {textPrefix} from "./text";
import {fileReference,generatedImageReference,markdownLinks} from "./artifacts";

export interface TimelineItem {
  id: string;
  type: string;
  role?: "user" | "assistant";
  phase?: "commentary" | "final_answer";
  text: string;
  status?: string;
  turnId?: string;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  images?: Array<{ path?: string; src?: string; generated?: string; alt?: string; source?: string }>;
  files?: Array<{ path: string; kind?: string; source?: string; label?: string }>;
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
  const relative=fileReference(value,root);
  if(relative&&/\.(?:png|jpe?g|webp|gif|avif|tiff?)$/i.test(relative))return {path:relative};
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
  const images: NonNullable<TimelineItem['images']> = [],files: NonNullable<TimelineItem['files']> = [];
  const generation=['imageGeneration','imageGenerationCall'].includes(type);
  const addImage = (value: unknown, alt?: string, source?: string) => {
    const local=imageReference(value,root),generated=generation?generatedImageReference(value):undefined;
    const image=local??(generated?{generated}:undefined);
    if(image&&images.length<8&&!images.some(i=>JSON.stringify([i.path,i.src,i.generated])===JSON.stringify([(image as any).path,(image as any).src,(image as any).generated])))
      images.push({...image,...(alt?{alt:alt.slice(0,160)}:{}),...(source?{source}:{})});
  };
  if(generation||type==='imageView'){
    for(const key of ['savedPath','saved_path','path','outputPath','imagePath','url'])addImage(item[key]);
    // Some protocol versions return a path in result. Never forward base64 image data.
    if(typeof item.result==='string'&&item.result.length<4096)addImage(item.result);
  }
  for(const c of Array.isArray(item.content)?item.content.slice(0,30):[])
    if(['image','localImage','image_url','output_image','inputImage'].includes(c?.type))addImage(c.path??c.url??c.imageUrl??c.image_url?.url);
  if(type==='agentMessage')for(const link of markdownLinks(text)){
    if(link.image)addImage(link.source,link.label,link.source);
    else {const file=fileReference(link.source,root);if(file&&!files.some(f=>f.path===file))files.push({path:file,source:link.source,label:link.label.slice(0,160)});}
  }
  if(type==='fileChange')for(const change of Array.isArray(item.changes)?item.changes.slice(0,100):[]){const file=fileReference(change.path,root);if(file)files.push({path:file,kind:typeof change.kind==='string'?change.kind:change.kind?.type});}
  const epoch=(v:unknown)=>typeof v==="number"&&Number.isFinite(v)&&v>=0?(v<1e12?v*1000:v):undefined;
  const startedAt=epoch(item.startedAt),finishedAt=epoch(item.completedAt??item.finishedAt);
  const truncated = !!item.truncated || text.length > MAX_ITEM_CHARS;
  return {
    id: String(item.id),
    type,
    ...(turnId ? { turnId } : {}),
    ...(type==='agentMessage'&&['commentary','final_answer'].includes(item.phase)?{phase:item.phase}:{}),
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
    ...(files.length?{files}:{}),
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
