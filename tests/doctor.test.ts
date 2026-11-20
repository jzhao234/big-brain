import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDoctor } from "../src/core/doctor.js";
import { initVault } from "../src/core/scaffold.js";
import { Vault } from "../src/core/vault.js";

let dir: string;
let vault: Vault;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-doctor-test-"));
  initVault(dir, { name: "Doctor Test" });
  vault = new Vault(dir);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("runDoctor", () => {
  it("ignores unresolved attachment links but still reports broken note links", () => {
    vault.createNote({
      title: "Links",
      body: "![[diagram.png]]\n![[folder/photo.jpg|Photo]]\n[[missing-note]]\n[[Release 1.2]]\n[[Meeting w. Bob]]",
    });

    const broken = runDoctor(vault).filter((finding) => finding.rule === "broken-link");

    expect(broken.map((finding) => finding.message)).toEqual([
      "[[missing-note]] does not resolve to any note",
      "[[Release 1.2]] does not resolve to any note",
      "[[Meeting w. Bob]] does not resolve to any note",
    ]);
  });

  it("builds inbound links in one pass instead of calling backlinks per note", () => {
    vault.createNote({ title: "Target", body: "No outgoing links." });
    vault.createNote({ title: "Source", body: "See [[Target]]." });
    const backlinks = vi.spyOn(vault, "backlinks");

    const findings = runDoctor(vault);

    expect(backlinks).not.toHaveBeenCalled();
    expect(
      findings.some(
        (finding) => finding.rule === "orphan-note" && finding.path === "notes/Target.md",
      ),
    ).toBe(false);
  });

  it("reports frontmatter that doesn't parse", () => {
    fs.writeFileSync(
      path.join(dir, "notes", "Broken.md"),
      "---\nprivate: [unclosed\n---\n# Home\n",
    );
    vault.refresh();
    const found = runDoctor(vault).filter((f) => f.rule === "bad-frontmatter");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ path: "notes/Broken.md", severity: "warning" });
  });
});

describe("link and heading ambiguity", () => {
  function write(rel: string, content: string): void {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }

  it("warns once per note when a link only matches tied filename stems", () => {
    write("a/fleet.md", "# Alpha sheet\n");
    write("b/fleet.md", "# Beta sheet\n");
    write("notes/Linker.md", "# Linker\n\n[[fleet]] and again [[Fleet]]\n");
    vault.refresh();

    const ambiguous = runDoctor(vault).filter((f) => f.rule === "ambiguous-link");

    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0]?.path).toBe("notes/Linker.md");
    expect(ambiguous[0]?.message).toContain("a/fleet.md, b/fleet.md");
    expect(ambiguous[0]?.message).toContain("resolves to a/fleet.md");
  });

  it("does not warn when a title settles the link", () => {
    write("projects/Fleet.md", "# Fleet\n");
    write("b/fleet.md", "# Fleet platform brag sheet\n");
    write("notes/Linker.md", "# Linker\n\n[[Fleet]]\n");
    vault.refresh();

    expect(runDoctor(vault).filter((f) => f.rule === "ambiguous-link")).toEqual([]);
  });

  it("reports a repeated sibling heading once with its count", () => {
    vault.createNote({
      title: "Twice",
      body: "## Log\n\n- one\n\n## Tasks\n\n## log\n\n- two\n\n```\n## Log\n```\n",
    });

    const dup = runDoctor(vault).filter((f) => f.rule === "duplicate-heading");

    expect(dup).toHaveLength(1);
    expect(dup[0]?.path).toBe("notes/Twice.md");
    expect(dup[0]?.message).toContain('"Log" appears 2 times');
  });

  it("counts sub-headings of two same-named parents separately", () => {
    vault.createNote({
      title: "Split",
      body: "## Log\n\n### Impact\n\n## Log\n\n### Impact\n",
    });

    const dup = runDoctor(vault).filter((f) => f.rule === "duplicate-heading");

    expect(dup.map((f) => f.message)).toEqual([
      'Heading "Log" appears 2 times in the same section; appends under it go to the first one, so merge or rename the others',
    ]);
  });

  it("allows the same sub-heading under different parents", () => {
    vault.createNote({
      title: "Entries",
      body: "## 2026-01-01 First\n\n### Impact\n\nA\n\n## 2026-02-01 Second\n\n### Impact\n\nB\n",
    });

    expect(runDoctor(vault).filter((f) => f.rule === "duplicate-heading")).toEqual([]);
  });
});
