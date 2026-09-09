/** UTF-16 offsets stay compatible with Codex/SSE, but bounded text never cuts a surrogate pair. */
export function textPrefix(text: string, max: number): string {
  let end = Math.max(0, Math.min(text.length, max));
  if (end < text.length && end > 0 && /[\uD800-\uDBFF]/.test(text[end-1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
  return text.slice(0, end);
}
