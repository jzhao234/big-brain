import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

describe("relatedNotes", () => {
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
