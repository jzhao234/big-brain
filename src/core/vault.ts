import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import matter from "gray-matter";
import { folderTypeMap, loadConfig } from "./config.js";
import { parseNote } from "./parse.js";
import { SearchIndex } from "./search.js";
import type { BrainConfig, Note, NoteLink, SearchOptions, SearchResult } from "./types.js";
import { nameKey, safeFilename, toPosix, todayISO } from "./util.js";

export interface CreateNoteInput {
  title: string;
  /** Note type; also decides the default folder. */
  type?: string;
  /** Explicit vault-relative folder, overrides the type default. */
  folder?: string;
  tags?: string[];
  body?: string;
  frontmatter?: Record<string, unknown>;
  /** Overwrite if a note with this path already exists (default false). */
  overwrite?: boolean;
}

export class Vault {
  readonly dir: string;
  readonly config: BrainConfig;
  private notesByPath = new Map<string, Note>();
  private index = new SearchIndex();
  private folderTypes: Record<string, string>;

  constructor(dir: string) {
    this.dir = path.resolve(dir);
    this.config = loadConfig(this.dir);
    this.folderTypes = folderTypeMap(this.config);
    this.refresh();
  }

  /** Rescan the vault, reparsing only files whose mtime changed. */
  refresh(): void {
    const files = fg.sync("**/*.md", {
      cwd: this.dir,
      ignore: [
        "node_modules/**",
        ".git/**",
        ".obsidian/**",
        ".trash/**",
        `${this.config.folders.templates}/**`,
        ...this.config.ignore,
      ],
      dot: false,
    });
    const seen = new Set<string>();
    for (const rel of files) {
      const posix = toPosix(rel);
      seen.add(posix);
      const abs = path.join(this.dir, rel);
      let mtimeMs: number;
      try {
        mtimeMs = fs.statSync(abs).mtimeMs;
      } catch {
        continue; // deleted between glob and stat
      }
      const existing = this.notesByPath.get(posix);
      if (existing && existing.mtimeMs === mtimeMs) continue;
      const raw = fs.readFileSync(abs, "utf8");
      this.notesByPath.set(
        posix,
        parseNote({
          relPath: posix,
          absPath: abs,
          raw,
          mtimeMs,
          folderTypes: this.folderTypes,
          archiveFolder: this.config.folders.archive,
        }),
      );
    }
    for (const p of [...this.notesByPath.keys()]) {
      if (!seen.has(p)) this.notesByPath.delete(p);
    }
    this.index.sync(this.notesByPath);
  }

  /** All notes, optionally including archived ones. */
  notes(includeArchived = false): Note[] {
    const all = [...this.notesByPath.values()];
    return includeArchived ? all : all.filter((n) => !n.archived);
  }

  /**
   * Resolve a reference to a note: exact vault-relative path, then title,
   * alias, or filename stem (case-insensitive). Returns undefined if absent;
   * ambiguous name matches prefer non-archived, then shortest path.
   */
  get(ref: string): Note | undefined {
    const cleaned = toPosix(ref.trim()).replace(/^\.\//, "");
    const byPath =
      this.notesByPath.get(cleaned) ?? this.notesByPath.get(`${cleaned.replace(/\.md$/, "")}.md`);
    if (byPath) return byPath;
    const key = nameKey(cleaned.replace(/\.md$/, ""));
    const candidates: Note[] = [];
    for (const note of this.notesByPath.values()) {
      const stem = path.basename(note.path, ".md");
      if (
        nameKey(note.title) === key ||
        nameKey(stem) === key ||
        note.aliases.some((a) => nameKey(a) === key)
      ) {
        candidates.push(note);
      }
    }
    candidates.sort(
      (a, b) => Number(a.archived) - Number(b.archived) || a.path.length - b.path.length,
    );
    return candidates[0];
  }

  /** Resolve a wikilink target to a note, if it exists. */
  resolveLink(link: NoteLink | string): Note | undefined {
    return this.get(typeof link === "string" ? link : link.target);
  }

  /** Notes that link to the given note. */
  backlinks(ref: string): Note[] {
    const target = this.get(ref);
    if (!target) return [];
    const result: Note[] = [];
    for (const note of this.notesByPath.values()) {
      if (note.path === target.path) continue;
      if (note.links.some((l) => this.resolveLink(l)?.path === target.path)) result.push(note);
    }
    return result;
  }

  search(query: string, opts: SearchOptions = {}): SearchResult[] {
    return this.index.search(query, this.notesByPath, opts);
  }

  /** All tags with usage counts, most-used first. */
  tags(): Array<{ tag: string; count: number }> {
    const counts = new Map<string, number>();
    for (const note of this.notes()) {
      for (const t of note.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  /** Default folder for a note type. */
  folderForType(type: string): string {
    const f = this.config.folders;
    const map: Record<string, string> = {
      note: f.notes,
      project: f.projects,
      area: f.areas,
      person: f.people,
      reference: f.reference,
      inbox: f.inbox,
      daily: f.daily,
    };
    return map[type] ?? f.notes;
  }

  createNote(input: CreateNoteInput): Note {
    const type = input.type ?? "note";
    const folder = input.folder
      ? toPosix(input.folder).replace(/^\/+|\/+$/g, "")
      : this.folderForType(type);
    const filename = `${safeFilename(input.title)}.md`;
    const rel = folder === "" ? filename : `${folder}/${filename}`;
    const abs = path.join(this.dir, rel);
    if (fs.existsSync(abs) && !input.overwrite) {
      throw new Error(`Note already exists: ${rel} (pass overwrite to replace it)`);
    }
    const fm: Record<string, unknown> = {
      type,
      created: todayISO(),
      ...(input.tags && input.tags.length > 0 ? { tags: input.tags } : {}),
      ...(input.frontmatter ?? {}),
    };
    const body = input.body ?? "";
    const content = matter.stringify(body === "" ? "" : `\n${body.replace(/^\n+/, "")}`, fm);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
    this.refresh();
    const note = this.notesByPath.get(rel);
    if (!note) throw new Error(`Failed to read back created note: ${rel}`);
    return note;
  }

  /**
   * Append markdown to a note. With `heading`, inserts at the end of that
   * section (before the next heading of the same or shallower depth);
   * otherwise appends to the end of the file.
   */
  appendToNote(ref: string, text: string, heading?: string): Note {
    const note = this.get(ref);
    if (!note) throw new Error(`Note not found: ${ref}`);
    const block = text.replace(/\s+$/, "");
    let raw = note.raw;
    if (heading) {
      const lines = raw.split("\n");
      const fmOffset = raw.startsWith("---") ? countFrontmatterLines(raw) : 0;
      const target = note.headings.find((h) => nameKey(h.text) === nameKey(heading));
      if (!target) {
        raw = `${raw.replace(/\s+$/, "")}\n\n## ${heading}\n\n${block}\n`;
      } else {
        const startLine = fmOffset + target.line;
        let endLine = lines.length;
        for (const h of note.headings) {
          if (h.line > target.line && h.depth <= target.depth) {
            endLine = fmOffset + h.line;
            break;
          }
        }
        // Trim trailing blank lines inside the section, insert, keep one blank line after.
        let insertAt = endLine;
        while (insertAt > startLine + 1 && (lines[insertAt - 1] ?? "").trim() === "") insertAt--;
        lines.splice(insertAt, 0, block);
        raw = lines.join("\n");
      }
    } else {
      raw = `${raw.replace(/\s+$/, "")}\n\n${block}\n`;
    }
    fs.writeFileSync(note.absPath, raw.endsWith("\n") ? raw : `${raw}\n`, "utf8");
    this.refresh();
    return this.notesByPath.get(note.path)!;
  }

  /** Merge keys into a note's frontmatter (set a key to null to delete it). */
  updateFrontmatter(ref: string, updates: Record<string, unknown>): Note {
    const note = this.get(ref);
    if (!note) throw new Error(`Note not found: ${ref}`);
    const fm = { ...note.frontmatter };
    for (const [k, v] of Object.entries(updates)) {
      if (v === null) delete fm[k];
      else fm[k] = v;
    }
    fs.writeFileSync(note.absPath, matter.stringify(note.body, fm), "utf8");
    this.refresh();
    return this.notesByPath.get(note.path)!;
  }

  /** Replace a note's body (frontmatter preserved). */
  replaceBody(ref: string, body: string): Note {
    const note = this.get(ref);
    if (!note) throw new Error(`Note not found: ${ref}`);
    fs.writeFileSync(
      note.absPath,
      matter.stringify(`\n${body.replace(/^\n+/, "")}`, note.frontmatter),
      "utf8",
    );
    this.refresh();
    return this.notesByPath.get(note.path)!;
  }

  /** Move a note into the archive folder (non-destructive delete). */
  archiveNote(ref: string): Note {
    const note = this.get(ref);
    if (!note) throw new Error(`Note not found: ${ref}`);
    if (note.archived) return note;
    const destRel = `${this.config.folders.archive}/${note.path}`;
    const destAbs = path.join(this.dir, destRel);
    fs.mkdirSync(path.dirname(destAbs), { recursive: true });
    if (fs.existsSync(destAbs)) {
      throw new Error(`Archive destination already exists: ${destRel}`);
    }
    fs.renameSync(note.absPath, destAbs);
    this.refresh();
    return this.notesByPath.get(toPosix(destRel))!;
  }

  /** Read a template file's content, if it exists. */
  template(name: string): string | undefined {
    const file = path.join(this.dir, this.config.folders.templates, `${name}.md`);
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
  }
}

function countFrontmatterLines(raw: string): number {
  const lines = raw.split("\n");
  if ((lines[0] ?? "").trim() !== "---") return 0;
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? "").trim() === "---") return i + 1;
  }
  return 0;
}
