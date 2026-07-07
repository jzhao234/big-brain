import MiniSearch from "minisearch";
import type { Note, SearchOptions, SearchResult } from "./types.js";

interface Doc {
  id: string;
  title: string;
  aliases: string;
  body: string;
  tags: string[];
  type: string;
}

function toDoc(note: Note): Doc {
  return {
    id: note.path,
    title: note.title,
    aliases: note.aliases.join(" "),
    body: note.body,
    tags: note.tags,
    type: note.type,
  };
}

/** Incremental full-text index over the vault's notes. */
export class SearchIndex {
  private mini: MiniSearch<Doc>;
  private indexed = new Map<string, number>(); // path -> mtimeMs

  constructor() {
    this.mini = new MiniSearch<Doc>({
      fields: ["title", "aliases", "tags", "body"],
      storeFields: ["title", "type", "tags"],
      searchOptions: {
        boost: { title: 4, aliases: 3, tags: 2 },
        fuzzy: 0.15,
        prefix: true,
      },
    });
  }

  /** Sync the index with the current set of notes (add/replace/remove as needed). */
  sync(notes: Map<string, Note>): void {
    for (const [p, note] of notes) {
      const prev = this.indexed.get(p);
      if (prev === note.mtimeMs) continue;
      if (prev !== undefined && this.mini.has(p)) this.mini.discard(p);
      this.mini.add(toDoc(note));
      this.indexed.set(p, note.mtimeMs);
    }
    for (const p of [...this.indexed.keys()]) {
      if (!notes.has(p)) {
        if (this.mini.has(p)) this.mini.discard(p);
        this.indexed.delete(p);
      }
    }
  }

  search(query: string, notes: Map<string, Note>, opts: SearchOptions = {}): SearchResult[] {
    const limit = opts.limit ?? 20;
    const tag = opts.tag?.replace(/^#/, "").toLowerCase();
    const folder = opts.folder ? opts.folder.replace(/\/+$/, "") : undefined;

    const filter = (result: { id: string }): boolean => {
      const note = notes.get(result.id);
      if (!note) return false;
      if (!opts.includeArchived && note.archived) return false;
      if (opts.type && note.type !== opts.type) return false;
      if (tag && !note.tags.includes(tag)) return false;
      if (folder && !note.path.startsWith(`${folder}/`)) return false;
      if (opts.status && String(note.frontmatter.status ?? "") !== opts.status) return false;
      return true;
    };

    const hits = this.mini.search(query, { filter });
    return hits.slice(0, limit).map((h) => {
      const note = notes.get(String(h.id))!;
      return {
        path: note.path,
        title: note.title,
        type: note.type,
        score: h.score,
        tags: note.tags,
        excerpt: note.excerpt,
        matches: Object.keys(h.match ?? {}),
      };
    });
  }
}
