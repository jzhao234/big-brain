import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDoctor } from "../src/core/doctor.js";
import {
  type EmbeddingProvider,
  SemanticIndex,
  chunkNote,
  hybridSearch,
  rrfFuse,
} from "../src/core/embeddings.js";
import { relatedNotes } from "../src/core/related.js";
import { initVault } from "../src/core/scaffold.js";
import { Vault } from "../src/core/vault.js";

/**
 * Deterministic fake embedder: hashed character-trigram bag, unit-normalized.
 * Similar texts → similar vectors; no model download, fully reproducible.
 */
const DIM = 64;
function embedText(text: string): number[] {
  const v = new Array<number>(DIM).fill(0);
  const s = text.toLowerCase().replace(/\s+/g, " ");
  for (let i = 0; i < s.length - 2; i++) {
    const tri = s.slice(i, i + 3);
    let h = 0;
    for (const c of tri) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    v[h % DIM]! += 1;
  }
  const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

const fakeProvider: EmbeddingProvider = {
  id: "fake-trigram-v1",
  async embed(texts) {
    return texts.map(embedText);
  },
};

let dir: string;
let vault: Vault;

function enableEmbeddings(): void {
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, "brain.config.json"), "utf8"));
  cfg.embeddings = { enabled: true, model: "fake-trigram-v1" };
  fs.writeFileSync(path.join(dir, "brain.config.json"), JSON.stringify(cfg));
  vault = new Vault(dir); // reload config
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-hybrid-"));
  initVault(dir, { name: "Hybrid Test" });
  vault = new Vault(dir);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("rrfFuse", () => {
  it("ranks items high on both lists above single-list items", () => {
    const fused = rrfFuse([
      ["a", "b", "c"],
      ["b", "d", "a"],
    ]);
    const order = [...fused.entries()].sort((x, y) => y[1] - x[1]).map(([id]) => id);
    expect(order[0]).toBe("b"); // rank2+rank1 beats rank1+rank3
    expect(order[1]).toBe("a");
    expect(fused.get("c")).toBeLessThan(fused.get("d")!);
  });
});

describe("chunkNote", () => {
  it("preserves every word of an oversized paragraph in bounded chunks", () => {
    const words = Array.from({ length: 900 }, (_, i) => `word${i}`);
    const note = vault.createNote({ title: "Long paragraph", body: words.join(" ") });
    const chunks = chunkNote(note);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 2400)).toBe(true);
    expect(
      chunks
        .map((c) => c.slice(note.title.length + 1))
        .join(" ")
        .split(/\s+/),
    ).toEqual(words);
  });

  it("preserves an oversized unbroken Unicode token without splitting surrogate pairs", () => {
    const body = "🌱".repeat(2500);
    const note = vault.createNote({ title: "Token", body });
    const chunks = chunkNote(note);
    expect(chunks.every((c) => c.length <= 2400 && c.isWellFormed())).toBe(true);
    expect(chunks.map((c) => c.slice(note.title.length + 1)).join("")).toBe(body);
  });

  it("splits on H2 sections and prefixes the title", () => {
    vault.createNote({
      title: "Chunky",
      body: "intro text\n\n## One\n\nalpha\n\n## Two\n\nbeta",
    });
    const chunks = chunkNote(vault.get("Chunky")!);
    expect(chunks.length).toBe(3);
    for (const c of chunks) expect(c.startsWith("Chunky\n")).toBe(true);
    expect(chunks[1]).toContain("alpha");
  });
});

describe("SemanticIndex", () => {
  it("re-embeds legacy chunks so previously truncated paragraph tails become searchable", async () => {
    const note = vault.createNote({ title: "Legacy", body: `${"intro ".repeat(700)}tail-marker` });
    const vector = embedText("old truncated input");
    const file = path.join(dir, ".bigbrain", "embeddings.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        model: fakeProvider.id,
        notes: {
          [note.path]: {
            hash: createHash("sha1").update(note.raw).digest("hex"),
            chunks: [vector],
            centroid: vector,
          },
        },
      }),
    );
    const embed = vi.fn(fakeProvider.embed);
    const index = new SemanticIndex(dir, fakeProvider.id);
    expect(await index.ensure([note], { id: fakeProvider.id, embed })).toBe(1);
    expect(embed.mock.calls.flat(2).join(" ")).toContain("tail-marker");
    expect(await index.ensure([note], { id: fakeProvider.id, embed })).toBe(0);
  });

  it.each([
    ["missing notes", undefined],
    ["array notes", []],
    ["null entry", { "notes/One.md": null }],
    ["missing hash", { "notes/One.md": { chunks: [[1]], centroid: [1] } }],
    ["non-string hash", { "notes/One.md": { hash: 1, chunks: [[1]], centroid: [1] } }],
    ["missing chunks", { "notes/One.md": { hash: "x", centroid: [1] } }],
    ["empty chunks", { "notes/One.md": { hash: "x", chunks: [], centroid: [1] } }],
    ["empty vector", { "notes/One.md": { hash: "x", chunks: [[]], centroid: [] } }],
    ["non-numeric vector", { "notes/One.md": { hash: "x", chunks: [["1"]], centroid: [1] } }],
    ["non-finite vector", { "notes/One.md": { hash: "x", chunks: [[null]], centroid: [1] } }],
    ["missing centroid", { "notes/One.md": { hash: "x", chunks: [[1]] } }],
    ["centroid dimension", { "notes/One.md": { hash: "x", chunks: [[1]], centroid: [1, 0] } }],
    ["chunk dimensions", { "notes/One.md": { hash: "x", chunks: [[1], [1, 0]], centroid: [1] } }],
    [
      "note dimensions",
      {
        "notes/One.md": { hash: "x", chunks: [[1]], centroid: [1] },
        "notes/Two.md": { hash: "y", chunks: [[1, 0]], centroid: [1, 0] },
      },
    ],
  ])("rebuilds an index with %s", async (_label, notes) => {
    vault.createNote({ title: "One", body: "recoverable derived data" });
    const file = path.join(dir, ".bigbrain", "embeddings.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, model: fakeProvider.id, notes }));
    const index = new SemanticIndex(dir, fakeProvider.id);
    expect(index.status().notes).toBe(0);
    expect(await index.ensure(vault.notes(true), fakeProvider)).toBe(vault.notes(true).length);
    expect(new SemanticIndex(dir, fakeProvider.id).status().notes).toBe(vault.notes(true).length);
  });

  it("embeds incrementally, drops deleted notes, and invalidates on model change", async () => {
    vault.createNote({ title: "One", body: "kubernetes cluster networking" });
    vault.createNote({ title: "Two", body: "sourdough bread hydration" });
    const index = new SemanticIndex(dir, fakeProvider.id);
    expect(await index.ensure(vault.notes(true), fakeProvider)).toBeGreaterThanOrEqual(2);
    expect(await index.ensure(vault.notes(true), fakeProvider)).toBe(0); // no changes

    vault.appendToNote("One", "pods and services");
    vault.refresh();
    expect(await index.ensure(vault.notes(true), fakeProvider)).toBe(1); // only One

    fs.rmSync(path.join(dir, "notes", "Two.md"));
    vault.refresh();
    await index.ensure(vault.notes(true), fakeProvider);
    const [qv] = await fakeProvider.embed(["sourdough bread"]);
    expect(index.query(qv!).some((r) => r.path === "notes/Two.md")).toBe(false);

    // Different model id → fresh index.
    const other = new SemanticIndex(dir, "other-model");
    expect(other.status().notes).toBe(0);
  });

  it("keeps notes embedded by a concurrent pass in the same process", async () => {
    vault.createNote({ title: "Early", body: "first note" });
    const before = vault.notes(true); // a search that started before Late existed
    vault.createNote({ title: "Late", body: "second note" });
    const after = vault.notes(true);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: EmbeddingProvider = {
      id: fakeProvider.id,
      async embed(texts) {
        await gate;
        return texts.map(embedText);
      },
    };

    // Both instances load the same (empty) index; the older view finishes last.
    const older = new SemanticIndex(dir, fakeProvider.id).ensure(before, slow);
    const newer = new SemanticIndex(dir, fakeProvider.id).ensure(after, fakeProvider);
    release();
    await Promise.all([older, newer]);

    const status = new SemanticIndex(dir, fakeProvider.id).status();
    expect(status.notes).toBe(after.length);
  });

  it("merges with vectors another process saved mid-pass", async () => {
    vault.createNote({ title: "Mine", body: "embedded here" });
    const file = path.join(dir, ".bigbrain", "embeddings.json");
    const foreign = {
      hash: "x",
      chunks: [embedText("other process")],
      centroid: embedText("other process"),
    };
    const meddling: EmbeddingProvider = {
      id: fakeProvider.id,
      async embed(texts) {
        // Simulate another process saving a note this pass doesn't know about.
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(
          path.join(dir, "notes", "Theirs.md"),
          "---\ntype: note\n---\n\nother process\n",
        );
        fs.writeFileSync(
          file,
          JSON.stringify({
            version: 1,
            model: fakeProvider.id,
            notes: { "notes/Theirs.md": foreign },
          }),
        );
        return texts.map(embedText);
      },
    };

    await new SemanticIndex(dir, fakeProvider.id).ensure(vault.notes(true), meddling);
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(Object.keys(saved.notes)).toContain("notes/Theirs.md");
    expect(Object.keys(saved.notes)).toContain("notes/Mine.md");
  });

  it("drops vectors for a note that changed or vanished mid-pass", async () => {
    const edited = vault.createNote({ title: "Edited", body: "version one" });
    const removed = vault.createNote({ title: "Removed", body: "short lived" });
    const notes = vault.notes(true);
    const racing: EmbeddingProvider = {
      id: fakeProvider.id,
      async embed(texts) {
        // Another writer edits one note and deletes another while we embed.
        fs.appendFileSync(edited.absPath, "version two\n");
        fs.rmSync(removed.absPath, { force: true });
        return texts.map(embedText);
      },
    };

    await new SemanticIndex(dir, fakeProvider.id).ensure(notes, racing);
    const saved = JSON.parse(
      fs.readFileSync(path.join(dir, ".bigbrain", "embeddings.json"), "utf8"),
    );
    expect(Object.keys(saved.notes)).not.toContain(edited.path); // re-embedded next pass
    expect(Object.keys(saved.notes)).not.toContain(removed.path);
  });

  it("query ranks semantically (trigram) similar notes first", async () => {
    vault.createNote({ title: "Networking", body: "kubernetes cluster networking pods services" });
    vault.createNote({ title: "Baking", body: "sourdough bread hydration starter levain" });
    const index = new SemanticIndex(dir, fakeProvider.id);
    await index.ensure(vault.notes(true), fakeProvider);
    const [qv] = await fakeProvider.embed(["kubernetes networking pods"]);
    const top = index.query(qv!)[0];
    expect(top!.path).toBe("notes/Networking.md");
  });
});

describe("hybridSearch", () => {
  it.each(["archive", "tag"])(
    "filters %s eligibility before capping semantic candidates",
    async (filter) => {
      enableEmbeddings();
      const folder = filter === "archive" ? "archive" : "notes";
      for (let i = 0; i < 65; i++) {
        fs.writeFileSync(path.join(dir, folder, `Excluded ${i}.md`), "closer but excluded");
      }
      const target = vault.createNote({
        title: "Eligible",
        tags: ["wanted"],
        body: "distant match",
      });
      const provider: EmbeddingProvider = {
        id: "filter-test",
        async embed(texts) {
          return texts.map((text) =>
            text.includes("Eligible")
              ? [0.8, 0.6]
              : text.includes("Excluded") || text === "zzzxxyy"
                ? [1, 0]
                : [0, 1],
          );
        },
      };
      const results = await hybridSearch(
        vault,
        "zzzxxyy",
        {
          limit: 1,
          ...(filter === "tag" ? { tag: "wanted" } : {}),
        },
        { provider },
      );
      expect(results.map((r) => r.path)).toEqual([target.path]);
      expect(results[0]!.matches).toContain("semantic");
    },
  );

  it("is exactly lexical when embeddings are disabled", async () => {
    vault.createNote({ title: "Solo", body: "quantum flux capacitor" });
    const hybrid = await hybridSearch(vault, "quantum", {});
    const lexical = vault.search("quantum", {});
    expect(hybrid.map((r) => r.path)).toEqual(lexical.map((r) => r.path));
  });

  it("fuses semantic hits and respects filters", async () => {
    enableEmbeddings();
    vault.createNote({
      title: "K8s Ops",
      tags: ["infra"],
      body: "kubernetes cluster networking pods",
    });
    vault.createNote({ title: "Bread", tags: ["cooking"], body: "sourdough bread hydration" });
    const results = await hybridSearch(
      vault,
      "kubernetes networking",
      { tag: "infra" },
      { provider: fakeProvider },
    );
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.tags.includes("infra"))).toBe(true);
    expect(results[0]!.matches).toContain("semantic");
  });
});

describe("index CLI", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("../src/core/embeddings.js");
    vi.resetModules();
  });

  async function indexCommand(args: string[], provider: ReturnType<typeof vi.fn>) {
    vi.resetModules();
    vi.doMock("../src/core/embeddings.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../src/core/embeddings.js")>()),
      createEmbeddingProvider: provider,
    }));
    const { Command } = await import("commander");
    const parse = vi.spyOn(Command.prototype, "parseAsync").mockImplementation(async function () {
      return this;
    });
    await import("../src/cli/index.js");
    const program = parse.mock.instances[0]!;
    parse.mockRestore();
    return program.parseAsync(["node", "big-brain", "--vault", dir, "index", ...args]);
  }

  it("reports index status without loading the embedding provider", async () => {
    enableEmbeddings();
    await new SemanticIndex(dir, fakeProvider.id).ensure(vault.notes(true), fakeProvider);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("CLI exited");
    });
    const provider = vi.fn().mockRejectedValue(new Error("model unavailable"));
    await indexCommand(["--status"], provider);
    expect(provider).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`model ${fakeProvider.id}`));
  });

  it("rejects status with rebuild before loading a model or removing the index", async () => {
    enableEmbeddings();
    await new SemanticIndex(dir, fakeProvider.id).ensure(vault.notes(true), fakeProvider);
    const file = path.join(dir, ".bigbrain", "embeddings.json");
    const before = fs.readFileSync(file, "utf8");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("CLI exited");
    });
    const provider = vi.fn().mockResolvedValue(fakeProvider);
    await expect(indexCommand(["--status", "--rebuild"], provider)).rejects.toThrow("CLI exited");
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/--status.*--rebuild/));
    expect(provider).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });
});

describe("relatedNotes", () => {
  it("filters archived neighbors before capping semantic candidates", async () => {
    enableEmbeddings();
    const source = vault.createNote({ title: "S", body: "source" });
    const target = vault.createNote({ title: "T", body: "eligible neighbor" });
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(path.join(dir, "archive", `Excluded ${i}.md`), "excluded neighbor");
    }
    vault.refresh();
    const provider: EmbeddingProvider = {
      id: "related-filter-test",
      async embed(texts) {
        return texts.map((text) =>
          text.includes("eligible neighbor")
            ? [0.8, 0.6]
            : text.includes("source") || text.includes("excluded neighbor")
              ? [1, 0]
              : [0, 1],
        );
      },
    };

    const results = await relatedNotes(vault, source.path, { limit: 1, provider });
    expect(results.map((r) => r.path)).toEqual([target.path]);
    expect(results[0]!.reasons).toContain("semantically similar (0.80)");
  });

  it("scores links, shared tags, co-citation, and mentions with reasons", async () => {
    vault.createNote({ title: "Hub", tags: ["adtech"], body: "central" });
    vault.createNote({ title: "Alpha", tags: ["adtech", "rare-tag"], body: "See [[Hub]]." });
    vault.createNote({
      title: "Beta",
      tags: ["rare-tag"],
      body: "Also [[Hub]] and mentions Alpha here.",
    });
    vault.createNote({ title: "Loner", body: "unrelated content" });

    const related = await relatedNotes(vault, "Alpha");
    const paths = related.map((r) => r.path);
    expect(paths).toContain("notes/Hub.md"); // direct link
    expect(paths).toContain("notes/Beta.md"); // co-citation + shared rare tag + mention
    expect(paths).not.toContain("notes/Loner.md");

    const beta = related.find((r) => r.path === "notes/Beta.md")!;
    expect(beta.reasons.join(" ")).toMatch(/shared link/);
    expect(beta.reasons.join(" ")).toMatch(/rare-tag/);
    expect(beta.reasons.join(" ")).toMatch(/mentions/);
  });

  it("finds title mentions in both directions, as whole phrases, without double-counting links", async () => {
    vault.createNote({
      title: "Source",
      body: "We should revisit Kafka Migration soon. Shipping v2.",
    });
    vault.createNote({ title: "Kafka Migration", body: "plan" });
    vault.createNote({ title: "Shipp", body: "unrelated" }); // only a substring of "Shipping"
    vault.createNote({ title: "Linked Note", body: "x" });
    vault.createNote({ title: "Linker", body: "See [[Source]]; Source is great." });

    const related = await relatedNotes(vault, "Source");
    const kafka = related.find((r) => r.title === "Kafka Migration");
    expect(kafka?.reasons).toContain("mentioned in this note");
    expect(related.some((r) => r.title === "Shipp")).toBe(false);

    vault.createNote({ title: "Caf\u00e9 Noir", body: "x" });
    vault.appendToNote("Source", "Dinner at Cafe\u0301 Noir."); // decomposed accent
    const again = await relatedNotes(vault, "Source");
    expect(again.find((r) => r.title === "Caf\u00e9 Noir")?.reasons).toContain(
      "mentioned in this note",
    );

    const linker = related.find((r) => r.title === "Linker")!;
    expect(linker.reasons).toContain("links here");
    expect(linker.reasons).not.toContain("mentions this note's title");
  });

  it("adds semantic neighbors when embeddings are on", async () => {
    enableEmbeddings();
    vault.createNote({
      title: "K8s Ops",
      body: "kubernetes cluster networking pods services deployment",
    });
    vault.createNote({
      title: "K8s Security",
      body: "kubernetes cluster networking pods security policies",
    });
    vault.createNote({ title: "Bread", body: "sourdough hydration starter levain crumb" });
    const related = await relatedNotes(vault, "K8s Ops", { provider: fakeProvider });
    const sec = related.find((r) => r.path === "notes/K8s Security.md");
    expect(sec).toBeDefined();
    expect(sec!.reasons.join(" ")).toMatch(/semantically similar/);
  });
});

describe("doctor consolidation rules", () => {
  it("flags bloated notes and near-duplicates", () => {
    vault.createNote({ title: "Big", body: `## S\n\n${"long paragraph of text ".repeat(500)}` });
    const dupBody =
      "identical content about programmatic advertising deals curation segments exchange bidding auctions ".repeat(
        10,
      );
    vault.createNote({ title: "Dup One", body: dupBody });
    vault.createNote({ title: "Dup Two", body: `${dupBody} tiny difference` });
    const rules = runDoctor(vault).map((f) => f.rule);
    expect(rules).toContain("bloated-note");
    expect(rules).toContain("possible-duplicate");
  });
});
