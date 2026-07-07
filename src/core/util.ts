import { createHash } from "node:crypto";

/** Sanitize a title into a safe filename, Obsidian-style (keeps spaces and case). */
export function safeFilename(title: string): string {
  return title
    .replace(/[\\/:*?"<>|#^[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/** Local date as YYYY-MM-DD. */
export function todayISO(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Local timestamp as YYYY-MM-DD HH:mm. */
export function nowStamp(now: Date = new Date()): string {
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  return `${todayISO(now)} ${hh}:${mm}`;
}

export function shortHash(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 8);
}

/** Normalize a path to posix separators. */
export function toPosix(p: string): string {
  return p.split("\\").join("/");
}

/** Case-insensitive key for matching titles/aliases/filenames. */
export function nameKey(s: string): string {
  return s.trim().toLowerCase();
}

/** First ~n chars of prose: strips headings, links syntax, emphasis. */
export function makeExcerpt(body: string, n = 200): string {
  const prose = body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^#+\s.*$/gm, " ")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, t, a) => a ?? t)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return prose.length > n ? `${prose.slice(0, n - 1)}…` : prose;
}

/** Strip fenced code blocks and inline code so regexes don't match inside them. */
export function stripCode(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/`[^`\n]*`/g, " ");
}

export function uniq<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

export function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string" && v.trim() !== "") return [v];
  return [];
}
