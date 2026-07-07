import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDailyNote, logToDaily } from "../src/core/daily.js";
import { runDoctor } from "../src/core/doctor.js";
import { vaultOverview } from "../src/core/overview.js";
import { createProject, listProjects, setProjectStatus } from "../src/core/projects.js";
import { initVault } from "../src/core/scaffold.js";
import { addTask, completeTask, listTasks } from "../src/core/tasks.js";
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
