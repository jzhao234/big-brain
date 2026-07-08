import { type EmbeddingProvider, SemanticIndex, createEmbeddingProvider } from "./embeddings.js";
import type { Note } from "./types.js";
import type { Vault } from "./vault.js";

/**
 * "What else in the vault matters for this note?" — deterministic graph/tag
 * signals first (every hit carries human-readable reasons), plus semantic
 * neighbors when the embeddings layer is enabled.
 */

export interface RelatedNote {
  path: string;
  title: string;
  type: string;
  score: number;
  /** Why this note is related, e.g. "links here", "2 shared tags: adtech, magnite". */
  reasons: string[];
}

const WEIGHTS = {
  direct: 5, // A links B or B links A
  coCitation: 1.5, // per shared link-neighbor
  sharedTagBase: 1, // per shared tag, scaled by tag rarity
  titleMention: 2, // one note's body mentions the other's title
  semantic: 4, // scaled by cosine similarity
};

export interface RelatedOptions {
  limit?: number;
  /** Injectable for tests. When omitted and embeddings are enabled, the default local provider is used. */
  provider?: EmbeddingProvider;
}

export async function relatedNotes(
  vault: Vault,
  ref: string,
  opts: RelatedOptions = {},
): Promise<RelatedNote[]> {
  const limit = opts.limit ?? 8;
  const source = vault.get(ref);
  if (!source) throw new Error(`Note not found: ${ref}`);

  const notes = vault.notes().filter((n) => n.path !== source.path);
  const scores = new Map<string, { score: number; reasons: string[] }>();
  const bump = (p: string, score: number, reason: string) => {
    const cur = scores.get(p) ?? { score: 0, reasons: [] };
    cur.score += score;
    if (!cur.reasons.includes(reason)) cur.reasons.push(reason);
    scores.set(p, cur);
  };

  // Resolve a note's outgoing links to paths once.
  const outgoing = (n: Note): Set<string> => {
    const set = new Set<string>();
    for (const l of n.links) {
      const t = vault.resolveLink(l);
      if (t) set.add(t.path);
    }
    return set;
  };
  const sourceOut = outgoing(source);

  // Tag rarity: a tag shared by 2 notes says more than one shared by 20.
  const tagCounts = new Map<string, number>();
  for (const n of vault.notes())
    for (const t of n.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
  const total = vault.notes().length;

  const sourceTitle = source.title.toLowerCase();
  for (const note of notes) {
    const noteOut = outgoing(note);

    // 1. Direct links, either direction.
    if (sourceOut.has(note.path)) bump(note.path, WEIGHTS.direct, "linked from this note");
    if (noteOut.has(source.path)) bump(note.path, WEIGHTS.direct, "links here");

    // 2. Co-citation: shared link-neighbors.
    const shared = [...noteOut].filter((p) => sourceOut.has(p));
    if (shared.length > 0) {
      bump(
        note.path,
        WEIGHTS.coCitation * shared.length,
        `${shared.length} shared link${shared.length > 1 ? "s" : ""}`,
      );
    }

    // 3. Shared tags, weighted by rarity (rare tag ≈ strong signal).
    const sharedTags = note.tags.filter((t) => source.tags.includes(t));
    if (sharedTags.length > 0) {
      let w = 0;
      for (const t of sharedTags)
        w += WEIGHTS.sharedTagBase * Math.log(1 + total / (tagCounts.get(t) ?? 1));
      bump(
        note.path,
        w,
        `${sharedTags.length} shared tag${sharedTags.length > 1 ? "s" : ""}: ${sharedTags.slice(0, 4).join(", ")}`,
      );
    }

    // 4. Unlinked title mentions (candidate links).
    if (sourceTitle.length >= 5 && note.body.toLowerCase().includes(sourceTitle)) {
      bump(note.path, WEIGHTS.titleMention, "mentions this note's title");
    }
  }

  // 5. Semantic neighbors (only when the embeddings layer is on).
  if (vault.config.embeddings.enabled) {
    try {
      const provider = opts.provider ?? (await createEmbeddingProvider(vault.config.embeddings));
      const index = new SemanticIndex(vault.dir, provider.id);
      await index.ensure(vault.notes(true), provider);
      for (const { path: p, score } of index.similarTo(source.path, limit * 2)) {
        if (score < 0.45) continue; // below this, "similarity" is noise
        if (!notes.some((n) => n.path === p)) continue; // archived etc.
        bump(p, WEIGHTS.semantic * score, `semantically similar (${score.toFixed(2)})`);
      }
    } catch {
      // Embeddings unavailable (dep missing, model not downloaded): the
      // deterministic signals above still stand on their own.
    }
  }

  const byPath = new Map(notes.map((n) => [n.path, n]));
  return [...scores.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, limit)
    .map(([p, { score, reasons }]) => {
      const n = byPath.get(p)!;
      return { path: n.path, title: n.title, type: n.type, score, reasons };
    });
}
