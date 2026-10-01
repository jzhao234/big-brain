import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDailyNote } from "../src/core/daily.js";
import { createProject, listProjects, setProjectStatus } from "../src/core/projects.js";
import { initVault } from "../src/core/scaffold.js";
import { safeFilename } from "../src/core/util.js";
import { Vault } from "../src/core/vault.js";

let dir: string;
let vault: Vault;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-project-daily-test-"));
  initVault(dir, { name: "Project and Daily Test" });
  vault = new Vault(dir);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("projects", () => {
  it("inserts template values literally, including dollar replacement tokens", () => {
    fs.writeFileSync(
      path.join(dir, "templates", "project.md"),
      "## Goal\n\n{{goal}}\n\n## Title\n\n{{title}}\n",
    );
    const goal = "Keep $& and $` and $' and $$ literally.";
    const title = "Project $& stays literal";

    const project = createProject(vault, { title, goal });

    expect(project.body).toContain(goal);
    expect(project.body).toContain(title);
  });

  it("does not count cancelled tasks as done and clears completion when reopened", () => {
    const project = createProject(vault, { title: "Lifecycle" });
    vault.appendToNote(
      project.path,
      "- [ ] open task\n- [x] finished task ✅ 2026-01-01\n- [-] cancelled task",
      "Tasks",
    );

    const summary = listProjects(vault)[0]!;
    expect(summary.openTasks).toBe(1);
    expect(summary.doneTasks).toBe(1);

    setProjectStatus(vault, project.path, "done");
    expect(vault.get(project.path)?.frontmatter.completed).toBeDefined();
    const reopened = setProjectStatus(vault, project.path, "active");
    expect(reopened.frontmatter.completed).toBeUndefined();
  });
});

describe("daily notes", () => {
  it("returns the note created by another stale vault instance", () => {
    const firstVault = new Vault(dir);
    const secondVault = new Vault(dir);

    const first = getDailyNote(firstVault, "2026-10-01");
    const second = getDailyNote(secondVault, "2026-10-01");

    expect(second.path).toBe(first.path);
    expect(second.raw).toBe(first.raw);
  });
});

describe("safe filenames", () => {
  it("does not truncate inside a surrogate pair", () => {
    const title = `${"a".repeat(119)}😀tail`;

    expect(safeFilename(title)).toBe("a".repeat(119));
  });
});
