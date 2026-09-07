export interface TimelineItem {
  id: string;
  type: string;
  role?: "user" | "assistant";
  text: string;
  status?: string;
  files?: Array<{ path: string; kind?: string }>;
  truncated?: boolean;
}
export const MAX_ITEM_CHARS = 64 * 1024;
export function normalizeItem(item: any): TimelineItem {
  const type = String(item?.type || "other");
  let text = "";
  if (type === "userMessage")
    text = (item.content || [])
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
  const truncated = text.length > MAX_ITEM_CHARS;
  return {
    id: String(item.id),
    type,
    ...(type === "userMessage"
      ? { role: "user" as const }
      : type === "agentMessage"
        ? { role: "assistant" as const }
        : {}),
    text: text.slice(0, MAX_ITEM_CHARS),
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
