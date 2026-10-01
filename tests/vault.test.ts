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
