import path from "node:path";

const TYPES: Record<string, string> = {
  ".txt": "text/plain", ".log": "text/plain", ".md": "text/markdown", ".markdown": "text/markdown",
  ".json": "application/json", ".jsonl": "application/json", ".xml": "application/xml", ".yaml": "text/yaml", ".yml": "text/yaml",
  ".csv": "text/csv", ".tsv": "text/tab-separated-values", ".rtf": "text/rtf", ".tex": "text/x-tex", ".graphql": "text/graphql", ".html": "text/html", ".htm": "text/html", ".css": "text/css",
  ".js": "text/javascript", ".mjs": "text/javascript", ".cjs": "text/javascript", ".ts": "text/typescript", ".tsx": "text/typescript",
  ".jsx": "text/javascript", ".vue": "text/plain", ".py": "text/x-python", ".java": "text/x-java-source", ".go": "text/x-go",
  ".rs": "text/x-rust", ".sql": "text/x-sql", ".sh": "text/x-shellscript", ".bat": "text/plain", ".ps1": "text/plain",
  ".ini": "text/plain", ".conf": "text/plain", ".toml": "text/plain", ".env": "text/plain",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp", ".avif": "image/avif", ".tif": "image/tiff", ".tiff": "image/tiff",
  ".pdf": "application/pdf", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation", ".odt": "application/vnd.oasis.opendocument.text", ".zip": "application/zip", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".m4a": "audio/mp4",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime"
};
export function contentType(name: string): string {
  return TYPES[path.extname(name).toLowerCase()] || "application/octet-stream";
}
export function isTextType(type: string): boolean { return type.startsWith("text/") || type === "application/json" || type === "application/xml"; }
export function isImageType(type: string): boolean { return type.startsWith("image/") && ["image/png","image/jpeg","image/webp","image/gif","image/avif","image/tiff"].includes(type); }
export function isMediaType(type: string): boolean { return type.startsWith("audio/") || type.startsWith("video/"); }
