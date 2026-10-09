import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AgentPaths,
  agentPaths,
  agentStatus,
  collectEntries,
  editToml,
  getAgent,
  installAgent,
  planSettings,
  readState,
  saveToProfile,
} from "../src/core/agents.js";
import { initVault } from "../src/core/scaffold.js";
import { Vault } from "../src/core/vault.js";

let root: string;
let userHome: string;
let vaultDir: string;

function paths(agent: "claude" | "codex", env: Record<string, string> = {}): AgentPaths {
  return agentPaths(vaultDir, "agents", getAgent(agent), {
    userHome,
    env: { XDG_STATE_HOME: path.join(root, "state"), ...env },
  });
}

function write(file: string, text: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mode !== undefined) fs.chmodSync(file, mode);
}

function profile(agent: string, rel: string, text: string, mode?: number): string {
  const file = path.join(vaultDir, "agents", agent, rel);
  write(file, text, mode);
  return file;
}

function home(agent: "claude" | "codex"): string {
  return paths(agent).home;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bb-agents-"));
  userHome = path.join(root, "home");
  vaultDir = path.join(root, "vault");
  fs.mkdirSync(userHome);
  initVault(vaultDir, { name: "Test Brain" });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("collectEntries", () => {
  it("maps instructions, whole skill folders, single files, and bundled skills", () => {
    profile("claude", "instructions.md", "# rules");
    profile("claude", "skills/learn/SKILL.md", "---\nname: learn\n---");
    profile("claude", "files/hooks/check.sh", "#!/bin/sh");
    profile("claude", "skills/brain/SKILL.md", "---\nname: brain\n---"); // overrides the bundled one
    const entries = collectEntries(paths("claude"));
    const byRel = Object.fromEntries(entries.map((e) => [e.rel, e.kind]));
    expect(byRel).toMatchObject({
      "CLAUDE.md": "instructions",
      "skills/learn": "skill",
      "hooks/check.sh": "file",
      "skills/brain": "skill",
      "skills/capture": "bundled-skill",
      "skills/weekly": "bundled-skill",
    });
  });

  it("refuses settings, credentials, secrets, and misplaced files", () => {
    for (const [rel, msg] of [
      ["files/settings.json", /settings or credentials/],
      ["files/.credentials.json", /settings or credentials/],
      ["files/hooks/.env", /secret/],
      ["files/projects/x.jsonl", /secret, history/],
      ["files/CLAUDE.md", /instructions\.md/],
      ["files/skills/x/SKILL.md", /skills\//],
    ] as const) {
      fs.rmSync(path.join(vaultDir, "agents"), { recursive: true, force: true });
      profile("claude", rel, "x");
      expect(() => collectEntries(paths("claude")), rel).toThrow(msg);
    }
  });

  it("refuses symlinks in a profile and skills without SKILL.md", () => {
    profile("claude", "files/a.sh", "x");
    fs.symlinkSync("/etc/passwd", path.join(vaultDir, "agents/claude/files/escape"));
    expect(() => collectEntries(paths("claude"))).toThrow(/Symlinks are not allowed/);
    fs.rmSync(path.join(vaultDir, "agents"), { recursive: true });
    fs.mkdirSync(path.join(vaultDir, "agents/claude/skills/empty"), { recursive: true });
    expect(() => collectEntries(paths("claude"))).toThrow(/no SKILL\.md/);
  });
});

describe("installAgent: links", () => {
  it("links the profile, leaves unmanaged siblings alone, and is idempotent", () => {
    profile("claude", "instructions.md", "# rules");
    profile("claude", "skills/learn/SKILL.md", "---\nname: learn\n---");
    const script = profile("claude", "files/statusline.sh", "#!/bin/sh\necho hi\n", 0o755);
    write(path.join(home("claude"), "history.jsonl"), "keep me");
    write(path.join(home("claude"), "skills/omarchy/SKILL.md"), "someone else's");

    const first = installAgent(paths("claude"));
    expect(first.links.filter((l) => l.action === "link").map((l) => l.entry.rel)).toEqual([
      "CLAUDE.md",
      "skills/learn",
      "statusline.sh",
    ]);
    expect(fs.readlinkSync(path.join(home("claude"), "statusline.sh"))).toBe(script);
    expect(fs.statSync(path.join(home("claude"), "statusline.sh")).mode & 0o111).not.toBe(0);
    expect(fs.readFileSync(path.join(home("claude"), "history.jsonl"), "utf8")).toBe("keep me");
    expect(fs.existsSync(path.join(home("claude"), "skills/omarchy/SKILL.md"))).toBe(true);

    const second = installAgent(paths("claude"));
    expect(second.links.every((l) => l.action === "none" || l.action === "keep")).toBe(true);
    expect(second.backupDir).toBeNull();
  });

  it("reports an unmanaged file in the way and only replaces it when asked, backing it up outside the agent home", () => {
    profile("claude", "skills/learn/SKILL.md", "vault version");
    write(path.join(home("claude"), "skills/learn/SKILL.md"), "local version");

    const blocked = installAgent(paths("claude"));
    expect(blocked.links.find((l) => l.entry.rel === "skills/learn")?.action).toBe("conflict");
    expect(fs.lstatSync(path.join(home("claude"), "skills/learn")).isSymbolicLink()).toBe(false);

    const replaced = installAgent(paths("claude"), { replace: true });
    expect(replaced.backupDir).not.toBeNull();
    const backup = replaced.backupDir as string;
    expect(backup.startsWith(path.join(root, "state", "big-brain", "backups", "claude"))).toBe(
      true,
    );
    expect(fs.readFileSync(path.join(backup, "skills/learn/SKILL.md"), "utf8")).toBe(
      "local version",
    );
    expect(
      JSON.parse(fs.readFileSync(path.join(backup, "manifest.json"), "utf8")).restore,
    ).toHaveLength(1);
    // Nothing backup-like is left where the agent discovers skills.
    expect(fs.readdirSync(path.join(home("claude"), "skills"))).toEqual(
      expect.not.arrayContaining([expect.stringMatching(/bak/)]),
    );
    expect(fs.readFileSync(path.join(home("claude"), "skills/learn/SKILL.md"), "utf8")).toBe(
      "vault version",
    );
  });

  it("dry-run plans without creating anything", () => {
    profile("claude", "files/statusline.sh", "x");
    profile("claude", "settings.json", JSON.stringify({ statusLine: { type: "command" } }));
    const report = installAgent(paths("claude"), { dryRun: true });
    expect(report.links.some((l) => l.action === "link")).toBe(true);
    expect(report.settingsChanged).toBe(true);
    expect(fs.existsSync(home("claude"))).toBe(false);
    expect(fs.existsSync(paths("claude").stateFile)).toBe(false);
  });

  it("copies bundled skills once and keeps a locally edited copy", () => {
    installAgent(paths("codex"));
    const skill = path.join(home("codex"), "skills/brain/SKILL.md");
    expect(fs.lstatSync(path.dirname(skill)).isSymbolicLink()).toBe(false);
    expect(fs.existsSync(path.join(home("codex"), "skills/brain/agents/openai.yaml"))).toBe(true);
    fs.writeFileSync(skill, "my edit");
    const again = installAgent(paths("codex"));
    expect(again.links.find((l) => l.entry.rel === "skills/brain")?.state).toBe("copy-differs");
    expect(fs.readFileSync(skill, "utf8")).toBe("my edit");
  });

  it("honors CLAUDE_CONFIG_DIR / CODEX_HOME", () => {
    profile("codex", "instructions.md", "# codex rules");
    const custom = path.join(root, "custom-codex");
    installAgent(paths("codex", { CODEX_HOME: custom }));
    expect(fs.readlinkSync(path.join(custom, "AGENTS.md"))).toBe(
      path.join(vaultDir, "agents/codex/instructions.md"),
    );
  });

  it("reports and prunes links whose vault file was deleted", () => {
    const file = profile("claude", "files/hooks/old.sh", "x");
    profile("claude", "files/hooks/keep.sh", "x");
    installAgent(paths("claude"));
    fs.rmSync(file);
    const status = installAgent(paths("claude"));
    expect(status.stale).toEqual(["hooks/old.sh"]);
    expect(fs.lstatSync(path.join(home("claude"), "hooks/old.sh")).isSymbolicLink()).toBe(true);
    const pruned = installAgent(paths("claude"), { prune: true });
    expect(pruned.pruned).toEqual(["hooks/old.sh"]);
    expect(fs.existsSync(path.join(home("claude"), "hooks/old.sh"))).toBe(false);
    expect(fs.existsSync(path.join(home("claude"), "hooks/keep.sh"))).toBe(true);
  });
});

describe("installAgent: JSON settings (three-way)", () => {
  const settingsFile = () => path.join(home("claude"), "settings.json");
  const settings = () => JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
  const fragment = (obj: unknown) => profile("claude", "settings.json", JSON.stringify(obj));

  it("adds missing keys and never touches other settings", () => {
    write(settingsFile(), JSON.stringify({ theme: "dark", modelSettings: { x: 1 } }, null, 2));
    fragment({ statusLine: { type: "command", command: "$HOME/.claude/statusline.sh" } });
    installAgent(paths("claude"));
    expect(settings()).toEqual({
      theme: "dark",
      modelSettings: { x: 1 },
      statusLine: { type: "command", command: "$HOME/.claude/statusline.sh" },
    });
    expect(installAgent(paths("claude")).settingsChanged).toBe(false);
  });

  it("updates values big-brain set, but reports local edits instead of overwriting them", () => {
    fragment({ effortLevel: "high" });
    installAgent(paths("claude"));
    fragment({ effortLevel: "xhigh" });
    expect(installAgent(paths("claude")).settings[0]?.action).toBe("update");
    expect(settings().effortLevel).toBe("xhigh");

    const s = settings();
    s.effortLevel = "low"; // edited by hand on this machine
    write(settingsFile(), JSON.stringify(s));
    fragment({ effortLevel: "max" });
    const report = installAgent(paths("claude"));
    expect(report.settings[0]?.action).toBe("conflict");
    expect(settings().effortLevel).toBe("low");
    installAgent(paths("claude"), { replace: true });
    expect(settings().effortLevel).toBe("max");
  });

  it("removes a dropped key only if it was not edited here", () => {
    fragment({ a: 1, b: 2 });
    installAgent(paths("claude"));
    const s = settings();
    s.b = 3;
    write(settingsFile(), JSON.stringify(s));
    fragment({});
    const report = installAgent(paths("claude"));
    expect(
      Object.fromEntries(
        report.settings.map((p) => [p.leaf.kind === "key" ? p.leaf.path.join(".") : "", p.action]),
      ),
    ).toEqual({ a: "remove", b: "edited-kept" });
    expect(settings()).toEqual({ b: 3 });
  });

  it("treats a hook as one item, so changing its timeout updates it in place", () => {
    write(
      settingsFile(),
      JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: "local-hook.sh" }] }] },
      }),
    );
    const hook = (timeout: number) => ({
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "$HOME/.claude/hooks/fresh.sh", timeout }] },
        ],
      },
    });
    fragment(hook(60));
    installAgent(paths("claude"));
    fragment(hook(30));
    const report = installAgent(paths("claude"));
    expect(report.hookChanges).toBe(true);
    const commands = settings().hooks.SessionStart.flatMap(
      (g: { hooks: { command: string; timeout?: number }[] }) => g.hooks,
    );
    expect(commands).toEqual([
      { type: "command", command: "local-hook.sh" },
      { type: "command", command: "$HOME/.claude/hooks/fresh.sh", timeout: 30 },
    ]);
  });

  it("refuses an unparseable settings file and changes nothing", () => {
    write(settingsFile(), "{ not json");
    profile("claude", "files/a.sh", "x");
    fragment({ a: 1 });
    expect(() => installAgent(paths("claude"))).toThrow(/Cannot parse/);
    expect(fs.existsSync(path.join(home("claude"), "a.sh"))).toBe(false);
  });
});

describe("installAgent: TOML settings", () => {
  const config = () => path.join(home("codex"), "config.toml");
  const original = [
    "# my codex config",
    'model = "gpt-6-astra"',
    "",
    '[projects."/home/me/Work"]',
    'trust_level = "trusted"',
    "",
    "[tui.model_availability_nux]",
    "gpt-6-astra = 1",
    "",
    '[hooks.state."/home/me/.codex/hooks.json:session_start:0:0"]',
    'trusted_hash = "sha256:abc"',
    "",
  ].join("\n");

  it("adds keys textually, keeping comments, trust entries, and hook hashes", () => {
    write(config(), original);
    profile(
      "codex",
      "config.toml",
      '[tui]\nstatus_line = ["model", "git-branch"]\nstatus_line_use_colors = true\n',
    );
    installAgent(paths("codex"));
    const text = fs.readFileSync(config(), "utf8");
    expect(text.startsWith(original)).toBe(true);
    const parsed = parseToml(text) as {
      tui: { status_line: string[] };
      projects: Record<string, { trust_level: string }>;
      hooks: { state: Record<string, { trusted_hash: string }> };
    };
    expect(parsed.tui.status_line).toEqual(["model", "git-branch"]);
    expect(parsed.projects["/home/me/Work"].trust_level).toBe("trusted");
    expect(parsed.hooks.state["/home/me/.codex/hooks.json:session_start:0:0"].trusted_hash).toBe(
      "sha256:abc",
    );
  });

  it("updates a managed key in its own line and leaves the rest of the file alone", () => {
    write(config(), original);
    profile("codex", "config.toml", '[tui]\nstatus_line = ["model"]\n');
    installAgent(paths("codex"));
    profile("codex", "config.toml", '[tui]\nstatus_line = ["model", "context-used"]\n');
    installAgent(paths("codex"));
    const text = fs.readFileSync(config(), "utf8");
    expect(text).toContain('status_line = [ "model", "context-used" ]');
    expect(text.match(/status_line/g)).toHaveLength(1);
    expect(text).toContain("# my codex config");
  });

  it("refuses layouts it cannot edit safely, e.g. an inline table", () => {
    write(config(), 'tui = { status_line = ["model"] }\n');
    profile("codex", "config.toml", "[tui]\nstatus_line_use_colors = true\n");
    expect(() => installAgent(paths("codex"))).toThrow(/invalid TOML|more than the managed keys/);
    expect(fs.readFileSync(config(), "utf8")).toBe('tui = { status_line = ["model"] }\n');
  });

  it("keeps Codex hook registrations out of the vault", () => {
    profile("codex", "config.toml", "[hooks]\nx = 1\n");
    expect(() => installAgent(paths("codex"))).toThrow(/trust review/);
  });

  it("editToml re-verifies the whole document", () => {
    const plans = planSettings({}, new Map([['key:["a","b"]', 1]]), {}, false);
    expect(parseToml(editToml("", plans))).toEqual({ a: { b: 1 } });
  });
});

describe("saveToProfile", () => {
  it("moves a file into the vault, links it back, keeps the mode, and records it", () => {
    write(path.join(home("claude"), "statusline.sh"), "#!/bin/sh\necho mine\n", 0o755);
    const result = saveToProfile(paths("claude"), vaultDir, ["statusline.sh"], []);
    const saved = path.join(vaultDir, "agents/claude/files/statusline.sh");
    expect(result.touched).toEqual(["agents/claude/files/statusline.sh"]);
    expect(fs.statSync(saved).mode & 0o777).toBe(0o755);
    expect(fs.readlinkSync(path.join(home("claude"), "statusline.sh"))).toBe(saved);
    expect(fs.existsSync(path.join(result.backupDir as string, "statusline.sh"))).toBe(true);
    expect(readState(paths("claude")).links).toContain("statusline.sh");
    // Saving again is a no-op, and a later install sees it as linked.
    expect(saveToProfile(paths("claude"), vaultDir, ["statusline.sh"], []).saved).toEqual([]);
    expect(
      installAgent(paths("claude")).links.find((l) => l.entry.rel === "statusline.sh")?.action,
    ).toBe("none");
  });

  it("saves a skill folder and the instructions file to their profile slots", () => {
    write(path.join(home("codex"), "skills/mine/SKILL.md"), "---\nname: mine\n---");
    write(path.join(home("codex"), "AGENTS.md"), "# codex rules");
    const result = saveToProfile(paths("codex"), vaultDir, ["skills/mine", "AGENTS.md"], []);
    expect(result.touched.sort()).toEqual([
      "agents/codex/instructions.md",
      "agents/codex/skills/mine",
    ]);
  });

  it("refuses secrets, settings files, history, symlinks, and overwriting the vault", () => {
    const h = home("claude");
    write(path.join(h, ".credentials.json"), "{}");
    write(path.join(h, "settings.json"), "{}");
    write(path.join(h, "projects/p/log.jsonl"), "{}");
    write(path.join(h, "skills/leaky/SKILL.md"), "x");
    write(path.join(h, "skills/leaky/.env"), "TOKEN=1");
    write(path.join(root, "elsewhere.sh"), "x");
    fs.symlinkSync(path.join(root, "elsewhere.sh"), path.join(h, "linked.sh"));
    for (const [rel, msg] of [
      [".credentials.json", /settings or credentials/],
      ["settings.json", /settings or credentials/],
      ["projects/p/log.jsonl", /secret, history/],
      ["skills/leaky", /secret/],
      ["linked.sh", /symlink/],
      ["../outside", /Not a path inside/],
      [".", /Not a path inside/],
    ] as const) {
      expect(() => saveToProfile(paths("claude"), vaultDir, [rel], []), rel).toThrow(msg);
    }
    write(path.join(h, "hooks/x.sh"), "local");
    profile("claude", "files/hooks/x.sh", "vault");
    expect(() => saveToProfile(paths("claude"), vaultDir, ["hooks/x.sh"], [])).toThrow(
      /already exists/,
    );
    expect(fs.readFileSync(path.join(h, "hooks/x.sh"), "utf8")).toBe("local");
  });

  it("saves a setting so the next install treats it as applied", () => {
    write(
      path.join(home("codex"), "config.toml"),
      '[tui]\nstatus_line = ["model", "weekly-limit"]\n',
    );
    const result = saveToProfile(paths("codex"), vaultDir, [], ["tui.status_line"]);
    expect(result.touched).toEqual(["agents/codex/config.toml"]);
    expect(
      parseToml(fs.readFileSync(path.join(vaultDir, "agents/codex/config.toml"), "utf8")),
    ).toEqual({
      tui: { status_line: ["model", "weekly-limit"] },
    });
    const report = installAgent(paths("codex"));
    expect(report.settings.map((s) => s.action)).toEqual(["ok"]);
    expect(() => saveToProfile(paths("codex"), vaultDir, [], ["tui.nope"])).toThrow(/not set/);
  });
});

describe("status and the vault scanner", () => {
  it("flags Codex's AGENTS.override.md and skills that exist only on this machine", () => {
    profile("codex", "instructions.md", "# rules");
    installAgent(paths("codex"));
    write(path.join(home("codex"), "AGENTS.override.md"), "override");
    write(path.join(home("codex"), "skills/local-only/SKILL.md"), "x");
    const status = agentStatus(paths("codex"));
    expect(status.overrideActive).toBe(path.join(home("codex"), "AGENTS.override.md"));
    expect(status.localSkills).toEqual(["local-only"]);
  });

  it("never indexes agent profiles as notes, including a custom folder name", () => {
    profile("claude", "instructions.md", "# Global rules");
    const vault = new Vault(vaultDir);
    expect(vault.notes(true).some((n) => n.path.startsWith("agents/"))).toBe(false);

    const cfgFile = path.join(vaultDir, "brain.config.json");
    const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
    fs.writeFileSync(cfgFile, JSON.stringify({ ...cfg, folders: { agents: "setup/agents" } }));
    write(path.join(vaultDir, "setup/agents/claude/instructions.md"), "# rules");
    expect(new Vault(vaultDir).notes(true).some((n) => n.path.startsWith("setup/"))).toBe(false);
  });
});
