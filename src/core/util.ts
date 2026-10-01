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

/** True for a YYYY-MM-DD string naming a real calendar day (rejects 2026-02-30). */
export function isCalendarDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(0);
  // setUTCFullYear, unlike Date.UTC, doesn't remap years 0–99 to 1900–1999.
  date.setUTCFullYear(y, mo - 1, d);
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
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
