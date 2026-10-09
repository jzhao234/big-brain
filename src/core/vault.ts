import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import { folderTypeMap, loadConfig } from "./config.js";
import { stringifyNote } from "./frontmatter.js";
import { autoCommit } from "./git.js";
import { parseNote } from "./parse.js";
import { SearchIndex } from "./search.js";
import type { BrainConfig, Note, NoteLink, SearchOptions, SearchResult } from "./types.js";
import { nameKey, safeFilename, toLF, toPosix, todayISO } from "./util.js";
import { atomicWriteFile, withNoteLock } from "./write.js";

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
  /**
   * On a filename collision, add a numeric suffix (`Title 2.md`) instead of
   * failing. Ignored when `overwrite` is set. Used by capture, which must
   * never lose a thought to a duplicate title.
   */
  unique?: boolean;
}

export class Vault {
  readonly dir: string;
  readonly config: BrainConfig;
  private notesByPath = new Map<string, Note>();
  /** name key (title, alias, filename stem) -> notes, best match first; rebuilt lazily. */
  private nameIndex: Map<string, Note[]> | undefined;
  /** Per-path stat signature used to decide whether a file needs reparsing. */
  private signatures = new Map<string, string>();
  private index = new SearchIndex();
  private folderTypes: Record<string, string>;

  constructor(dir: string) {
    this.dir = path.resolve(dir);
    this.config = loadConfig(this.dir);
    this.folderTypes = folderTypeMap(this.config);
    this.refresh();
  }

  /** Rescan the vault, reparsing only files whose stat signature changed. */
  refresh(): void {
    const files = fg.sync("**/*.md", {
      cwd: this.dir,
      ignore: [
        "node_modules/**",
        ".git/**",
        ".obsidian/**",
        ".trash/**",
        `${this.config.folders.templates}/**`,
        `${this.config.folders.agents}/**`,
        ...this.config.ignore,
      ],
      dot: false,
    });
    const seen = new Set<string>();
    for (const rel of files) {
      const posix = toPosix(rel);
      seen.add(posix);
      const abs = path.join(this.dir, rel);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue; // deleted between glob and stat
      }
      // mtime alone misses edits from tools that preserve it (rsync -t, some
      // sync clients); ctime can't be set from userland and size is free.
      const signature = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
      if (this.notesByPath.has(posix) && this.signatures.get(posix) === signature) continue;
      const raw = fs.readFileSync(abs, "utf8");
      this.nameIndex = undefined;
      this.notesByPath.set(
        posix,
        parseNote({
          relPath: posix,
          absPath: abs,
          raw,
          mtimeMs: stat.mtimeMs,
          folderTypes: this.folderTypes,
          archiveFolder: this.config.folders.archive,
        }),
      );
      this.signatures.set(posix, signature);
    }
    for (const p of [...this.notesByPath.keys()]) {
      if (!seen.has(p)) {
        this.notesByPath.delete(p);
        this.signatures.delete(p);
        this.nameIndex = undefined;
      }
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
    return this.names().get(nameKey(cleaned.replace(/\.md$/, "")))?.[0];
  }

  /**
   * Name lookup table. get() runs inside link-resolution loops (backlinks,
   * doctor, related), so a linear scan per call made those quadratic or worse.
   */
  private names(): Map<string, Note[]> {
    if (this.nameIndex) return this.nameIndex;
    const index = new Map<string, Note[]>();
    for (const note of this.notesByPath.values()) {
      const keys = new Set([
        nameKey(note.title),
        nameKey(path.basename(note.path, ".md")),
        ...note.aliases.map(nameKey),
      ]);
      for (const key of keys) index.set(key, [...(index.get(key) ?? []), note]);
    }
    // Ambiguous names prefer non-archived, then shortest path.
    for (const notes of index.values()) {
      notes.sort(
        (a, b) => Number(a.archived) - Number(b.archived) || a.path.length - b.path.length,
      );
    }
    this.nameIndex = index;
    return index;
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
    // Validate configured defaults too: brain.config.json is user-editable.
    const folder = this.vaultFolder(input.folder ?? this.folderForType(type));
    const stem = safeFilename(input.title);
    if (stem === "" || /^\.+$/.test(stem)) {
      throw new Error(`Note title has no usable filename characters: ${input.title}`);
    }
    const fm: Record<string, unknown> = {
      type,
      created: todayISO(),
      ...(input.tags && input.tags.length > 0 ? { tags: input.tags } : {}),
      ...(input.frontmatter ?? {}),
    };
    const body = input.body ?? "";
    const content = stringifyNote(body === "" ? "" : `\n${body.replace(/^\n+/, "")}`, fm);
    const unique = input.unique === true && input.overwrite !== true;
    let note: Note | undefined;
    for (let n = 1; note === undefined; n++) {
      const filename = n === 1 ? `${stem}.md` : `${stem} ${n}.md`;
      const rel = folder === "" ? filename : `${folder}/${filename}`;
      const abs = path.join(this.dir, rel);
      note = withNoteLock(this.dir, rel, () => {
        if (fs.existsSync(abs) && !input.overwrite) {
          if (unique) return undefined;
          throw new Error(`Note already exists: ${rel} (pass overwrite to replace it)`);
        }
        atomicWriteFile(abs, content);
        const created = this.reloadPath(rel);
        if (!created) throw new Error(`Failed to read back created note: ${rel}`);
        return created;
      });
    }
    this.commit(`big-brain: create ${note.path}`, [note.path]);
    return note;
  }

  /**
   * Low-level note mutation primitive used by domain operations. The latest
   * file is re-read while holding a cross-process lock, then replaced atomically.
   */
  mutateNote(ref: string, operation: string, mutate: (note: Note) => string): Note {
    this.refresh();
    const initial = this.get(ref);
    if (!initial) throw new Error(`Note not found: ${ref}`);
    const notePath = initial.path;
    const updated = withNoteLock(this.dir, notePath, () => {
      const note = this.reloadPath(notePath);
      if (!note) throw new Error(`Note changed or moved before it could be written: ${notePath}`);
      // Mutations work on LF text; the result is written back with the file's
      // dominant line ending, so editing a CRLF note never flips it to LF. (A
      // file mixing both is normalized to whichever it mostly uses.)
      const crlf = usesCRLF(note.raw);
      const next = mutate(crlf ? { ...note, raw: toLF(note.raw) } : note);
      atomicWriteFile(note.absPath, crlf ? toLF(next).replace(/\n/g, "\r\n") : next);
      const reloaded = this.reloadPath(notePath);
      if (!reloaded) throw new Error(`Failed to read back updated note: ${notePath}`);
      return reloaded;
    });
    this.commit(`big-brain: ${operation} ${updated.path}`, [updated.path]);
    return updated;
  }

  /**
   * Append markdown to a note. With `heading`, inserts at the end of that
   * section (before the next heading of the same or shallower depth);
   * otherwise appends to the end of the file.
   */
  appendToNote(ref: string, text: string, heading?: string): Note {
    const block = text.replace(/\s+$/, "");
    return this.mutateNote(ref, "append", (note) => {
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
          while (insertAt > startLine + 1 && (lines[insertAt - 1] ?? "").trim() === "") {
            insertAt--;
          }
          lines.splice(insertAt, 0, block);
          raw = lines.join("\n");
        }
      } else {
        raw = `${raw.replace(/\s+$/, "")}\n\n${block}\n`;
      }
      return raw.endsWith("\n") ? raw : `${raw}\n`;
    });
  }

  /** Merge keys into a note's frontmatter (set a key to null to delete it). */
  updateFrontmatter(ref: string, updates: Record<string, unknown>): Note {
    return this.mutateNote(ref, "update frontmatter", (note) => {
      const fm = { ...note.frontmatter };
      for (const [k, v] of Object.entries(updates)) {
        if (v === null) delete fm[k];
        else fm[k] = v;
      }
      return stringifyNote(note.body, fm);
    });
  }

  /** Replace a note's body (frontmatter preserved). */
  replaceBody(ref: string, body: string): Note {
    return this.mutateNote(ref, "rewrite", (note) =>
      stringifyNote(`\n${body.replace(/^\n+/, "")}`, note.frontmatter),
    );
  }

  /** Move a note into the archive folder (non-destructive delete). */
  archiveNote(ref: string): Note {
    this.refresh();
    const note = this.get(ref);
    if (!note) throw new Error(`Note not found: ${ref}`);
    if (note.archived) return note;
    const sourcePath = note.path;
    const destRel = `${this.config.folders.archive}/${sourcePath}`;
    const archived = withNoteLock(this.dir, sourcePath, () =>
      withNoteLock(this.dir, destRel, () => {
        const current = this.reloadPath(sourcePath);
        if (!current)
          throw new Error(`Note changed or moved before it could be archived: ${sourcePath}`);
        const destAbs = path.join(this.dir, destRel);
        fs.mkdirSync(path.dirname(destAbs), { recursive: true });
        if (fs.existsSync(destAbs)) {
          throw new Error(`Archive destination already exists: ${destRel}`);
        }
        fs.renameSync(current.absPath, destAbs);
        this.notesByPath.delete(sourcePath);
        this.nameIndex = undefined;
        const result = this.reloadPath(toPosix(destRel));
        if (!result) throw new Error(`Failed to read back archived note: ${destRel}`);
        return result;
      }),
    );
    this.commit(`big-brain: archive ${note.path}`, [sourcePath, archived.path]);
    return archived;
  }

  /**
   * Commit (and optionally push) the vault, if auto-commit is enabled in config.
   * Best-effort: never throws, so a git problem can't break a save. Public so
   * write paths outside this class (e.g. task completion) can trigger it too.
   */
  commit(message: string, touchedPaths: string[]): void {
    autoCommit(this.dir, message, this.config.git, touchedPaths);
  }

  /** Read a template file's content, if it exists. */
  template(name: string): string | undefined {
    const file = path.join(this.dir, this.config.folders.templates, `${name}.md`);
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
  }

  /**
   * Normalize a caller-supplied folder to a vault-relative posix path, refusing
   * anything that could resolve outside the vault (absolute paths, `..`).
   */
  private vaultFolder(folder: string): string {
    const posix = toPosix(folder.trim());
    if (path.isAbsolute(posix) || /^[A-Za-z]:/.test(posix)) {
      throw new Error(`Folder must be relative to the vault: ${folder}`);
    }
    const segments = posix.split("/").filter((s) => s !== "" && s !== ".");
    if (segments.includes("..")) {
      throw new Error(`Folder must stay inside the vault: ${folder}`);
    }
    return segments.join("/");
  }

  /** Force one path to be reparsed even on filesystems with coarse mtimes. */
  private reloadPath(rel: string): Note | undefined {
    const posix = toPosix(rel);
    this.notesByPath.delete(posix);
    this.signatures.delete(posix);
    this.nameIndex = undefined;
    this.refresh();
    return this.notesByPath.get(posix);
  }
}

/** True when most of the file's line breaks are CRLF. */
function usesCRLF(raw: string): boolean {
  const crlf = raw.match(/\r\n/g)?.length ?? 0;
  const all = raw.match(/\n/g)?.length ?? 0;
  return crlf > 0 && crlf * 2 >= all;
}

function countFrontmatterLines(raw: string): number {
  const lines = raw.split("\n");
  if ((lines[0] ?? "").trim() !== "---") return 0;
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? "").trim() === "---") return i + 1;
  }
  return 0;
}
