// Convert Claude's Markdown-ish output into WhatsApp formatting and split long
// messages so nothing gets truncated.

export function mdToWhatsApp(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inFence = false;
  for (let line of lines) {
    if (line.trim().startsWith("```")) {
      inFence = !inFence;
      out.push("```");
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    // headers -> bold
    const h = line.match(/^\s{0,3}#{1,6}\s+(.*)$/);
    if (h) line = `*${h[1].trim()}*`;
    // bold **x** / __x__ -> *x*
    line = line.replace(/\*\*(.+?)\*\*/g, "*$1*").replace(/__(.+?)__/g, "*$1*");
    // bullets
    line = line.replace(/^(\s*)[-*]\s+/, "$1• ");
    // links [text](url) -> text (url)
    line = line.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1 ($2)");
    // horizontal rules
    if (/^\s*([-*_]\s*){3,}$/.test(line)) line = "―――";
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function splitMessage(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = max;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts.map((p, i) => (parts.length > 1 ? `(${i + 1}/${parts.length})\n${p}` : p));
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

const MIME_EXT: Record<string, string> = {
  "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif",
  "video/mp4": ".mp4", "audio/ogg": ".ogg", "audio/mpeg": ".mp3", "audio/mp4": ".m4a",
  "application/pdf": ".pdf", "application/zip": ".zip", "application/json": ".json",
  "text/plain": ".txt", "text/csv": ".csv",
};

/** Safe, unique-ish local file name for an inbound WhatsApp attachment:
 *  `<UTC stamp>-<sanitised original name>`; an extension is derived from the
 *  mime type when the original name has none. */
export function attachmentFileName(name: string | null | undefined, mime: string | null | undefined, date: Date): string {
  const stamp = date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  let base = (name ?? "").split(/[\\/]/).pop() ?? "";
  base = base.replace(/[^\w.-]+/g, "_").replace(/^[_.]+|_+$/g, "");
  if (!base) base = "attachment";
  if (!/\.[A-Za-z0-9]{1,8}$/.test(base)) {
    const ext = MIME_EXT[(mime ?? "").split(";")[0].trim().toLowerCase()];
    if (ext) base += ext;
  }
  return `${stamp}-${base}`;
}
