import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initVault } from "../src/core/scaffold.js";
import { addTask, completeTask } from "../src/core/tasks.js";
import { Vault } from "../src/core/vault.js";

let dir: string;

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

function commitCount(): number {
  try {
    return Number(git(["rev-list", "--count", "HEAD"]).trim());
  } catch {
    return 0; // no commits yet
  }
}

function writeConfig(autoCommit: boolean): void {
  fs.writeFileSync(
    path.join(dir, "brain.config.json"),
    JSON.stringify(
      {
        name: "Git Test",
        git: { autoCommit, autoPush: false, authorName: "Test", authorEmail: "t@example.com" },
      },
      null,
      2,
    ),
  );
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-git-"));
  initVault(dir, { name: "Git Test" });
  git(["init", "-q", "-b", "main"]);
  git(["add", "-A"]);
  git(["-c", "user.name=Seed", "-c", "user.email=s@example.com", "commit", "-q", "-m", "init"]);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("auto-commit", () => {
  it("commits after each write when enabled", () => {
    writeConfig(true);
    const vault = new Vault(dir);
    const before = commitCount();

    vault.createNote({ title: "Note One", body: "hello" });
    expect(commitCount()).toBe(before + 1);

    vault.appendToNote("Note One", "more text");
    expect(commitCount()).toBe(before + 2);

    // Working tree is clean after each auto-commit.
    expect(git(["status", "--porcelain"]).trim()).toBe("");

    const last = git(["log", "-1", "--pretty=%s"]).trim();
    expect(last).toBe("big-brain: append notes/Note One.md");
    expect(git(["log", "-1", "--pretty=%an"]).trim()).toBe("Test");
  });

  it("commits on task completion (a direct-write path)", () => {
    writeConfig(true);
    const vault = new Vault(dir);
    vault.createNote({ title: "Proj", type: "project", body: "## Tasks" });
    addTask(vault, { text: "do the thing", note: "Proj" });
    const before = commitCount();
    completeTask(vault, "do the thing");
    expect(commitCount()).toBe(before + 1);
    expect(git(["log", "-1", "--pretty=%s"]).trim()).toMatch(/^big-brain: complete task/);
  });

  it("does nothing when disabled — leaves changes uncommitted", () => {
    writeConfig(false);
    const vault = new Vault(dir);
    const before = commitCount();
    vault.createNote({ title: "Uncommitted", body: "x" });
    expect(commitCount()).toBe(before);
    expect(git(["status", "--porcelain"]).trim()).not.toBe("");
  });

  it("never throws when the vault is not a git repo", () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "bb-nogit-"));
    try {
      fs.writeFileSync(
        path.join(plain, "brain.config.json"),
        JSON.stringify({ name: "NoGit", git: { autoCommit: true, autoPush: false } }),
      );
      const vault = new Vault(plain);
      // Should complete without throwing despite there being no .git directory.
      expect(() => vault.createNote({ title: "Fine", body: "y" })).not.toThrow();
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});
