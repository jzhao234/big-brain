import path from "node:path";
import matter from "gray-matter";
import type { Heading, Note, NoteLink, TaskItem } from "./types.js";
import {
  asStringArray,
  makeExcerpt,
  nameKey,
  shortHash,
  stripCode,
  toPosix,
  uniq,
} from "./util.js";

const WIKILINK_RE = /\[\[([^\]|#\n]+)(?:#([^\]|\n]+))?(?:\|([^\]\n]+))?\]\]/g;
const TAG_RE = /(^|[\s(])#([A-Za-z][\w/-]*)/g;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const TASK_RE = /^\s*[-*] \[([ xX/\-])\]\s+(.*)$/;

const DUE_RE = /📅\s*(\d{4}-\d{2}-\d{2})/u;
const SCHEDULED_RE = /⏳\s*(\d{4}-\d{2}-\d{2})/u;
const DONE_RE = /✅\s*(\d{4}-\d{2}-\d{2})/u;
const PRIO_HIGH_RE = /⏫/u;
const PRIO_LOW_RE = /🔽/u;

export function extractLinks(body: string): NoteLink[] {
  const clean = stripCode(body);
  const links: NoteLink[] = [];
  for (const m of clean.matchAll(WIKILINK_RE)) {
    links.push({
      target: m[1]!.trim(),
      heading: m[2]?.trim(),
      alias: m[3]?.trim(),
      raw: m[0],
    });
  }
  return links;
}

export function extractInlineTags(body: string): string[] {
  const clean = stripCode(body);
  const tags: string[] = [];
  for (const m of clean.matchAll(TAG_RE)) tags.push(m[2]!.toLowerCase());
  return uniq(tags);
}

export function extractHeadings(body: string): Heading[] {
  const headings: Heading[] = [];
  const lines = stripCode(body).split("\n");
  lines.forEach((line, i) => {
    const m = HEADING_RE.exec(line);
    if (m) headings.push({ depth: m[1]!.length, text: m[2]!.trim(), line: i });
  });
  return headings;
}

/** Strip emoji metadata from a task line's text. */
function cleanTaskText(text: string): string {
  return text
    .replace(DUE_RE, "")
    .replace(SCHEDULED_RE, "")
    .replace(DONE_RE, "")
    .replace(PRIO_HIGH_RE, "")
    .replace(PRIO_LOW_RE, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractTasks(
  raw: string,
  file: string,
  noteTitle: string,
  noteType: string,
): TaskItem[] {
  const tasks: TaskItem[] = [];
  const seen = new Map<string, number>();
  const lines = raw.split("\n");
  let inFence = false;
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const m = TASK_RE.exec(line);
    if (!m) return;
    const status = m[1]!;
    const rest = m[2]!;
    const text = cleanTaskText(rest);
    if (text === "") return;
    // Stable id: file + normalized text (+ counter for duplicates within the file).
    const base = `${file}:${nameKey(text)}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    const id = shortHash(n === 0 ? base : `${base}:${n}`);
    const tags: string[] = [];
    for (const tm of rest.matchAll(TAG_RE)) tags.push(tm[2]!.toLowerCase());
    tasks.push({
      id,
      text,
      raw: line,
      done: status.toLowerCase() === "x",
      file,
      line: i,
      due: DUE_RE.exec(rest)?.[1],
      scheduled: SCHEDULED_RE.exec(rest)?.[1],
      completedOn: DONE_RE.exec(rest)?.[1],
      priority: PRIO_HIGH_RE.test(rest) ? "high" : PRIO_LOW_RE.test(rest) ? "low" : undefined,
      tags: uniq(tags),
      noteTitle,
      noteType,
    });
  });
  return tasks;
}

/** Infer a note's type from frontmatter, falling back to its top-level folder. */
export function inferType(
  fm: Record<string, unknown>,
  relPath: string,
  folderTypes: Record<string, string>,
): string {
  if (typeof fm.type === "string" && fm.type.trim() !== "") return fm.type.trim();
  const top = relPath.split("/")[0] ?? "";
  return folderTypes[top] ?? "note";
}

export interface ParseInput {
  relPath: string;
  absPath: string;
  raw: string;
  mtimeMs: number;
  /** Map of top-level folder name -> note type (from config). */
  folderTypes: Record<string, string>;
  archiveFolder: string;
}

export function parseNote(input: ParseInput): Note {
  const { relPath, absPath, raw, mtimeMs, folderTypes, archiveFolder } = input;
  let fm: Record<string, unknown> = {};
  let body = raw;
  try {
    const parsed = matter(raw);
    fm = parsed.data ?? {};
    body = parsed.content;
  } catch {
    // Malformed frontmatter: treat the whole file as body rather than crashing the vault.
    fm = {};
    body = raw;
  }

  const stem = path.basename(relPath, ".md");
  const headings = extractHeadings(body);
  const h1 = headings.find((h) => h.depth === 1)?.text;
  const title =
    typeof fm.title === "string" && fm.title.trim() !== "" ? fm.title.trim() : (h1 ?? stem);
  const type = inferType(fm, relPath, folderTypes);
  const fmTags = asStringArray(fm.tags).map((t) => t.replace(/^#/, "").toLowerCase());
  const tags = uniq([...fmTags, ...extractInlineTags(body)]);
  const posixPath = toPosix(relPath);

  return {
    path: posixPath,
    absPath,
    title,
    type,
    frontmatter: fm,
    tags,
    aliases: asStringArray(fm.aliases),
    links: extractLinks(body),
    tasks: extractTasks(raw, posixPath, title, type),
    headings,
    body,
    raw,
    mtimeMs,
    archived: posixPath === archiveFolder || posixPath.startsWith(`${archiveFolder}/`),
    excerpt: makeExcerpt(body),
  };
}
