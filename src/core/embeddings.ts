import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { noteMatchesFilters } from "./search.js";
import type { EmbeddingsConfig, Note, SearchOptions, SearchResult } from "./types.js";
import type { Vault } from "./vault.js";

/**
 * Optional local semantic layer for hybrid search.
 *
 * Design constraints (see README design principles):
 * - Files stay the source of truth: the embedding index is DERIVED and
 *   rebuildable, lives at <vault>/.bigbrain/embeddings.json, and is meant to
 *   be gitignored — each machine builds its own.
 * - Deterministic-first: lexical search keeps working with embeddings off;
 *   hybrid fuses the two rankings with Reciprocal Rank Fusion.
 * - Model-agnostic & local: the default provider runs a small model fully
 *   on-device via @huggingface/transformers (an optionalDependency); no API
 *   keys, no note content leaves the machine.
 */

export interface EmbeddingProvider {
  /** Identifier stored in the index; changing it invalidates all vectors. */
  readonly id: string;
  /** Embed texts into unit-normalized vectors (cosine == dot product). */
  embed(texts: string[]): Promise<number[][]>;
}

/** Where the derived index lives, relative to the vault root. */
export const INDEX_DIR = ".bigbrain";
export const INDEX_FILE = "embeddings.json";

const CHUNK_TARGET = 1200; // chars per chunk (markdown-boundary-aware, QMD-style)
const RRF_K = 60;

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

let cachedProvider: EmbeddingProvider | undefined;

/**
 * Create the local transformers.js provider (cached per process). Throws a
 * actionable error if the optional dependency isn't installed.
 */
/**
 * Structural view of the bits of @huggingface/transformers we use, so the
 * codebase typechecks even when the optional dependency isn't installed
 * (CI runs with --omit=optional).
 */
interface TransformersModule {
  env: { cacheDir?: string };
  pipeline(
    task: "feature-extraction",
    model: string,
    opts?: Record<string, unknown>,
  ): Promise<
    (text: string, opts?: Record<string, unknown>) => Promise<{ data: Float32Array | number[] }>
  >;
}

export async function createEmbeddingProvider(
  config: EmbeddingsConfig,
): Promise<EmbeddingProvider> {
  if (cachedProvider && cachedProvider.id === config.model) return cachedProvider;
  let transformers: TransformersModule;
  try {
    // Non-literal specifier: the package is an optionalDependency, so module
    // resolution must happen at runtime only — a literal import() would fail
    // `tsc` when installed with --omit=optional (as CI does).
    const moduleName = "@huggingface/transformers";
    transformers = (await import(moduleName)) as unknown as TransformersModule;
  } catch {
    throw new Error(
      "embeddings.enabled is true but @huggingface/transformers is not installed. " +
        "Reinstall big-brain with optional dependencies (plain `npm install`), or set embeddings.enabled to false.",
    );
  }
  // Stable model cache that survives reinstalls of big-brain itself.
  transformers.env.cacheDir = path.join(os.homedir(), ".cache", "big-brain", "models");
  const extractor = await transformers.pipeline("feature-extraction", config.model, {
    dtype: "q8",
  });
  const provider: EmbeddingProvider = {
    id: config.model,
    async embed(texts: string[]): Promise<number[][]> {
      const out: number[][] = [];
      for (const text of texts) {
        const tensor = await extractor(text, { pooling: "mean", normalize: true });
        out.push(Array.from(tensor.data));
      }
      return out;
    },
  };
  cachedProvider = provider;
  return provider;
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

/** Split a note into embedding chunks along markdown section boundaries. */
export function chunkNote(note: Note): string[] {
  const head = [note.title, note.tags.length > 0 ? `tags: ${note.tags.join(", ")}` : ""]
    .filter(Boolean)
    .join("\n");
  const sections = note.body.split(/\n(?=## )/);
  const chunks: string[] = [];
  for (const section of sections) {
    const text = section.trim();
    if (text === "") continue;
    if (text.length <= CHUNK_TARGET) {
      chunks.push(`${note.title}\n${text}`);
      continue;
    }
    // Long section: split on paragraph boundaries into ~CHUNK_TARGET pieces.
    let buf = "";
    for (const para of text.split(/\n{2,}/)) {
      if (buf.length + para.length > CHUNK_TARGET && buf !== "") {
        chunks.push(`${note.title}\n${buf.trim()}`);
        buf = "";
      }
      buf += `${para}\n\n`;
    }
    if (buf.trim() !== "") chunks.push(`${note.title}\n${buf.trim()}`);
  }
  if (chunks.length === 0) chunks.push(head);
  return chunks.map((c) => c.slice(0, CHUNK_TARGET * 2));
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

interface NoteVectors {
  /** sha1 of the note's raw content; mismatch → re-embed. */
  hash: string;
  chunks: number[][];
  /** Unit-normalized mean of chunk vectors, for note↔note similarity. */
  centroid: number[];
}

interface IndexFileShape {
  version: 1;
  model: string;
  notes: Record<string, NoteVectors>;
}

function sha1(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}

function dot(a: number[], b: number[]): number {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) sum += a[i]! * b[i]!;
  return sum;
}

function normalize(v: number[]): number[] {
  const norm = Math.sqrt(dot(v, v)) || 1;
  return v.map((x) => x / norm);
}

function meanVector(vectors: number[][]): number[] {
  const dim = vectors[0]?.length ?? 0;
  const mean = new Array<number>(dim).fill(0);
  for (const v of vectors) for (let i = 0; i < dim; i++) mean[i]! += v[i]! / vectors.length;
  return normalize(mean);
}

const round = (x: number) => Math.round(x * 1e6) / 1e6;

/** The derived, rebuildable per-vault embedding index. */
export class SemanticIndex {
  private data: IndexFileShape;
  private file: string;

  constructor(vaultDir: string, model: string) {
    this.file = path.join(vaultDir, INDEX_DIR, INDEX_FILE);
    this.data = { version: 1, model, notes: {} };
    if (fs.existsSync(this.file)) {
      try {
        const loaded = JSON.parse(fs.readFileSync(this.file, "utf8")) as IndexFileShape;
        // A different model invalidates the whole index.
        if (loaded.version === 1 && loaded.model === model) this.data = loaded;
      } catch {
        // Corrupt index: rebuild from scratch. It's derived data.
      }
    }
  }

  /** Notes whose content changed (or are new) since last indexing. */
  stale(notes: Note[]): Note[] {
    return notes.filter((n) => this.data.notes[n.path]?.hash !== sha1(n.raw));
  }

  /**
   * Bring the index up to date: embed new/changed notes, drop deleted ones,
   * persist. Returns how many notes were (re)embedded.
   */
  async ensure(notes: Note[], provider: EmbeddingProvider): Promise<number> {
    const stale = this.stale(notes);
    for (const note of stale) {
      const chunks = chunkNote(note);
      const vectors = (await provider.embed(chunks)).map((v) => v.map(round));
      this.data.notes[note.path] = {
        hash: sha1(note.raw),
        chunks: vectors,
        centroid: meanVector(vectors).map(round),
      };
    }
    const alive = new Set(notes.map((n) => n.path));
    for (const p of Object.keys(this.data.notes)) {
      if (!alive.has(p)) delete this.data.notes[p];
    }
    if (stale.length > 0 || !fs.existsSync(this.file)) this.save();
    return stale.length;
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data), "utf8");
  }

  /** Rank note paths by max-chunk cosine similarity to a query vector. */
  query(queryVector: number[], limit = 50): Array<{ path: string; score: number }> {
    const scored: Array<{ path: string; score: number }> = [];
    for (const [p, nv] of Object.entries(this.data.notes)) {
      let best = -1;
      for (const chunk of nv.chunks) best = Math.max(best, dot(queryVector, chunk));
      scored.push({ path: p, score: best });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /** Rank other notes by centroid similarity to the given note. */
  similarTo(notePath: string, limit = 10): Array<{ path: string; score: number }> {
    const self = this.data.notes[notePath];
    if (!self) return [];
    const scored: Array<{ path: string; score: number }> = [];
    for (const [p, nv] of Object.entries(this.data.notes)) {
      if (p === notePath) continue;
      scored.push({ path: p, score: dot(self.centroid, nv.centroid) });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  status(): { model: string; notes: number; chunks: number; sizeBytes: number } {
    const chunks = Object.values(this.data.notes).reduce((n, v) => n + v.chunks.length, 0);
    const sizeBytes = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0;
    return {
      model: this.data.model,
      notes: Object.keys(this.data.notes).length,
      chunks,
      sizeBytes,
    };
  }
}

// ---------------------------------------------------------------------------
// Hybrid search (lexical ⊕ semantic via Reciprocal Rank Fusion)
// ---------------------------------------------------------------------------

/** RRF: score(d) = Σ over rankings 1/(k + rank). Order-only, score-scale-free. */
export function rrfFuse(rankings: string[][], k = RRF_K): Map<string, number> {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.forEach((id, i) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1));
    });
  }
  return scores;
}

export interface HybridDeps {
  /** Injectable for tests; defaults to the transformers.js provider. */
  provider?: EmbeddingProvider;
  /** Skip the incremental re-embed pass (use the index as-is). */
  skipEnsure?: boolean;
}

/**
 * Hybrid search over a vault. With embeddings disabled this is exactly the
 * lexical search; with them enabled, lexical and semantic rankings are fused
 * with RRF and filters apply to both.
 */
export async function hybridSearch(
  vault: Vault,
  query: string,
  opts: SearchOptions = {},
  deps: HybridDeps = {},
): Promise<SearchResult[]> {
  const limit = opts.limit ?? 20;
  if (!vault.config.embeddings.enabled) return vault.search(query, opts);

  const pool = Math.max(limit * 3, 30);
  const lexical = vault.search(query, { ...opts, limit: pool });

  const provider = deps.provider ?? (await createEmbeddingProvider(vault.config.embeddings));
  const index = new SemanticIndex(vault.dir, provider.id);
  const notes = vault.notes(true);
  if (!deps.skipEnsure) await index.ensure(notes, provider);

  const [queryVector] = await provider.embed([query]);
  const byPath = new Map(notes.map((n) => [n.path, n]));
  const semantic = index
    .query(queryVector!, pool * 2)
    .filter(({ path: p }) => {
      const note = byPath.get(p);
      return note !== undefined && noteMatchesFilters(note, opts);
    })
    .slice(0, pool);

  const fused = rrfFuse([lexical.map((r) => r.path), semantic.map((s) => s.path)]);
  const lexicalByPath = new Map(lexical.map((r) => [r.path, r]));
  const semanticPaths = new Set(semantic.map((s) => s.path));

  return [...fused.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([p, score]) => {
      const note = byPath.get(p)!;
      const lex = lexicalByPath.get(p);
      const matches = [...(lex ? lex.matches : []), ...(semanticPaths.has(p) ? ["semantic"] : [])];
      return {
        path: note.path,
        title: note.title,
        type: note.type,
        score,
        tags: note.tags,
        excerpt: note.excerpt,
        matches,
      };
    });
}
