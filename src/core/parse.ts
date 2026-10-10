import path from "node:path";
import { frontmatterEnd, parseFrontmatter } from "./frontmatter.js";
import type { Heading, Note, NoteLink, TaskItem } from "./types.js";
import {
  asStringArray,
  fencedLines,
  makeExcerpt,
  nameKey,
  shortHash,
  stripCode,
  toLF,
  toPosix,
  uniq,
} from "./util.js";

const WIKILINK_RE = /\[\[([^\]|#\n]+)(?:#([^\]|\n]+))?(?:\|([^\]\n]+))?\]\]/g;
const TAG_RE = /(^|[\s(])#([A-Za-z][\w/-]*)/g;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const TASK_RE = /^\s*[-*] \[([ xX/\-])\]\s+(.*)$/;

// Each marker may carry a VS16 (U+FE0F) emoji-presentation selector.
const DUE_RE = /📅\uFE0F?\s*(\d{4}-\d{2}-\d{2})/u;
const SCHEDULED_RE = /⏳\uFE0F?\s*(\d{4}-\d{2}-\d{2})/u;
const DONE_RE = /✅\uFE0F?\s*(\d{4}-\d{2}-\d{2})/u;
const PRIO_HIGH_RE = /⏫\uFE0F?/u;
const PRIO_LOW_RE = /🔽\uFE0F?/u;

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

/**
 * Checkbox tasks in `text`, skipping fenced code. `lineOffset` is the line of
 * the file where `text` starts, so each task's `line` indexes the whole file.
 */
export function extractTasks(
  text: string,
  file: string,
  noteTitle: string,
  noteType: string,
  lineOffset = 0,
): TaskItem[] {
  const tasks: TaskItem[] = [];
  const seen = new Map<string, number>();
  const lines = text.split("\n");
  const fenced = fencedLines(lines);
  lines.forEach((line, i) => {
    if (fenced[i]) return;
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
      cancelled: status === "-",
      file,
      line: lineOffset + i,
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
  // Parse an LF view so CRLF files (Windows editors, git autocrlf) yield the
  // same tasks and headings. Only \r\n is folded, so line indices still match
  // raw.split("\n"); `raw` itself stays byte-for-byte what is on disk.
  const text = toLF(raw);
  let fm: Record<string, unknown> = {};
  let body = text;
  let frontmatterError: string | undefined;
  try {
    const parsed = parseFrontmatter(text);
    fm = parsed.data;
    body = parsed.content;
  } catch (err) {
    // Malformed frontmatter: keep the vault readable, keep the block out of the
    // body (so its lines aren't read as tasks or headings), and record why, so
    // writes that would re-serialize the frontmatter can refuse instead of dropping it.
    frontmatterError = err instanceof Error ? err.message : String(err);
    body = text.slice(frontmatterEnd(text) ?? 0);
  }
  // The body is always a suffix of `text`: its line i is line bodyLine + i of the file.
  const bodyLine = text.slice(0, text.length - body.length).split("\n").length - 1;

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
    tasks: extractTasks(body, posixPath, title, type, bodyLine),
    headings,
    body,
    bodyLine,
    ...(frontmatterError !== undefined ? { frontmatterError } : {}),
    raw,
    mtimeMs,
    archived: posixPath === archiveFolder || posixPath.startsWith(`${archiveFolder}/`),
    excerpt: makeExcerpt(body),
  };
}
