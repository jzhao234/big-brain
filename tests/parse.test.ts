import { describe, expect, it } from "vitest";
import {
  extractHeadings,
  extractInlineTags,
  extractLinks,
  extractTasks,
  parseNote,
} from "../src/core/parse.js";

const FOLDER_TYPES = { projects: "project", notes: "note", daily: "daily", inbox: "inbox" };

function parse(relPath: string, raw: string) {
  return parseNote({
    relPath,
    absPath: `/vault/${relPath}`,
    raw,
    mtimeMs: 1,
    folderTypes: FOLDER_TYPES,
    archiveFolder: "archive",
  });
}

describe("extractLinks", () => {
  it("parses plain, aliased, and heading wikilinks", () => {
    const links = extractLinks("See [[Foo]], [[Bar|the bar]], and [[Baz#Section]].");
    expect(links).toHaveLength(3);
    expect(links[0]).toMatchObject({ target: "Foo" });
    expect(links[1]).toMatchObject({ target: "Bar", alias: "the bar" });
    expect(links[2]).toMatchObject({ target: "Baz", heading: "Section" });
  });

  it("ignores links inside code blocks and inline code", () => {
    const body = "```\n[[NotALink]]\n```\nand `[[AlsoNot]]` but [[Real]]";
    expect(extractLinks(body).map((l) => l.target)).toEqual(["Real"]);
  });
});

describe("extractInlineTags", () => {
  it("finds tags and lowercases them", () => {
    expect(extractInlineTags("Work on #AdTech and #infra/aws today")).toEqual([
      "adtech",
      "infra/aws",
    ]);
  });

  it("does not match headings or mid-word hashes", () => {
    expect(extractInlineTags("# Heading\nfoo#bar")).toEqual([]);
  });
});

describe("extractTasks", () => {
  it("parses status, due, priority, and completion metadata", () => {
    const raw = [
      "# P",
      "- [ ] Ship it ⏫ 📅 2026-07-10",
      "- [x] Draft ✅ 2026-07-01",
      "- [ ] Someday 🔽 #later",
    ].join("\n");
    const tasks = extractTasks(raw, "projects/P.md", "P", "project");
    expect(tasks).toHaveLength(3);
    expect(tasks[0]).toMatchObject({
      text: "Ship it",
      done: false,
      due: "2026-07-10",
      priority: "high",
      line: 1,
    });
    expect(tasks[1]).toMatchObject({ text: "Draft", done: true, completedOn: "2026-07-01" });
    expect(tasks[2]).toMatchObject({ priority: "low", tags: ["later"] });
  });

  it("gives duplicate task texts distinct stable ids", () => {
    const raw = "- [ ] call mom\n- [ ] call mom";
    const tasks = extractTasks(raw, "a.md", "a", "note");
    expect(tasks[0]!.id).not.toEqual(tasks[1]!.id);
    expect(extractTasks(raw, "a.md", "a", "note")[0]!.id).toEqual(tasks[0]!.id);
  });
});

describe("parseNote", () => {
  it("reads frontmatter, merges tags, infers title", () => {
    const note = parse(
      "notes/Foo.md",
      "---\ntitle: Foo Note\ntags: [alpha]\naliases: [F]\n---\n\nBody with #beta tag and [[Bar]].",
    );
    expect(note.title).toBe("Foo Note");
    expect(note.type).toBe("note");
    expect(note.tags.sort()).toEqual(["alpha", "beta"]);
    expect(note.aliases).toEqual(["F"]);
    expect(note.links[0]!.target).toBe("Bar");
  });

  it("falls back to H1 then filename for the title, folder for type", () => {
    expect(parse("projects/My Proj.md", "# The Heading\nhi").title).toBe("The Heading");
    expect(parse("projects/My Proj.md", "no heading").title).toBe("My Proj");
    expect(parse("projects/My Proj.md", "x").type).toBe("project");
  });

  it("survives malformed frontmatter", () => {
    const note = parse("notes/Bad.md", "---\n{{invalid yaml: [\n---\ncontent");
    expect(note.title).toBe("Bad");
    expect(note.raw).toContain("content");
  });

  it("extracts headings with line numbers and flags archived paths", () => {
    const note = parse("archive/notes/Old.md", "# One\n\n## Two");
    expect(note.archived).toBe(true);
    expect(extractHeadings(note.body)).toEqual([
      { depth: 1, text: "One", line: 0 },
      { depth: 2, text: "Two", line: 2 },
    ]);
  });
});
