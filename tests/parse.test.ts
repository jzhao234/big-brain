import { describe, expect, it } from "vitest";
import { stringifyNote } from "../src/core/frontmatter.js";
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

describe("extractTasks edge cases", () => {
  it("only closes a fence with the same marker, so code-sample checkboxes stay hidden", () => {
    const raw = [
      "~~~",
      "```",
      "~~~example",
      "- [ ] inside tilde fence",
      "~~~",
      "- [ ] real task",
    ].join("\n");
    const tasks = extractTasks(raw, "a.md", "A", "note");
    expect(tasks.map((t) => t.text)).toEqual(["real task"]);
  });

  it("does not open a fence on backticks with a backtick in the info string", () => {
    const tasks = extractTasks("```a`b\n- [ ] real task", "a.md", "A", "note");
    expect(tasks.map((t) => t.text)).toEqual(["real task"]);
  });

  it("reads metadata emoji that carry a VS16 selector", () => {
    const [task] = extractTasks(
      "- [ ] fix \u23EB\uFE0F \u{1F4C5}\uFE0F 2026-01-10",
      "a.md",
      "A",
      "note",
    );
    expect(task).toMatchObject({ text: "fix", due: "2026-01-10", priority: "high" });
  });

  it("marks [-] tasks as cancelled, not done", () => {
    const [task] = extractTasks("- [-] dropped idea", "a.md", "A", "note");
    expect(task).toMatchObject({ done: false, cancelled: true });
  });
});

describe("frontmatter dates", () => {
  it("keeps unquoted YAML dates as the strings the user wrote", () => {
    const note = parse("notes/a.md", "---\ncreated: 2026-01-05\n---\n\nbody\n");
    expect(note.frontmatter.created).toBe("2026-01-05");
  });

  it("still resolves YAML merge keys", () => {
    const raw = "---\nbase: &base\n  status: active\n<<: *base\n---\n\nbody\n";
    expect(parse("notes/a.md", raw).frontmatter.status).toBe("active");
  });
});

describe("CRLF notes", () => {
  it("parses tasks, headings, and frontmatter from CRLF files", () => {
    const raw =
      "---\r\ntype: project\r\n---\r\n\r\n## Tasks\r\n\r\n- [ ] write docs 📅 2026-01-05\r\n";
    const note = parse("projects/P.md", raw);
    expect(note.frontmatter.type).toBe("project");
    expect(note.headings.map((h) => h.text)).toEqual(["Tasks"]);
    expect(note.tasks).toHaveLength(1);
    expect(note.tasks[0]).toMatchObject({ text: "write docs", due: "2026-01-05", line: 6 });
    expect(note.raw).toBe(raw); // on-disk bytes are kept for hashing
  });
});

describe("fenced code beyond triple backticks", () => {
  const body = [
    "~~~md",
    "## Not a heading [[Not A Link]] #nottag",
    "~~~",
    "````",
    "```",
    "## Still code",
    "```",
    "````",
    "## Real [[Real Link]] #realtag",
  ].join("\n");

  it("keeps headings, links, and tags in ~~~ and longer fences out of the note", () => {
    expect(extractHeadings(body)).toEqual([
      { depth: 2, text: "Real [[Real Link]] #realtag", line: 8 },
    ]);
    expect(extractLinks(body).map((l) => l.target)).toEqual(["Real Link"]);
    expect(extractInlineTags(body)).toEqual(["realtag"]);
  });

  it("treats an unclosed fence as code to the end, like the task parser", () => {
    expect(extractHeadings("## A\n```\n## B")).toEqual([{ depth: 2, text: "A", line: 0 }]);
  });
});

describe("frontmatter boundaries", () => {
  it("reads a note that opens with an unclosed --- as all body", () => {
    const note = parse("notes/Rule.md", "---\nafter a rule\n- [ ] task");
    expect(note.frontmatter).toEqual({});
    expect(note.body).toBe("---\nafter a rule\n- [ ] task");
    expect(note.bodyLine).toBe(0);
    expect(note.tasks.map((t) => t.line)).toEqual([2]);
  });

  it("flags non-mapping YAML and keeps the block out of the body", () => {
    const note = parse("notes/Scalar.md", "---\njust words\n---\n## Body\n- [ ] t");
    expect(note.frontmatterError).toMatch(/mapping/);
    expect(note.body).toBe("## Body\n- [ ] t");
    expect(note.bodyLine).toBe(3);
    expect(note.headings).toEqual([{ depth: 2, text: "Body", line: 0 }]);
    expect(note.tasks.map((t) => t.line)).toEqual([4]);
  });

  it("counts body lines from after a BOM-prefixed block", () => {
    const note = parse("notes/Bom.md", "\uFEFF---\na: 1\n---\n# T");
    expect(note.frontmatter).toEqual({ a: 1 });
    expect(note.bodyLine).toBe(3);
  });

  it("serializes a body that itself opens with --- without eating it", () => {
    const body = "---\nbetween rules\n---\nafter";
    const withKeys = stringifyNote(body, { status: "active" });
    expect(parse("notes/A.md", withKeys).body).toBe(`${body}\n`);
    const noKeys = stringifyNote(body, {});
    expect(parse("notes/A.md", noKeys).frontmatter).toEqual({});
    expect(parse("notes/A.md", noKeys).body).toBe(`${body}\n`);
  });
});
