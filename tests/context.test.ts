import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/core/config.js";
import {
  hookOutput,
  matchPathRule,
  parseRepo,
  sameRepo,
  sessionContext,
} from "../src/core/context.js";
import { runDoctor } from "../src/core/doctor.js";
import { initVault } from "../src/core/scaffold.js";
import { Vault } from "../src/core/vault.js";

let root: string;
let dir: string;

function write(rel: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content);
}

/** A git checkout outside the vault whose origin is `remote`. */
function checkout(name: string, remote: string): string {
  const repo = path.join(root, name);
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: repo });
  return repo;
}

function setConfig(extra: Record<string, unknown>): void {
  write("brain.config.json", JSON.stringify({ name: "Ctx", ...extra }));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bb-context-"));
  dir = path.join(root, "vault");
  initVault(dir, { name: "Ctx" });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("parseRepo", () => {
  it.each([
    ["git@github.com:Owner/Repo.git", { host: "github.com", path: "owner/repo" }],
    ["github.com:owner/repo", { host: "github.com", path: "owner/repo" }],
    ["https://github.com/owner/repo", { host: "github.com", path: "owner/repo" }],
    ["https://github.com/owner/repo.git/", { host: "github.com", path: "owner/repo" }],
    ["ssh://git@github.com:2222/owner/repo.git", { host: "github.com", path: "owner/repo" }],
    [
      "https://user:token@gitlab.example.com/group/sub/repo.git",
      { host: "gitlab.example.com", path: "group/sub/repo" },
    ],
    ["owner/repo", { path: "owner/repo" }],
    ["group/sub/repo", { path: "group/sub/repo" }],
    ["gitlab.example.com/group/repo", { host: "gitlab.example.com", path: "group/repo" }],
  ])("%s", (input, ref) => {
    expect(parseRepo(input)).toEqual(ref);
  });

  it.each(["", "repo", "https://github.com/owner", "not a url://x", "../other", "owner/re po"])(
    "rejects %j",
    (input) => {
      expect(parseRepo(input)).toBeUndefined();
    },
  );

  it("keeps nested groups and hosts apart", () => {
    const a = parseRepo("https://git.example/client-a/team/app.git")!;
    const b = parseRepo("https://git.example/client-b/team/app.git")!;
    expect(sameRepo(a, b)).toBe(false);
    const gh = parseRepo("git@github.com:acme/widget.git")!;
    expect(sameRepo(gh, parseRepo("acme/widget")!)).toBe(true);
    expect(sameRepo(gh, parseRepo("github.com/acme/widget")!)).toBe(true);
    expect(sameRepo(gh, parseRepo("gitlab.com/acme/widget")!)).toBe(false);
  });
});

describe("sessionContext", () => {
  it("loads the one note that owns the repository, with tasks and related names", () => {
    write(
      "projects/Widget.md",
      [
        "---",
        "type: project",
        "status: active",
        "repos: [Acme/widget]",
        "---",
        "# Widget",
        "",
        "## Summary",
        "",
        "Widget renders dashboards for Acme.",
        "",
        "## Tasks",
        "",
        "- [ ] ship the exporter 📅 2026-12-01",
        "- [x] old work",
        "- [-] dropped idea",
        "",
        "## Log",
        "",
        "- 2026-11-01: started",
      ].join("\n"),
    );
    write("reference/Ops.md", "---\nrelated_repos: acme/widget\n---\n# Ops\n\nRunbook.\n");
    write("notes/Other.md", "---\nrepos: [acme/other]\n---\n# Other\n");
    const repo = checkout("widget", "git@github.com:acme/widget.git");

    const ctx = sessionContext(new Vault(dir), { cwd: path.join(repo, "src") });

    expect(ctx.source).toBe("repo");
    expect(ctx.repo).toBe("acme/widget");
    expect(ctx.note).toBe("projects/Widget.md");
    expect(ctx.text).toContain(
      "Repository acme/widget belongs to projects/Widget.md (status: active)",
    );
    expect(ctx.text).toContain("Widget renders dashboards for Acme.");
    expect(ctx.text).toContain("- [ ] ship the exporter 📅 2026-12-01");
    expect(ctx.text).not.toContain("old work");
    expect(ctx.text).not.toContain("dropped idea");
    expect(ctx.text).not.toContain("started");
    expect(ctx.text).toContain("Related notes (not loaded): Ops (reference/Ops.md)");
    expect(ctx.text).not.toContain("Runbook");
  });

  it("refuses to choose between two owners", () => {
    write("clients/A.md", "---\nrepos: [acme/shared]\n---\n# A\n\n## Summary\n\nSecret A.\n");
    write("clients/B.md", "---\nrepos: [acme/shared]\n---\n# B\n\n## Summary\n\nSecret B.\n");
    const repo = checkout("shared", "https://github.com/acme/shared.git");

    const ctx = sessionContext(new Vault(dir), { cwd: repo });

    expect(ctx.note).toBeUndefined();
    expect(ctx.text).toContain("Several notes list acme/shared");
    expect(ctx.text).not.toContain("Secret");
    expect(runDoctor(new Vault(dir)).find((f) => f.rule === "shared-repo")?.message).toContain(
      "clients/A.md, clients/B.md",
    );
  });

  it("does not load a note for another group's repository with the same name", () => {
    write("clients/A.md", "---\nrepos: [client-a/team/app]\n---\n# A\n\n## Summary\n\nSecret A.\n");
    const repo = checkout("app", "https://git.example/client-b/team/app.git");

    const ctx = sessionContext(new Vault(dir), { cwd: repo });

    expect(ctx.source).toBe("overview");
    expect(ctx.text).not.toContain("Secret A");
  });

  it("treats the same path on two named hosts as two repositories", () => {
    write("notes/Gh.md", "---\nrepos: [github.com/acme/widget]\n---\n# Gh\n");
    write("notes/Gl.md", "---\nrepos: [gitlab.com/acme/widget]\n---\n# Gl\n");
    expect(runDoctor(new Vault(dir)).some((f) => f.rule === "shared-repo")).toBe(false);

    write("notes/Any.md", "---\nrepos: [acme/widget]\n---\n# Any\n");
    const shared = runDoctor(new Vault(dir)).filter((f) => f.rule === "shared-repo");
    expect(shared).toHaveLength(1);
    expect(shared[0]?.message).toContain("3 notes");
  });

  it("ignores archived owners", () => {
    write("archive/projects/Old.md", "---\nrepos: [acme/widget]\n---\n# Old\n");
    const repo = checkout("widget", "git@github.com:acme/widget.git");

    expect(sessionContext(new Vault(dir), { cwd: repo }).source).toBe("overview");
  });

  it("falls back to the longest matching path rule", () => {
    const home = path.join(root, "home");
    fs.mkdirSync(path.join(home, "work", "repo-x"), { recursive: true });
    setConfig({
      context: {
        paths: [
          { path: "~", projects: "" },
          { path: "~/work", notes: ["Estate"], projects: "work/projects" },
        ],
      },
    });
    write("work/state/Estate.md", "# Estate\n\n## Summary\n\nTwelve boxes, all green.\n");
    write(
      "work/projects/Alpha.md",
      "---\ntype: project\nstatus: active\n---\n# Alpha\n\n- [ ] first step\n",
    );
    write("life/projects/Garden.md", "---\ntype: project\nstatus: active\n---\n# Garden\n");

    const vault = new Vault(dir);
    const work = sessionContext(vault, { cwd: path.join(home, "work", "repo-x"), home });
    expect(work.source).toBe("path");
    expect(work.text).toContain("Twelve boxes, all green.");
    expect(work.text).toContain('- Alpha (work/projects/Alpha.md): next "first step"');
    expect(work.text).not.toContain("Garden");

    const top = sessionContext(vault, { cwd: home, home });
    expect(top.text).toContain("Garden");
    expect(top.text).toContain("Alpha");
    expect(top.text).not.toContain("Twelve boxes");
  });

  it("does not treat a sibling directory with a shared prefix as inside", () => {
    const rules = [{ path: path.join(root, "work") }];
    fs.mkdirSync(path.join(root, "work"));
    fs.mkdirSync(path.join(root, "workshop"));
    expect(matchPathRule(rules, path.join(root, "workshop"), root)).toBeUndefined();
    expect(matchPathRule(rules, path.join(root, "work"), root)).toBe(rules[0]);
  });

  it("lists active projects when nothing else matches", () => {
    write("projects/Beta.md", "---\ntype: project\nstatus: active\n---\n# Beta\n");
    write("projects/Done.md", "---\ntype: project\nstatus: done\n---\n# Done\n");

    const ctx = sessionContext(new Vault(dir), { cwd: root });

    expect(ctx.source).toBe("overview");
    expect(ctx.text).toContain("- Beta (projects/Beta.md)");
    expect(ctx.text).not.toContain("Done (projects/Done.md)");
  });

  it("caps the text and always keeps the footer", () => {
    const tasks = Array.from({ length: 30 }, (_, i) => `- [ ] task number ${i} ${"x".repeat(80)}`);
    write(
      "projects/Big.md",
      `---\nrepos: [acme/big]\n---\n# Big\n\n## Summary\n\n${"Long summary line.\n".repeat(200)}\n## Tasks\n\n${tasks.join("\n")}\n`,
    );
    const repo = checkout("big", "git@github.com:acme/big.git");

    const ctx = sessionContext(new Vault(dir), { cwd: repo, maxChars: 1500 });

    expect(ctx.text.length).toBeLessThanOrEqual(1500);
    expect(ctx.text).toContain("cut to fit");
    expect(ctx.text).toContain(`Vault: ${dir}`);
  });

  it("uses the lead paragraph when a note has no Summary section", () => {
    write(
      "notes/Lead.md",
      "---\nrepos: [acme/lead]\n---\n# Lead\n\nThe opening paragraph.\n\n## Details\n\nHidden.\n",
    );
    const repo = checkout("lead", "git@github.com:acme/lead.git");

    const ctx = sessionContext(new Vault(dir), { cwd: repo });

    expect(ctx.text).toContain("The opening paragraph.");
    expect(ctx.text).not.toContain("Hidden.");
    expect(ctx.text).not.toContain("# Lead\n");
  });
});

describe("hookOutput", () => {
  it("wraps text for Claude Code and Codex", () => {
    for (const format of ["claude", "codex"] as const) {
      expect(JSON.parse(hookOutput(format, "hello"))).toEqual({
        hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "hello" },
      });
    }
  });

  it("wraps text for Antigravity", () => {
    expect(JSON.parse(hookOutput("agy", "hello"))).toEqual({
      injectSteps: [{ systemMessage: { systemMessage: "hello" } }],
    });
  });
});

describe("context config", () => {
  it("rejects relative path rules and unusable size caps", () => {
    setConfig({ context: { paths: [{ path: ".", notes: ["A"] }] } });
    expect(() => loadConfig(dir)).toThrow("context.paths[0].path must be an absolute path");
    setConfig({ context: { paths: [{ path: "work" }] } });
    expect(() => loadConfig(dir)).toThrow("context.paths[0].path must be an absolute path");
    for (const maxChars of [0, 100, 1.5, 200_000]) {
      setConfig({ context: { maxChars } });
      expect(() => loadConfig(dir)).toThrow("context.maxChars must be a whole number");
    }
    write("brain.config.json", '{"name":"Ctx","context":{"maxChars":1e309}}');
    expect(() => loadConfig(dir)).toThrow("context.maxChars must be a whole number");
  });

  it("defaults and validates context.paths", () => {
    expect(loadConfig(dir).context).toEqual({ maxChars: 4000, paths: [] });
    setConfig({ context: { paths: [{ path: "" }] } });
    expect(() => loadConfig(dir)).toThrow("context.paths[0].path must be an absolute path");
    setConfig({ context: { paths: [{ path: "~/x", notes: "Estate" }] } });
    expect(() => loadConfig(dir)).toThrow("context.paths[0].notes must be a list");
    setConfig({ context: { maxChars: "big" } });
    expect(() => loadConfig(dir)).toThrow("context.maxChars must be a number");
    setConfig({ context: { maxChars: 2000, paths: [{ path: "~" }, { path: "/srv/work" }] } });
    expect(loadConfig(dir).context.maxChars).toBe(2000);
  });
});

describe("big-brain context CLI", () => {
  async function run(args: string[]) {
    vi.restoreAllMocks(); // fresh console spies per run
    vi.resetModules();
    const { Command } = await import("commander");
    const parse = vi.spyOn(Command.prototype, "parseAsync").mockImplementation(async function (
      this: InstanceType<typeof Command>,
    ) {
      return this;
    });
    await import("../src/cli/index.js");
    const program = parse.mock.instances[0] as unknown as InstanceType<typeof Command>;
    parse.mockRestore();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("CLI exited");
    });
    await program.parseAsync(["node", "big-brain", ...args]);
    return {
      log: log.mock.calls.flat().join("\n"),
      error: error.mock.calls.flat().join("\n"),
      exited: exit.mock.calls.length > 0,
    };
  }

  it("prints hook JSON for the repository's owning note", async () => {
    write(
      "projects/Widget.md",
      "---\nrepos: [acme/widget]\n---\n# Widget\n\n## Summary\n\nDashboards.\n",
    );
    const repo = checkout("widget", "git@github.com:acme/widget.git");

    const claude = await run(["--vault", dir, "context", "--format", "claude", "--cwd", repo]);
    expect(JSON.parse(claude.log).hookSpecificOutput.additionalContext).toContain("Dashboards.");

    const agy = await run(["--vault", dir, "context", "--format", "agy", "--cwd", repo]);
    expect(JSON.parse(agy.log).injectSteps[0].systemMessage.systemMessage).toContain("Dashboards.");
  });

  it("never fails a hook: no vault means no output and no exit", async () => {
    const result = await run([
      "--vault",
      path.join(root, "missing"),
      "context",
      "--format",
      "codex",
      "--cwd",
      root,
    ]);

    expect(result.log).toBe("");
    expect(result.exited).toBe(false);
    expect(result.error).toContain("big-brain context:");
  });

  it("reports a bad --max-chars without failing a hook", async () => {
    const hook = await run([
      "--vault",
      dir,
      "context",
      "--format",
      "claude",
      "--max-chars",
      "0",
      "--cwd",
      root,
    ]);
    expect(hook.log).toBe("");
    expect(hook.exited).toBe(false);
    expect(hook.error).toContain("Invalid --max-chars 0");

    await expect(
      run(["--vault", dir, "context", "--max-chars", "10", "--cwd", root]),
    ).rejects.toThrow("CLI exited");
  });

  it("rejects an unknown format", async () => {
    await expect(
      run(["--vault", dir, "context", "--format", "vim", "--cwd", root]),
    ).rejects.toThrow("CLI exited");
  });
});
