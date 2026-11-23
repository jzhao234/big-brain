import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDoctor } from "../src/core/doctor.js";
import { createProject } from "../src/core/projects.js";
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

describe("possible duplicates", () => {
  const sentences = (topic: string, n: number) =>
    Array.from(
      { length: n },
      (_, i) =>
        `The ${topic} team shipped change number ${i} after reviewing ${topic} metrics ${i * 7}.`,
    ).join(" ");

  it("keeps notes built from one template apart", () => {
    const template = (name: string, facts: string) =>
      `## Summary\n\n${name} is a client of the standard stack: fleet, auth, lens, explorer and pages.\n\n` +
      `## Identifiers\n\n${facts}\n\n## Log\n\n- 2026-01-02: deployed boxes, domains, email and invites.\n`;
    vault.createNote({ title: "Alpha", body: template("Alpha", sentences("alpha", 6)) });
    vault.createNote({ title: "Beta", body: template("Beta", sentences("beta", 6)) });

    expect(runDoctor(vault).filter((f) => f.rule === "possible-duplicate")).toEqual([]);
  });

  it("flags a copied note with small edits", () => {
    const body = sentences("platform", 12);
    vault.createNote({ title: "Original", body });
    vault.createNote({ title: "Copy", body: `${body} One extra closing sentence here.` });

    const dup = runDoctor(vault).filter((f) => f.rule === "possible-duplicate");

    expect(dup).toHaveLength(1);
    expect(dup[0]?.message).toMatch(
      /^\d+% of the text overlaps with notes\/(Copy|Original)\.md; merge them/,
    );
  });

  it("ignores a footer shared by many notes", () => {
    const footer = "Maintained by the platform team; ask in the shared channel before editing.";
    for (let i = 0; i < 60; i++) {
      vault.createNote({ title: `Note ${i}`, body: `${sentences(`topic${i}`, 3)}\n\n${footer}` });
    }

    expect(runDoctor(vault).filter((f) => f.rule === "possible-duplicate")).toEqual([]);
  });

  it("scores a nominated pair on all its text, boilerplate included", () => {
    const footer = sentences("footer", 4);
    for (let i = 0; i < 55; i++) {
      vault.createNote({
        title: `Filler ${i}`,
        body: `${sentences(`filler${i}`, 2)}\n\n${footer}`,
      });
    }
    const body = `${sentences("twin", 3)}\n\n${footer}`;
    vault.createNote({ title: "Twin A", body });
    vault.createNote({ title: "Twin B", body });

    const dup = runDoctor(vault).filter((f) => f.rule === "possible-duplicate");

    expect(dup.map((f) => f.message)).toEqual([
      "100% of the text overlaps with notes/Twin B.md; merge them or make them distinct",
    ]);
  });

  it("still checks vaults with more than 200 notes", () => {
    for (let i = 0; i < 205; i++) {
      vault.createNote({ title: `Filler ${i}`, body: sentences(`filler${i}`, 3) });
    }
    const body = sentences("copied", 12);
    vault.createNote({ title: "First", body });
    vault.createNote({ title: "Second", body });

    const dup = runDoctor(vault).filter((f) => f.rule === "possible-duplicate");

    expect(dup.map((f) => f.path).sort()).toEqual(["notes/First.md"]);
  });
});

describe("stale-summary", () => {
  function gitIn(args: string[], date?: string): void {
    const env = date
      ? { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
      : process.env;
    execFileSync("git", args, { cwd: dir, env, stdio: "ignore" });
  }
  function commit(date: string): void {
    gitIn(["add", "-A"]);
    gitIn(["-c", "user.name=Test", "-c", "user.email=t@example.com", "commit", "-qm", "x"], date);
  }
  const stale = () => runDoctor(vault).filter((f) => f.rule === "stale-summary");

  beforeEach(() => {
    gitIn(["init", "-q"]);
    vault.createNote({
      title: "Proj",
      body: "## Summary\n\nState: building.\n\n## Log\n\n- 2026-01-05: started\n",
    });
    commit("2026-01-05T12:00:00");
    vault.refresh();
  });

  it("flags Log entries added on a later day than the Summary changed", () => {
    vault.appendToNote("Proj", "- 2026-01-07: shipped v1", "Log");
    commit("2026-01-07T12:00:00");
    vault.refresh();

    expect(stale()).toEqual([
      {
        severity: "info",
        rule: "stale-summary",
        path: "notes/Proj.md",
        message:
          'Summary last changed 2026-01-05, and 1 Log entry was added after it (latest: "2026-01-07: shipped v1"). Session context shows the Summary: update it, or refresh its as-of date if it still holds',
      },
    ]);
  });

  it("clears once the Summary changes", () => {
    vault.appendToNote("Proj", "- 2026-01-07: shipped v1", "Log");
    commit("2026-01-07T12:00:00");
    vault.editNote("Proj", "State: building.", "State: v1 shipped.");
    commit("2026-01-08T12:00:00");
    vault.refresh();

    expect(stale()).toEqual([]);
  });

  it("ignores a Log entry added the same day as the Summary changed", () => {
    vault.appendToNote("Proj", "- 2026-01-05: wired CI", "Log");
    commit("2026-01-05T18:00:00");
    vault.refresh();

    expect(stale()).toEqual([]);
  });

  it("counts an uncommitted Log entry as added today", () => {
    vault.appendToNote("Proj", "- one", "Log");
    vault.appendToNote("Proj", "- two", "Log");
    vault.refresh();

    expect(stale()[0]?.message).toContain('2 Log entries were added after it (latest: "two")');
  });

  it("checks the Goal section of a default project note", () => {
    createProject(vault, { title: "Plain", goal: "Ship the thing." });
    commit("2026-01-05T12:00:00");
    vault.appendToNote("Plain", "- shipped", "Log");
    vault.refresh();

    expect(stale().map((f) => f.message.slice(0, 31))).toEqual(["Goal last changed 2026-01-05, a"]);
  });

  it("leaves fenced examples out and reads numbered or spaced items", () => {
    vault.appendToNote("Proj", "```\n- example entry\n```", "Log");
    commit("2026-01-06T12:00:00");
    vault.refresh();
    expect(stale()).toEqual([]);

    vault.appendToNote("Proj", "1.  numbered entry", "Log");
    commit("2026-01-08T12:00:00");
    vault.appendToNote("Proj", "-   spaced entry", "Log");
    commit("2026-01-07T12:00:00");
    vault.refresh();
    expect(stale()[0]?.message).toContain(
      '2 Log entries were added after it (latest: "numbered entry")',
    );
  });

  it("counts a change to fenced text in the Summary", () => {
    vault.editNote("Proj", "State: building.", "State: building.\n\n```\nport: 8080\n```");
    commit("2026-01-05T13:00:00");
    vault.appendToNote("Proj", "- moved port", "Log");
    commit("2026-01-06T12:00:00");
    vault.editNote("Proj", "port: 8080", "port: 9090");
    commit("2026-01-07T12:00:00");
    vault.refresh();

    expect(stale()).toEqual([]);
  });

  it("skips untracked notes and vaults outside git", () => {
    vault.createNote({ title: "New", body: "## Summary\n\nFresh.\n\n## Log\n\n- added\n" });
    vault.appendToNote("Proj", "- later", "Log");
    vault.refresh();
    expect(stale().map((f) => f.path)).toEqual(["notes/Proj.md"]);

    fs.rmSync(path.join(dir, ".git"), { recursive: true, force: true });
    expect(stale()).toEqual([]);
  });
});
