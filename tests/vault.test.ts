import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDailyNote, logToDaily } from "../src/core/daily.js";
import { runDoctor } from "../src/core/doctor.js";
import { vaultOverview } from "../src/core/overview.js";
import { parseNote } from "../src/core/parse.js";
import { createProject, listProjects, setProjectStatus } from "../src/core/projects.js";
import { initVault } from "../src/core/scaffold.js";
import { SearchIndex } from "../src/core/search.js";
import { addTask, completeTask, listTasks, updateTask } from "../src/core/tasks.js";
import { todayISO } from "../src/core/util.js";
import { Vault } from "../src/core/vault.js";
import { withNoteLock } from "../src/core/write.js";

let dir: string;
let vault: Vault;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-test-"));
  initVault(dir, { name: "Test Brain" });
  vault = new Vault(dir);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("initVault", () => {
  it("scaffolds config, index, starter notes, and renames _gitignore", () => {
    expect(fs.existsSync(path.join(dir, "brain.config.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "BRAIN.md"))).toBe(true);
    expect(fs.existsSync(path.join(dir, ".gitignore"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "_gitignore"))).toBe(false);
    expect(fs.readFileSync(path.join(dir, "BRAIN.md"), "utf8")).toContain("Test Brain");
  });

  it("skips existing files unless forced", () => {
    fs.writeFileSync(path.join(dir, "BRAIN.md"), "custom");
    const result = initVault(dir, { name: "X" });
    expect(result.skipped).toContain("BRAIN.md");
    expect(fs.readFileSync(path.join(dir, "BRAIN.md"), "utf8")).toBe("custom");
  });
});

describe("Vault notes", () => {
  it("creates, resolves by title/alias/path case-insensitively", () => {
    vault.createNote({
      title: "RTB Basics",
      tags: ["adtech"],
      body: "Real-time bidding.",
      frontmatter: { aliases: ["OpenRTB"] },
    });
    expect(vault.get("rtb basics")?.path).toBe("notes/RTB Basics.md");
    expect(vault.get("openrtb")?.path).toBe("notes/RTB Basics.md");
    expect(vault.get("notes/RTB Basics.md")?.title).toBe("RTB Basics");
    expect(vault.get("nope")).toBeUndefined();
  });

  it("refuses to overwrite without the flag", () => {
    vault.createNote({ title: "Dup" });
    expect(() => vault.createNote({ title: "Dup" })).toThrow(/already exists/);
    expect(() => vault.createNote({ title: "Dup", overwrite: true })).not.toThrow();
  });

  it("appends under a heading, creating it when missing", () => {
    vault.createNote({ title: "Doc", body: "## Log\n\n- first\n\n## Other\n\ntail" });
    vault.appendToNote("Doc", "- second", "Log");
    const body = vault.get("Doc")!.body;
    expect(body.indexOf("- second")).toBeGreaterThan(body.indexOf("- first"));
    expect(body.indexOf("- second")).toBeLessThan(body.indexOf("## Other"));
    vault.appendToNote("Doc", "content", "Brand New");
    expect(vault.get("Doc")!.body).toContain("## Brand New");
  });

  it("preserves appends made through stale vault instances", () => {
    vault.createNote({ title: "Shared", body: "start" });
    const firstWriter = new Vault(dir);
    const secondWriter = new Vault(dir);

    firstWriter.appendToNote("Shared", "from first");
    secondWriter.appendToNote("Shared", "from second");

    const body = new Vault(dir).get("Shared")!.body;
    expect(body).toContain("from first");
    expect(body).toContain("from second");
  });

  it("preserves frontmatter changes made through stale vault instances", () => {
    vault.createNote({ title: "Shared Metadata", frontmatter: { status: "active" } });
    const firstWriter = new Vault(dir);
    const secondWriter = new Vault(dir);

    firstWriter.updateFrontmatter("Shared Metadata", { priority: "high" });
    secondWriter.updateFrontmatter("Shared Metadata", { area: "work" });

    const fm = new Vault(dir).get("Shared Metadata")!.frontmatter;
    expect(fm).toMatchObject({ status: "active", priority: "high", area: "work" });
  });

  it("keeps the original note and releases its lock when a mutation fails", () => {
    vault.createNote({ title: "Recoverable", body: "original" });

    expect(() =>
      vault.mutateNote("Recoverable", "broken mutation", () => {
        throw new Error("mutation failed");
      }),
    ).toThrow("mutation failed");

    expect(new Vault(dir).get("Recoverable")!.body).toContain("original");
    expect(() => vault.appendToNote("Recoverable", "after failure")).not.toThrow();
    expect(new Vault(dir).get("Recoverable")!.body).toContain("after failure");
  });

  it("keeps the original note when its atomic replacement fails", () => {
    vault.createNote({ title: "Atomic", body: "original" });
    const file = path.join(dir, "notes", "Atomic.md");
    const original = fs.readFileSync(file, "utf8");
    vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("rename failed");
    });

    expect(() => vault.appendToNote("Atomic", "should not land")).toThrow("rename failed");

    expect(fs.readFileSync(file, "utf8")).toBe(original);
    expect(fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("updates and deletes frontmatter keys", () => {
    vault.createNote({ title: "FM", frontmatter: { status: "active", area: "work" } });
    vault.updateFrontmatter("FM", { status: "paused", area: null, extra: 5 });
    const fm = vault.get("FM")!.frontmatter;
    expect(fm.status).toBe("paused");
    expect(fm.extra).toBe(5);
    expect("area" in fm).toBe(false);
  });

  it("archives non-destructively and hides archived notes by default", () => {
    vault.createNote({ title: "Old Thing", body: "keep me" });
    const archived = vault.archiveNote("Old Thing");
    expect(archived.path).toBe("archive/notes/Old Thing.md");
    expect(vault.notes().some((n) => n.title === "Old Thing")).toBe(false);
    expect(vault.notes(true).some((n) => n.title === "Old Thing")).toBe(true);
  });

  it("computes backlinks through aliases", () => {
    vault.createNote({ title: "Hub", frontmatter: { aliases: ["The Hub"] } });
    vault.createNote({ title: "Spoke", body: "Points at [[The Hub]]." });
    expect(vault.backlinks("Hub").map((n) => n.title)).toEqual(["Spoke"]);
  });

  it("searches with filters and picks up external edits on refresh", () => {
    vault.createNote({ title: "Kubernetes Notes", tags: ["infra"], body: "pods and nodes" });
    vault.createNote({ title: "Cooking", body: "pasta pods? no. kubernetes no." });
    const hits = vault.search("kubernetes", { tag: "infra" });
    expect(hits.map((h) => h.title)).toEqual(["Kubernetes Notes"]);

    const abs = path.join(dir, "notes", "Cooking.md");
    fs.writeFileSync(abs, fs.readFileSync(abs, "utf8").replace("pasta", "quantum"));
    fs.utimesSync(abs, new Date(), new Date(Date.now() + 5000));
    vault.refresh();
    expect(vault.search("quantum").map((h) => h.title)).toEqual(["Cooking"]);
  });
});

describe("write safety", () => {
  it("refuses folders that escape the vault", () => {
    for (const folder of ["../outside", "notes/../../outside", "/tmp/outside"]) {
      expect(() => vault.createNote({ title: "Escape", folder })).toThrow(/vault/);
    }
    expect(fs.existsSync(path.join(dir, "..", "outside"))).toBe(false);
  });

  it("adds a numeric suffix on collision when unique is set", () => {
    const first = vault.createNote({ title: "Same", folder: "inbox", unique: true });
    const second = vault.createNote({ title: "Same", folder: "inbox", unique: true });
    expect(first.path).toBe("inbox/Same.md");
    expect(second.path).toBe("inbox/Same 2.md");
    expect(() => vault.createNote({ title: "Same", folder: "inbox" })).toThrow(/already exists/);
  });

  it("preserves hand-written dates through a frontmatter update", () => {
    const file = path.join(dir, "notes", "Dated.md");
    fs.writeFileSync(file, "---\ncreated: 2026-01-05\n---\n\nbody\n");
    vault.refresh();
    vault.updateFrontmatter("Dated", { status: "active" });
    const raw = fs.readFileSync(file, "utf8");
    expect(raw).toContain("created: 2026-01-05\n");
    expect(raw).not.toContain("T00:00:00");
  });

  it("sees an external edit even when the mtime is preserved", () => {
    const note = vault.createNote({ title: "Synced", body: "old" });
    const before = fs.statSync(note.absPath);
    fs.writeFileSync(note.absPath, "---\ntype: note\n---\n\nnew content here\n");
    fs.utimesSync(note.absPath, before.atime, before.mtime);
    vault.refresh();
    expect(vault.get("Synced")?.body).toContain("new content here");
  });
});

describe("CRLF and lookups", () => {
  it("edits CRLF notes in place and keeps their line endings", () => {
    const file = path.join(dir, "projects", "Win.md");
    fs.writeFileSync(
      file,
      "---\r\ntype: project\r\nstatus: active\r\n---\r\n\r\n## Tasks\r\n\r\n- [ ] ship\r\n\r\n## Log\r\n",
    );
    vault.refresh();
    addTask(vault, { text: "test", note: "Win" });
    completeTask(vault, "ship");
    vault.appendToNote("Win", "- did a thing", "Log");
    const raw = fs.readFileSync(file, "utf8");
    expect(raw.replace(/\r\n/g, "")).not.toContain("\n"); // every newline is still CRLF
    expect(raw).toMatch(/## Tasks\r\n\r\n- \[x\] ship ✅ \d{4}-\d{2}-\d{2}\r\n- \[ \] test\r\n/);
    expect(raw.match(/## Log/g)).toHaveLength(1); // appended under the existing heading
  });

  it("writes a mostly-LF note with one stray CRLF back as LF", () => {
    const file = path.join(dir, "projects", "Mixed.md");
    fs.writeFileSync(file, "---\ntype: project\n---\n\n## Tasks\r\n\n- [ ] one\n- [ ] two\n");
    vault.refresh();
    completeTask(vault, "one");
    expect(fs.readFileSync(file, "utf8")).not.toContain("\r\n- [");
  });

  it("resolves names after creates, renames, and archives", () => {
    vault.createNote({ title: "Lookup Target", frontmatter: { aliases: ["LT"] } });
    expect(vault.get("lt")?.path).toBe("notes/Lookup Target.md");
    vault.updateFrontmatter("Lookup Target", { aliases: ["Renamed Alias"] });
    expect(vault.get("LT")).toBeUndefined();
    expect(vault.get("renamed alias")?.path).toBe("notes/Lookup Target.md");
    vault.archiveNote("Lookup Target");
    expect(vault.get("Lookup Target")?.archived).toBe(true);
    vault.createNote({ title: "Lookup Target" });
    expect(vault.get("Lookup Target")?.archived).toBe(false); // live note wins
  });

  it("re-indexes search when a note is reparsed without an mtime change", () => {
    // Vault reparses on ctime/size changes too; the search index must follow
    // the parsed note, not its mtime.
    const parseAt = (body: string) =>
      parseNote({
        relPath: "notes/S.md",
        absPath: path.join(dir, "notes", "S.md"),
        raw: `---\ntype: note\n---\n\n${body}\n`,
        mtimeMs: 1000,
        folderTypes: {},
        archiveFolder: "archive",
      });
    const index = new SearchIndex();
    const before = new Map([["notes/S.md", parseAt("alpha")]]);
    index.sync(before);
    const after = new Map([["notes/S.md", parseAt("zebracorn appears")]]);
    index.sync(after);
    expect(index.search("zebracorn", after).map((r) => r.path)).toEqual(["notes/S.md"]);
    expect(index.search("alpha", after)).toHaveLength(0);
  });
});

describe("projects and tasks", () => {
  it("full project lifecycle with tasks", () => {
    createProject(vault, { title: "Ship v1", goal: "Launch", area: "work" });
    const t1 = addTask(vault, { text: "Write tests", note: "Ship v1", due: "2026-01-02" });
    addTask(vault, { text: "Deploy", note: "Ship v1", priority: "high" });

    let projects = listProjects(vault, { status: "active" });
    expect(projects).toHaveLength(2); // starter project + Ship v1
    const ship = projects.find((p) => p.title === "Ship v1")!;
    expect(ship.openTasks).toBe(2);
    expect(ship.nextTasks[0]!.text).toBe("Write tests"); // dated before undated

    const done = completeTask(vault, t1.id);
    expect(done.task.done).toBe(true);
    const raw = fs.readFileSync(path.join(dir, "projects", "Ship v1.md"), "utf8");
    expect(raw).toMatch(/- \[x\] Write tests 📅 2026-01-02 ✅ \d{4}-\d{2}-\d{2}/);

    setProjectStatus(vault, "Ship v1", "done");
    projects = listProjects(vault, { status: "done" });
    expect(projects.map((p) => p.title)).toEqual(["Ship v1"]);
    expect(vault.get("Ship v1")!.frontmatter.completed).toBe(todayISO());
  });

  it("completes by unique text fragment and rejects ambiguity", () => {
    createProject(vault, { title: "P" });
    addTask(vault, { text: "unique task alpha", note: "P" });
    addTask(vault, { text: "twin task", note: "P" });
    addTask(vault, { text: "twin task again", note: "P" });
    expect(() => completeTask(vault, "twin task")).toThrow(/Ambiguous/);
    expect(completeTask(vault, "alpha").task.text).toBe("unique task alpha");
  });

  it("lists tasks with dueBy filter", () => {
    createProject(vault, { title: "Q" });
    addTask(vault, { text: "soon", note: "Q", due: "2026-01-05" });
    addTask(vault, { text: "later", note: "Q", due: "2026-06-05" });
    addTask(vault, { text: "whenever", note: "Q" });
    const due = listTasks(vault, { dueBy: "2026-02-01" });
    expect(due.map((t) => t.text)).toEqual(["soon"]);
  });

  it("rejects multiline task text and impossible due dates", () => {
    createProject(vault, { title: "R" });
    expect(() => addTask(vault, { text: "one\n- [ ] two", note: "R" })).toThrow(/single line/);
    expect(() => addTask(vault, { text: "x", note: "R", due: "2026-02-30" })).toThrow(/due date/);
    expect(listTasks(vault, { project: "R" })).toHaveLength(0);
  });

  it("updates a task in place: reschedule, reprioritize, reword, keep other metadata", () => {
    createProject(vault, { title: "U" });
    vault.appendToNote(
      "U",
      "- [ ] ship it #work ⏫ ⏳ 2026-01-01 📅 2026-01-10\n- [ ] untouched",
      "Tasks",
    );
    const file = path.join(dir, "projects", "U.md");
    const original = listTasks(vault, { project: "U" }).find((t) => t.text.startsWith("ship"))!;

    const moved = updateTask(vault, original.id, { due: "2026-02-01", priority: "low" });
    expect(moved.task).toMatchObject({
      due: "2026-02-01",
      priority: "low",
      scheduled: "2026-01-01",
    });
    expect(moved.task.id).toBe(original.id);

    const reworded = updateTask(vault, original.id, { text: "ship v2 #work", due: null });
    expect(reworded.task).toMatchObject({ text: "ship v2 #work", priority: "low", due: undefined });
    expect(reworded.task.scheduled).toBe("2026-01-01");
    expect(reworded.previousId).toBe(original.id);
    expect(reworded.task.id).not.toBe(original.id);
    expect(fs.readFileSync(file, "utf8")).toContain("- [ ] untouched");
  });

  it("reopens, cancels, and completes via status", () => {
    createProject(vault, { title: "V" });
    const t = addTask(vault, { text: "flip me", note: "V", due: "2026-03-01" });
    completeTask(vault, t.id);
    const reopened = updateTask(vault, t.id, { status: "open" });
    expect(reopened.task).toMatchObject({ done: false, completedOn: undefined, due: "2026-03-01" });
    expect(reopened.task.raw).not.toContain("✅");

    const cancelled = updateTask(vault, "flip me", { status: "cancelled" });
    expect(cancelled.task).toMatchObject({ cancelled: true, done: false });
    expect(listTasks(vault, { project: "V" })).toHaveLength(0);

    const done = updateTask(vault, t.id, { status: "done" });
    expect(done.task).toMatchObject({ done: true, completedOn: todayISO() });
    expect(done.task.raw.match(/✅/gu)).toHaveLength(1);
  });

  it("keeps VS16-styled metadata when rewording", () => {
    createProject(vault, { title: "X" });
    vault.appendToNote("X", "- [ ] old words \u{1F4C5}\uFE0F 2026-01-10", "Tasks");
    const [t] = listTasks(vault, { project: "X" });
    const result = updateTask(vault, t!.id, { text: "new words" });
    expect(result.task).toMatchObject({ text: "new words", due: "2026-01-10" });
  });

  it("refuses to complete a task that was completed after it was listed", () => {
    createProject(vault, { title: "Y" });
    const t = addTask(vault, { text: "race me", note: "Y" });
    const file = path.join(dir, "projects", "Y.md");
    const realMutate = vault.mutateNote.bind(vault);
    vi.spyOn(vault, "mutateNote").mockImplementationOnce((ref, op, mutate) => {
      // Another writer completes the task between listing and locking.
      fs.writeFileSync(
        file,
        fs.readFileSync(file, "utf8").replace("- [ ] race me", "- [x] race me ✅ 2026-01-01"),
      );
      return realMutate(ref, op, mutate);
    });
    expect(() => completeTask(vault, t.id)).toThrow(/changed before/);
    expect(fs.readFileSync(file, "utf8")).toContain("✅ 2026-01-01");
  });

  it("rejects empty, multiline, and invalid updates", () => {
    createProject(vault, { title: "W" });
    const t = addTask(vault, { text: "guarded", note: "W" });
    expect(() => updateTask(vault, t.id, {})).toThrow(/Nothing to update/);
    expect(() => updateTask(vault, t.id, { text: "a\n- [ ] b" })).toThrow(/single line/);
    expect(() => updateTask(vault, t.id, { text: "  " })).toThrow(/empty/);
    expect(() => updateTask(vault, t.id, { due: "2026-02-30" })).toThrow(/due date/);
    expect(() => updateTask(vault, "no such task", { status: "done" })).toThrow(/No task matches/);
    expect(listTasks(vault, { project: "W" })[0]!.raw).toBe("- [ ] guarded");
  });

  it("keeps cancelled tasks out of the open list", () => {
    createProject(vault, { title: "S" });
    vault.appendToNote("S", "- [-] abandoned\n- [ ] still open", "Tasks");
    expect(listTasks(vault, { project: "S" }).map((t) => t.text)).toEqual(["still open"]);
    expect(listTasks(vault, { project: "S", status: "all" })).toHaveLength(2);
  });
});

describe("daily notes", () => {
  it("creates from template and logs timestamped entries", () => {
    const note = getDailyNote(vault, "2026-07-07");
    expect(note.path).toBe("daily/2026-07-07.md");
    expect(note.body).toContain("## Log");
    logToDaily(vault, "made a decision", "2026-07-07");
    expect(vault.get("daily/2026-07-07.md")!.body).toMatch(/- \d{4}-.* — made a decision/);
    // idempotent get
    expect(getDailyNote(vault, "2026-07-07").path).toBe("daily/2026-07-07.md");
  });
});

describe("doctor and overview", () => {
  it("flags broken links, duplicate names, and overdue tasks", () => {
    vault.createNote({ title: "Linker", body: "[[Does Not Exist]]" });
    vault.createNote({ title: "Twin", folder: "notes" });
    vault.createNote({ title: "Twin", folder: "reference" });
    createProject(vault, { title: "Late" });
    addTask(vault, { text: "way overdue", note: "Late", due: "2020-01-01" });
    const rules = runDoctor(vault).map((f) => f.rule);
    expect(rules).toContain("broken-link");
    expect(rules).toContain("duplicate-name");
    expect(rules).toContain("overdue-task");
  });

  it("builds an overview with stats and overdue buckets", () => {
    createProject(vault, { title: "Ov", goal: "g" });
    addTask(vault, { text: "past", note: "Ov", due: "2020-01-01" });
    const o = vaultOverview(vault);
    expect(o.name).toBe("Test Brain");
    expect(o.stats.projects).toBeGreaterThanOrEqual(2);
    expect(o.overdueTasks.map((t) => t.text)).toContain("past");
    expect(o.activeProjects.map((p) => p.title)).toContain("Ov");
  });
});

describe("frontmatter and section boundaries", () => {
  const write = (rel: string, raw: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), raw);
    vault.refresh();
  };
  const read = (rel: string) => fs.readFileSync(path.join(dir, rel), "utf8");

  it("appends under a heading in a BOM-prefixed note without touching the YAML", () => {
    write("notes/Bom.md", "﻿---\ntype: note\n---\n## Tasks\nold\n## Next\nend\n");
    vault.appendToNote("notes/Bom.md", "insert", "Tasks");
    expect(read("notes/Bom.md")).toBe(
      "﻿---\ntype: note\n---\n## Tasks\nold\ninsert\n## Next\nend\n",
    );
  });

  it("appends into the right section when the frontmatter is malformed", () => {
    write("notes/Bad.md", "---\ntitle: a: b\n---\n## Log\n\nold\n\n## Other\n\nx\n");
    vault.appendToNote("notes/Bad.md", "NEW", "Log");
    expect(read("notes/Bad.md")).toBe(
      "---\ntitle: a: b\n---\n## Log\n\nold\nNEW\n\n## Other\n\nx\n",
    );
  });

  it("does not treat a heading inside a ~~~ fence as a section", () => {
    write(
      "notes/Fence.md",
      "# Fence\n\n## Log\n\n~~~bash\n# a comment\n~~~\n\nend of log\n\n## Next\n",
    );
    vault.appendToNote("notes/Fence.md", "NEW", "Log");
    expect(read("notes/Fence.md")).toBe(
      "# Fence\n\n## Log\n\n~~~bash\n# a comment\n~~~\n\nend of log\nNEW\n\n## Next\n",
    );
    vault.appendToNote("notes/Fence.md", "made", "a comment");
    expect(read("notes/Fence.md")).toMatch(/## Next\n\n## a comment\n\nmade\n$/);
  });

  it("refuses to rewrite the body or frontmatter of a note whose YAML doesn't parse", () => {
    const raw = "---\ntags: [broken\n---\nbody\n";
    write("notes/Broken.md", raw);
    expect(() => vault.replaceBody("notes/Broken.md", "replacement")).toThrow(
      /malformed frontmatter/,
    );
    expect(() => vault.updateFrontmatter("notes/Broken.md", { status: "x" })).toThrow(
      /malformed frontmatter/,
    );
    expect(read("notes/Broken.md")).toBe(raw);
  });

  it("keeps the text of a note that opens with a --- rule and never closes it", () => {
    write("notes/Rule.md", "---\nMeeting notes after a rule\n\n- [ ] follow up\n");
    expect(vault.get("notes/Rule.md")!.body).toContain("Meeting notes");
    vault.updateFrontmatter("notes/Rule.md", { status: "active" });
    const raw = read("notes/Rule.md");
    expect(raw).toContain("status: active");
    expect(raw).toContain("Meeting notes after a rule");
    expect(raw).toContain("- [ ] follow up");
  });

  it("does not list checkboxes inside a frontmatter block scalar as tasks", () => {
    write("notes/Fm.md", "---\nexample: |\n  - [ ] sample\n---\n- [ ] real\n");
    const tasks = vault.get("notes/Fm.md")!.tasks;
    expect(tasks.map((t) => [t.text, t.line])).toEqual([["real", 4]]);
    completeTask(vault, tasks[0]!.id);
    expect(read("notes/Fm.md")).toMatch(
      /^---\nexample: \|\n {2}- \[ \] sample\n---\n- \[x\] real ✅/,
    );
  });

  it("completes a task on a CRLF line in a mostly-LF note", () => {
    write("notes/Mixed.md", "intro\n\n- [ ] mixed\r\n\nend\n");
    const [task] = vault.get("notes/Mixed.md")!.tasks;
    expect(completeTask(vault, task!.id).task.done).toBe(true);
    expect(read("notes/Mixed.md")).toMatch(
      /^intro\n\n- \[x\] mixed ✅ \d{4}-\d{2}-\d{2}\n\nend\n$/,
    );
  });
});

describe("duplicate task texts", () => {
  it("returns the task that was just added, not an older one with the same text", () => {
    createProject(vault, { title: "Dup" });
    const first = addTask(vault, { text: "same", note: "Dup" });
    const second = addTask(vault, { text: "same", note: "Dup" });
    expect(second.id).not.toBe(first.id);
    expect(second.line).toBe(first.line + 1);
  });

  it("refuses to complete a duplicate whose line changed after it was matched", () => {
    const rel = "notes/Twins.md";
    const abs = path.join(dir, rel);
    fs.writeFileSync(abs, "- [ ] same 📅 2026-10-11\n- [ ] same 📅 2026-10-12\n");
    vault.refresh();
    const first = vault.get(rel)!.tasks[0]!;
    // Another editor deletes the first copy after the task was matched but
    // before the write: the second copy now carries the matched id.
    const mutate = vault.mutateNote.bind(vault);
    vi.spyOn(vault, "mutateNote").mockImplementation((ref, operation, fn) => {
      fs.writeFileSync(abs, "- [ ] same 📅 2026-10-12\n");
      return mutate(ref, operation, fn);
    });
    expect(() => completeTask(vault, first.id)).toThrow(/changed before it could be updated/);
    expect(fs.readFileSync(abs, "utf8")).toBe("- [ ] same 📅 2026-10-12\n");
  });
});

describe("write paths stay inside a visible vault", () => {
  it("refuses a hidden title or ignored folder without leaving a file behind", () => {
    expect(() => vault.createNote({ title: ".idea", body: "thought" })).toThrow(/hidden/);
    expect(fs.existsSync(path.join(dir, "notes", ".idea.md"))).toBe(false);
    expect(() => vault.createNote({ title: "Sneaky", folder: "templates" })).toThrow(/hidden/);
    expect(fs.existsSync(path.join(dir, "templates", "Sneaky.md"))).toBe(false);
  });

  it("restores an ignored file that an overwrite would have replaced", () => {
    const tpl = path.join(dir, "templates", "daily.md");
    const before = fs.readFileSync(tpl, "utf8");
    expect(() =>
      vault.createNote({ title: "daily", folder: "templates", overwrite: true }),
    ).toThrow(/hidden/);
    expect(fs.readFileSync(tpl, "utf8")).toBe(before);
  });

  it("creates a long CJK title within the filesystem's byte limit", () => {
    const note = vault.createNote({ title: "漢".repeat(100), body: "x" });
    expect(Buffer.byteLength(path.basename(note.path))).toBeLessThanOrEqual(255);
    expect(vault.get(note.path)?.body).toContain("x");
  });

  it("edits a note whose filename is near the 255-byte limit", () => {
    const name = `${"a".repeat(240)}.md`;
    fs.writeFileSync(path.join(dir, "notes", name), "# Long\n");
    vault.refresh();
    vault.appendToNote(`notes/${name}`, "more");
    expect(fs.readFileSync(path.join(dir, "notes", name), "utf8")).toBe("# Long\n\nmore\n");
  });

  it("skips a note deleted between the scan and the read", () => {
    vault.createNote({ title: "Keeper" });
    fs.writeFileSync(path.join(dir, "notes", "Gone.md"), "# Gone\n");
    const real = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, ...rest) => {
      if (String(file).endsWith("Gone.md")) {
        throw Object.assign(new Error("ENOENT: gone"), { code: "ENOENT" });
      }
      return real(file, ...(rest as [BufferEncoding]));
    }) as typeof fs.readFileSync);
    expect(() => vault.refresh()).not.toThrow();
    expect(vault.get("Gone")).toBeUndefined();
    expect(vault.get("Keeper")).toBeDefined();
  });

  it("refuses writes through a symlink that leaves the vault", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "bb-outside-"));
    try {
      fs.writeFileSync(path.join(outside, "Secret.md"), "private\n");
      fs.symlinkSync(outside, path.join(dir, "notes", "ext"));
      vault.refresh();
      expect(() => vault.createNote({ title: "Leak", folder: "notes/ext" })).toThrow(
        /outside the vault/,
      );
      expect(() => vault.appendToNote("notes/ext/Secret.md", "changed")).toThrow(
        /outside the vault/,
      );
      expect(fs.readdirSync(outside)).toEqual(["Secret.md"]);
      expect(fs.readFileSync(path.join(outside, "Secret.md"), "utf8")).toBe("private\n");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses an archive folder outside the vault and leaves the note in place", () => {
    vault.createNote({ title: "Stay" });
    vault.config.folders.archive = "../escaped";
    expect(() => vault.archiveNote("Stay")).toThrow(/inside the vault/);
    expect(fs.existsSync(path.join(dir, "notes", "Stay.md"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "..", "escaped"))).toBe(false);
  });

  it("refuses a hidden archive folder before moving anything", () => {
    vault.createNote({ title: "Back" });
    vault.config.folders.archive = ".archive";
    expect(() => vault.archiveNote("Back")).toThrow(/hidden from the vault/);
    expect(fs.existsSync(path.join(dir, ".archive"))).toBe(false);
    expect(vault.get("Back")?.path).toBe("notes/Back.md");
  });

  it("puts the note back when an ignore glob hides the archive folder", () => {
    vault.createNote({ title: "Back" });
    vault.config.folders.archive = "old";
    vault.config.ignore = ["old/**"];
    expect(() => vault.archiveNote("Back")).toThrow(/note left in place/);
    expect(vault.get("Back")?.path).toBe("notes/Back.md");
    expect(fs.existsSync(path.join(dir, "old", "notes", "Back.md"))).toBe(false);
  });

  it("undoes a create hidden by an ignore glob, but not someone else's write", () => {
    vault.config.ignore = ["private/**"];
    expect(() => vault.createNote({ title: "Mine", folder: "private" })).toThrow(/ignored/);
    expect(fs.existsSync(path.join(dir, "private", "Mine.md"))).toBe(false);

    // An editor saves to the same path between our write and the undo.
    const reload = vi.spyOn(vault as unknown as { reloadPath: () => unknown }, "reloadPath");
    reload.mockImplementationOnce(() => {
      fs.writeFileSync(path.join(dir, "private", "Theirs.md"), "editor's text\n");
      return undefined;
    });
    expect(() => vault.createNote({ title: "Theirs", folder: "private" })).toThrow(/ignored/);
    expect(fs.readFileSync(path.join(dir, "private", "Theirs.md"), "utf8")).toBe("editor's text\n");
  });

  it("skips a colliding directory when creating a unique note", () => {
    fs.mkdirSync(path.join(dir, "inbox", "Dir.md"));
    expect(vault.createNote({ title: "Dir", folder: "inbox", unique: true }).path).toBe(
      "inbox/Dir 2.md",
    );
  });

  it("re-checks containment under the lock, after a folder is swapped for a link", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "bb-outside-"));
    try {
      fs.mkdirSync(path.join(dir, "safe"));
      fs.writeFileSync(path.join(dir, "safe", "A.md"), "inside\n");
      fs.writeFileSync(path.join(outside, "A.md"), "outside\n");
      fs.symlinkSync(path.join(dir, "safe"), path.join(dir, "notes", "link"));
      vault.refresh();
      expect(() =>
        vault.mutateNote("notes/link/A.md", "append", (note) => {
          // Retarget the link while this write holds the lock.
          fs.unlinkSync(path.join(dir, "notes", "link"));
          fs.symlinkSync(outside, path.join(dir, "notes", "link"));
          return `${note.raw}escaped\n`;
        }),
      ).toThrow(/outside the vault/);
      expect(fs.readFileSync(path.join(outside, "A.md"), "utf8")).toBe("outside\n");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("note locks", () => {
  const lockFor = (rel: string) =>
    path.join(dir, ".bigbrain", "locks", `${createHash("sha256").update(rel).digest("hex")}.lock`);
  const plantLock = (rel: string, token: string) => {
    const file = lockFor(rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, token);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(file, old, old);
  };

  it("reclaims an old lock whose owner process is gone", () => {
    plantLock("notes/A.md", "999999999:dead");
    expect(withNoteLock(dir, "notes/A.md", () => "ran")).toBe("ran");
  });

  it("waits out an old lock whose owner is still running", () => {
    plantLock("notes/B.md", `${process.pid}:alive`);
    // Advance the clock a second per call so the 5s wait ends quickly.
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => {
      now += 1000;
      return now;
    });
    expect(() => withNoteLock(dir, "notes/B.md", () => "ran")).toThrow(/Timed out/);
    expect(fs.existsSync(lockFor("notes/B.md"))).toBe(true);
  });
});
