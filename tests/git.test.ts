import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { autoCommit, settlePushes } from "../src/core/git.js";
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

function writeConfig(autoCommit: boolean, autoPush = false): void {
  fs.writeFileSync(
    path.join(dir, "brain.config.json"),
    JSON.stringify(
      {
        name: "Git Test",
        git: { autoCommit, autoPush, authorName: "Test", authorEmail: "t@example.com" },
      },
      null,
      2,
    ),
  );
}

function enableAutoCommit(autoPush = false): void {
  writeConfig(true, autoPush);
  git(["add", "brain.config.json"]);
  git([
    "-c",
    "user.name=Seed",
    "-c",
    "user.email=s@example.com",
    "commit",
    "-q",
    "-m",
    "enable auto-commit",
  ]);
}

function committedPaths(): string[] {
  return git(["show", "--format=", "--name-only", "--no-renames", "HEAD"])
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort();
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
    enableAutoCommit();
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

  it("commits only touched paths and preserves unrelated staged and unstaged work", () => {
    enableAutoCommit();
    fs.appendFileSync(path.join(dir, "BRAIN.md"), "\nmanual tracked edit\n");
    git(["add", "BRAIN.md"]);
    fs.writeFileSync(path.join(dir, "notes", "Manual.md"), "manual untracked note\n");
    const vault = new Vault(dir);

    vault.createNote({ title: "Tool Write", body: "created by the tool" });

    expect(committedPaths()).toEqual(["notes/Tool Write.md"]);
    const status = git(["status", "--porcelain"]);
    expect(status).toContain("M  BRAIN.md");
    expect(status).toContain("?? notes/Manual.md");
  });

  it("commits both sides of an archive move without sweeping unrelated work", () => {
    enableAutoCommit();
    const vault = new Vault(dir);
    vault.createNote({ title: "Archive Me", body: "keep this" });
    fs.appendFileSync(path.join(dir, "BRAIN.md"), "\nmanual edit\n");

    vault.archiveNote("Archive Me");

    expect(committedPaths()).toEqual(["archive/notes/Archive Me.md", "notes/Archive Me.md"]);
    expect(git(["status", "--porcelain"])).toContain(" M BRAIN.md");
  });

  it("treats touched filenames as literal git pathspecs", () => {
    const literal = path.join(dir, "notes", "[literal].md");
    const patternMatch = path.join(dir, "notes", "l.md");
    fs.writeFileSync(literal, "literal note\n");
    fs.writeFileSync(patternMatch, "other note\n");
    git(["add", "notes/[literal].md", "notes/l.md"]);
    git([
      "-c",
      "user.name=Seed",
      "-c",
      "user.email=s@example.com",
      "commit",
      "-q",
      "-m",
      "seed unusual filenames",
    ]);
    enableAutoCommit();
    fs.appendFileSync(patternMatch, "unrelated edit\n");
    const vault = new Vault(dir);

    vault.appendToNote("notes/[literal].md", "tool edit");

    expect(committedPaths()).toEqual(["notes/[literal].md"]);
    expect(git(["status", "--porcelain"])).toContain(" M notes/l.md");
  });

  it("does not commit anything when callers omit touched paths", () => {
    enableAutoCommit();
    fs.appendFileSync(path.join(dir, "BRAIN.md"), "\nmanual edit\n");
    const before = commitCount();

    expect(() =>
      autoCommit(dir, "should not commit", {
        autoCommit: true,
        autoPush: false,
        authorName: "Test",
        authorEmail: "t@example.com",
      }),
    ).not.toThrow();

    expect(commitCount()).toBe(before);
    expect(git(["status", "--porcelain"])).toContain(" M BRAIN.md");
  });

  it("commits on task completion (a direct-write path)", () => {
    enableAutoCommit();
    const vault = new Vault(dir);
    vault.createNote({ title: "Proj", type: "project", body: "## Tasks" });
    addTask(vault, { text: "do the thing", note: "Proj" });
    const before = commitCount();
    completeTask(vault, "do the thing");
    expect(commitCount()).toBe(before + 1);
    expect(git(["log", "-1", "--pretty=%s"]).trim()).toMatch(/^big-brain: complete task/);
  });

  it("logs a failed push and keeps the successful local commit", async () => {
    enableAutoCommit(true);
    git(["remote", "add", "origin", path.join(dir, "missing-remote.git")]);
    const vault = new Vault(dir);
    const before = commitCount();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      expect(() =>
        vault.createNote({ title: "Push Failure", body: "saved locally" }),
      ).not.toThrow();
      expect(commitCount()).toBe(before + 1);
      await settlePushes();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("auto-push failed (commit kept locally)"),
      );
    } finally {
      errorSpy.mockRestore();
    }
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

describe("background push", () => {
  let remoteDir: string;

  beforeEach(() => {
    remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-remote-"));
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remoteDir]);
  });

  afterEach(async () => {
    await settlePushes();
    fs.rmSync(remoteDir, { recursive: true, force: true });
  });

  it("returns before a slow push finishes, then pushes", async () => {
    enableAutoCommit(true);
    git(["remote", "add", "origin", remoteDir]);
    git(["push", "-q", "-u", "origin", "main"]);
    // A pre-push hook stands in for a slow network.
    fs.writeFileSync(path.join(dir, ".git", "hooks", "pre-push"), "#!/bin/sh\nsleep 1\n", {
      mode: 0o755,
    });
    const vault = new Vault(dir);
    const started = Date.now();
    vault.createNote({ title: "Fast Save", body: "x" });
    expect(Date.now() - started).toBeLessThan(900);
    await settlePushes();
    const remoteHead = execFileSync("git", ["--git-dir", remoteDir, "log", "-1", "--pretty=%s"], {
      encoding: "utf8",
    });
    expect(remoteHead.trim()).toBe("big-brain: create notes/Fast Save.md");
  });

  it("coalesces commits made during a push so the last one is pushed", async () => {
    enableAutoCommit(true);
    git(["remote", "add", "origin", remoteDir]);
    git(["push", "-q", "-u", "origin", "main"]);
    fs.writeFileSync(path.join(dir, ".git", "hooks", "pre-push"), "#!/bin/sh\nsleep 0.3\n", {
      mode: 0o755,
    });
    const vault = new Vault(dir);
    for (const n of [1, 2, 3]) vault.createNote({ title: `Burst ${n}`, body: "x" });
    await settlePushes();
    const local = git(["rev-parse", "HEAD"]).trim();
    const remote = execFileSync("git", ["--git-dir", remoteDir, "rev-parse", "main"], {
      encoding: "utf8",
    }).trim();
    expect(remote).toBe(local);
  });
});
