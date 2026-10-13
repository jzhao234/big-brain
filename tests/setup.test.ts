import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type RunResult,
  type SetupDeps,
  classifyVault,
  defaultSetupDeps,
  guiConfigSnippet,
  runSetup,
  vaultEnvLine,
} from "../src/cli/setup.js";
import { PACKAGE_NAME, VERSION } from "../src/core/version.js";

let tmp: string;
let home: string;
let bin: string;
let npmRoot: string;
let calls: string[][];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bb-setup-test-"));
  home = path.join(tmp, "home");
  bin = path.join(tmp, "bin");
  npmRoot = path.join(tmp, "global", "lib", "node_modules");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  calls = [];
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function fakeBin(name: string): void {
  const file = path.join(bin, name);
  fs.writeFileSync(file, "#!/bin/sh\n");
  fs.chmodSync(file, 0o755);
}

/** Link `big-brain-mcp` on PATH to a package's server script, as npm does. */
function linkBin(root: string): void {
  const script = path.join(root, "dist", "mcp", "index.js");
  fs.chmodSync(script, 0o755);
  fs.symlinkSync(script, path.join(bin, "big-brain-mcp"));
}

/** Lay out a package the way `npm install -g` would. */
function installGlobally(): string {
  const root = path.join(npmRoot, ...PACKAGE_NAME.split("/"));
  fs.mkdirSync(path.join(root, "dist", "mcp"), { recursive: true });
  fs.writeFileSync(path.join(root, "dist", "mcp", "index.js"), "");
  return root;
}

const npxRoot = () => path.join(tmp, "npm-cache", "_npx", "abc123", "node_modules", "big-brain");

function deps(
  respond: (cmd: string, args: string[]) => Partial<RunResult> = () => ({}),
  overrides: Partial<SetupDeps> = {},
): SetupDeps {
  return {
    run(cmd, args) {
      calls.push([cmd, ...args]);
      return { status: 0, stdout: "", stderr: "", ...respond(cmd, args) };
    },
    env: { PATH: bin },
    home,
    platform: "linux",
    nodePath: "/opt/node/bin/node",
    packageRoot: npxRoot(),
    ...overrides,
  };
}

/** npm that installs successfully; claude present with nothing registered yet. */
function freshMachine(cmd: string, args: string[]): Partial<RunResult> {
  if (cmd === "npm" && args[0] === "install") {
    installGlobally();
    return {};
  }
  if (cmd === "npm" && args[0] === "root") return { stdout: `${npmRoot}\n` };
  if (args[0] === "mcp" && args[1] === "get") return { status: 1 };
  return {};
}

describe("runSetup from npx", () => {
  it("installs globally, creates ~/brain, and connects Claude Code", () => {
    fakeBin("claude");
    const result = runSetup({}, deps(freshMachine));
    const vault = path.join(home, "brain");
    const script = path.join(npmRoot, ...PACKAGE_NAME.split("/"), "dist", "mcp", "index.js");

    expect(result.vault).toBe(vault);
    expect(fs.existsSync(path.join(vault, "brain.config.json"))).toBe(true);
    expect(calls).toContainEqual(["npm", "install", "-g", `${PACKAGE_NAME}@${VERSION}`]);
    // The global bin isn't on this PATH, so clients get absolute node + script.
    expect(calls).toContainEqual([
      "claude",
      "mcp",
      "add",
      "--scope",
      "user",
      "big-brain",
      "--",
      "/opt/node/bin/node",
      script,
      "--vault",
      vault,
    ]);
    expect(fs.existsSync(path.join(home, ".claude", "skills", "brain", "SKILL.md"))).toBe(true);
    expect(result.steps.find((s) => s.step === "Codex")?.status).toBe("skipped");
    expect(result.steps.some((s) => s.status === "failed")).toBe(false);
  });

  it("registers by command name when the global bin is on PATH", () => {
    fakeBin("claude");
    const result = runSetup(
      {},
      deps((cmd, args) => {
        if (cmd === "npm" && args[0] === "install") linkBin(installGlobally());
        return freshMachine(cmd, args);
      }),
    );
    const add = calls.find((c) => c[0] === "claude" && c[2] === "add");
    expect(add?.slice(7)).toEqual(["big-brain-mcp", "--vault", result.vault]);
  });

  it("finds the install through its command when npm masks the root path", () => {
    fakeBin("claude");
    const result = runSetup(
      {},
      deps((cmd, args) => {
        if (cmd === "npm" && args[0] === "root") return { stdout: "/home/***/lib/node_modules\n" };
        if (cmd === "npm" && args[0] === "install") {
          linkBin(installGlobally());
          return {};
        }
        return freshMachine(cmd, args);
      }),
    );
    expect(result.steps[0]).toMatchObject({ step: "install", status: "done" });
    expect(result.server.gui?.args).toEqual([
      fs.realpathSync(path.join(npmRoot, ...PACKAGE_NAME.split("/"), "dist", "mcp", "index.js")),
    ]);
  });

  it("changes nothing on a second run", () => {
    fakeBin("claude");
    runSetup({}, deps(freshMachine));
    fakeBin("big-brain-mcp");
    calls = [];
    const second = runSetup(
      {},
      deps((cmd, args) => (cmd === "npm" ? freshMachine(cmd, args) : {})),
    );
    expect(calls.filter((c) => c[1] === "install" || c[2] === "add")).toEqual([]);
    expect(second.steps.map((s) => `${s.step}:${s.status}`)).toEqual([
      "install:kept",
      "vault:kept",
      "Claude Code MCP:kept",
      "Claude Code skills:kept",
      "Codex:skipped",
    ]);
  });

  it("falls back to npx when the global install fails", () => {
    fakeBin("claude");
    const result = runSetup(
      {},
      deps((cmd, args) =>
        cmd === "npm" && args[0] === "install"
          ? { status: 243, stderr: "npm error code EACCES\npermission denied" }
          : freshMachine(cmd, args),
      ),
    );
    expect(result.server.kind).toBe("npx");
    expect(result.steps[0]).toMatchObject({ step: "install", status: "failed" });
    expect(result.steps[0]?.detail).toContain("EACCES");
    const add = calls.find((c) => c[0] === "claude" && c[2] === "add");
    expect(add?.slice(7)).toEqual(["npx", "-y", PACKAGE_NAME, "mcp", "--vault", result.vault]);
  });

  it("skips the install with --no-global", () => {
    const result = runSetup({ global: false, claude: false, codex: false }, deps(freshMachine));
    expect(result.server.kind).toBe("npx");
    expect(calls.filter((c) => c[0] === "npm")).toEqual([]);
  });

  it("registers Codex and installs its skills under CODEX_HOME", () => {
    fakeBin("codex");
    const codexHome = path.join(tmp, "codex-home");
    const result = runSetup(
      { claude: false },
      deps(freshMachine, { env: { PATH: bin, CODEX_HOME: codexHome } }),
    );
    const add = calls.find((c) => c[0] === "codex" && c[2] === "add");
    expect(add?.slice(0, 5)).toEqual(["codex", "mcp", "add", "big-brain", "--"]);
    expect(add?.slice(-2)).toEqual(["--vault", result.vault]);
    expect(fs.existsSync(path.join(codexHome, "skills", "brain", "agents", "openai.yaml"))).toBe(
      true,
    );
  });

  it("reports a failed registration without stopping the other steps", () => {
    fakeBin("claude");
    fakeBin("codex");
    const result = runSetup(
      {},
      deps((cmd, args) =>
        cmd === "claude" && args[1] === "add"
          ? { status: 1, stderr: "boom" }
          : freshMachine(cmd, args),
      ),
    );
    expect(result.steps.find((s) => s.step === "Claude Code MCP")?.status).toBe("failed");
    expect(result.steps.find((s) => s.step === "Codex MCP")?.status).toBe("done");
  });
});

describe("runSetup --dry-run", () => {
  it("plans every step and writes nothing", () => {
    fakeBin("claude");
    const result = runSetup({ dryRun: true }, deps(freshMachine));
    expect(fs.existsSync(result.vault)).toBe(false);
    expect(fs.existsSync(path.join(home, ".claude"))).toBe(false);
    // Only read-only lookups ran.
    expect(calls).toEqual([["claude", "mcp", "get", "big-brain"]]);
    expect(result.steps.map((s) => s.status)).toEqual([
      "planned",
      "planned",
      "planned",
      "planned",
      "skipped",
    ]);
  });
});

describe("runSetup from an installed copy", () => {
  it("uses the running package and never calls npm", () => {
    const root = installGlobally();
    const result = runSetup(
      { claude: false, codex: false },
      deps(() => ({}), { packageRoot: root }),
    );
    expect(calls).toEqual([]);
    expect(result.server).toMatchObject({
      kind: "installed",
      command: "/opt/node/bin/node",
      args: [path.join(root, "dist", "mcp", "index.js")],
    });
    expect(JSON.parse(guiConfigSnippet(result))).toEqual({
      mcpServers: {
        "big-brain": {
          command: "/opt/node/bin/node",
          args: [path.join(root, "dist", "mcp", "index.js"), "--vault", result.vault],
        },
      },
    });
  });
});

describe("vault folder handling", () => {
  it("adopts an Obsidian vault without writing to it", () => {
    const vault = path.join(tmp, "Obsidian");
    fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
    fs.writeFileSync(path.join(vault, "Idea.md"), "# Idea\n");
    const before = fs.readdirSync(vault).sort();
    const result = runSetup({ dir: vault, claude: false, codex: false, global: false }, deps());
    expect(fs.readdirSync(vault).sort()).toEqual(before);
    expect(result.steps.find((s) => s.step === "vault")?.status).toBe("kept");
  });

  it("expands ~ and adopts a folder of notes nested one level down", () => {
    fs.mkdirSync(path.join(home, "notes", "Projects"), { recursive: true });
    fs.writeFileSync(path.join(home, "notes", "Projects", "House.md"), "- [ ] call\n");
    expect(classifyVault(path.join(home, "notes"), home)).toBe("adopt");
    const result = runSetup({ dir: "~/notes", claude: false, codex: false, global: false }, deps());
    expect(result.vault).toBe(path.join(home, "notes"));
  });

  it("refuses the home folder and a non-empty folder without notes", () => {
    expect(() => classifyVault(home, home)).toThrow(/Refusing/);
    const code = path.join(tmp, "code");
    fs.mkdirSync(code);
    fs.writeFileSync(path.join(code, "main.go"), "package main\n");
    expect(() => classifyVault(code, home)).toThrow(/no markdown notes/);
    expect(() => classifyVault(path.join(code, "main.go"), home)).toThrow(/is a file/);
  });

  it("treats an empty folder as new and keeps an existing vault", () => {
    const empty = path.join(tmp, "empty");
    fs.mkdirSync(empty);
    expect(classifyVault(empty, home)).toBe("create");
    fs.writeFileSync(path.join(empty, "brain.config.json"), "{}\n");
    expect(classifyVault(empty, home)).toBe("existing");
  });
});

describe("review fixes", () => {
  it("refuses the home folder through a symlink, an ancestor, or another case", () => {
    const alias = path.join(tmp, "home-alias");
    fs.symlinkSync(home, alias);
    fs.writeFileSync(path.join(home, "Private.md"), "secret\n");
    expect(() => classifyVault(alias, home)).toThrow(/home folder/);
    expect(() => classifyVault(tmp, home)).toThrow(/home folder/);
    expect(() => classifyVault(home.toUpperCase(), home, { platform: "darwin" })).toThrow(
      /home folder/,
    );
  });

  it("stops before installing anything when an existing config doesn't load", () => {
    const vault = path.join(tmp, "broken");
    fs.mkdirSync(vault);
    fs.writeFileSync(path.join(vault, "brain.config.json"), '{"folders": 42}\n');
    expect(() => runSetup({ dir: vault }, deps(freshMachine))).toThrow(/doesn't load/);
    expect(calls).toEqual([]);
    fs.rmSync(path.join(vault, "brain.config.json"));
    fs.mkdirSync(path.join(vault, "brain.config.json"));
    expect(() => classifyVault(vault, home)).toThrow(/not a file/);
  });

  it("refuses a code project unless --adopt, and matches the scanner's markdown rule", () => {
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, "package.json"), "{}\n");
    fs.writeFileSync(path.join(repo, "README.md"), "# repo\n");
    expect(() => classifyVault(repo, home)).toThrow(/code project.*--adopt/);
    expect(classifyVault(repo, home, { adopt: true })).toBe("adopt");

    const deep = path.join(tmp, "deep");
    fs.mkdirSync(path.join(deep, "A", "B"), { recursive: true });
    fs.writeFileSync(path.join(deep, "A", "B", "Idea.md"), "# idea\n");
    expect(classifyVault(deep, home)).toBe("adopt");

    const upper = path.join(tmp, "upper");
    fs.mkdirSync(upper);
    fs.writeFileSync(path.join(upper, "Idea.MD"), "# idea\n");
    expect(() => classifyVault(upper, home, { platform: "linux" })).toThrow(/no markdown notes/);
  });

  it("launches one installation for terminal and GUI clients", () => {
    const oldRoot = path.join(tmp, "old", "big-brain");
    fs.mkdirSync(path.join(oldRoot, "dist", "mcp"), { recursive: true });
    fs.writeFileSync(path.join(oldRoot, "dist", "mcp", "index.js"), "");
    linkBin(oldRoot);
    const newRoot = installGlobally();
    const result = runSetup(
      { claude: false, codex: false },
      deps(() => ({}), { packageRoot: newRoot }),
    );
    const script = path.join(fs.realpathSync(newRoot), "dist", "mcp", "index.js");
    expect(result.server.command).toBe("/opt/node/bin/node");
    expect(result.server.args).toEqual([script]);
    expect(result.server.gui?.args).toEqual([script]);
  });

  it("prints no GUI config when big-brain is only reachable through npx", () => {
    const result = runSetup({ global: false, claude: false, codex: false }, deps());
    expect(result.server.gui).toBeNull();
    expect(guiConfigSnippet(result)).toBeNull();
  });

  it("reports an existing registration that doesn't start or isn't user-scoped", () => {
    fakeBin("claude");
    const get =
      (status: string, scope: string, launch = "/old/node\n  Args: /old/index.js --vault /v") =>
      (cmd: string, args: string[]) =>
        cmd === "claude" && args[1] === "get"
          ? {
              stdout: `big-brain:\n  Scope: ${scope}\n  Status: ${status}\n  Command: ${launch}\n`,
            }
          : freshMachine(cmd, args);
    const broken = runSetup({ codex: false }, deps(get("✗ Failed to connect", "User config")));
    const step = broken.steps.find((s) => s.step === "Claude Code MCP");
    expect(step?.status).toBe("failed");
    expect(step?.detail).toContain("/old/node /old/index.js --vault /v");
    expect(step?.detail).toContain("claude mcp remove big-brain");

    const local = runSetup(
      { codex: false },
      deps(get("✔ Connected", "Local config", `${process.execPath}\n  Args: --vault ${tmp}`)),
    );
    const kept = local.steps.find((s) => s.step === "Claude Code MCP");
    expect(kept?.status).toBe("kept");
    expect(kept?.detail).toContain("not user-scoped");
    expect(calls.some((c) => c[0] === "claude" && c[2] === "add")).toBe(false);
  });

  it("quotes the BIG_BRAIN_VAULT line so the path is taken literally", () => {
    const vault = '/tmp/vault-$(printf INJECTED)`id` it\'s "x"';
    const line = vaultEnvLine(vault, "linux");
    const out = execFileSync("/bin/sh", ["-c", `${line}; printf %s "$BIG_BRAIN_VAULT"`], {
      encoding: "utf8",
    });
    expect(out).toBe(vault);
    expect(vaultEnvLine("C:\\it's", "win32")).toContain("'C:\\it''s'");
  });
});

describe("second review fixes", () => {
  it("shell-quotes the by-hand command shown after a failed registration", () => {
    fakeBin("claude");
    const vault = path.join(tmp, "notes-$(printf INJECTED)");
    const result = runSetup(
      { dir: vault, codex: false },
      deps((cmd, args) =>
        cmd === "claude" && args[1] === "add"
          ? { status: 1, stderr: "boom" }
          : freshMachine(cmd, args),
      ),
    );
    const detail = result.steps.find((s) => s.step === "Claude Code MCP")?.detail ?? "";
    const shown = detail.slice(detail.indexOf("To do it by hand: ") + "To do it by hand: ".length);
    const lastArg = execFileSync(
      "/bin/sh",
      ["-c", `claude() { for a; do last=$a; done; printf %s "$last"; }; ${shown}`],
      { encoding: "utf8" },
    );
    expect(lastArg).toBe(vault);
  });

  it("refuses a filesystem root even when the home folder is elsewhere", () => {
    expect(() => classifyVault(path.parse(tmp).root, home)).toThrow(/filesystem root|home folder/);
  });

  it("refuses a Windows .cmd shim whose own path cmd.exe would expand", () => {
    const shimDir = path.join(tmp, "%SETUP_TEST%");
    fs.mkdirSync(shimDir);
    const shim = path.join(shimDir, "claude.cmd");
    fs.writeFileSync(shim, "@echo off\r\n");
    fs.chmodSync(shim, 0o755);
    const real = defaultSetupDeps(tmp);
    real.platform = "win32";
    real.env = { PATH: shimDir, PATHEXT: ".CMD" };
    const r = real.run("claude", ["mcp", "get", "big-brain"]);
    expect(r.status).toBeNull();
    expect(r.stderr).toMatch(/cmd\.exe would change/);
  });

  it("flags a registration whose saved paths are gone, with no status line", () => {
    fakeBin("codex");
    const spaced = path.join(tmp, "My Vault");
    fs.mkdirSync(spaced);
    const get = (args: string) => (cmd: string, a: string[]) =>
      cmd === "codex" && a[1] === "get"
        ? { stdout: `big-brain\n  command: ${process.execPath}\n  args: ${args}\n` }
        : freshMachine(cmd, a);
    const stale = runSetup(
      { claude: false },
      deps(get("/missing/old/index.js --vault /missing/vault")),
    );
    const step = stale.steps.find((s) => s.step === "Codex MCP");
    expect(step?.status).toBe("failed");
    expect(step?.detail).toContain("missing: /missing/old/index.js, /missing/vault");

    const fine = runSetup({ claude: false }, deps(get(`--vault ${spaced}`)));
    expect(fine.steps.find((s) => s.step === "Codex MCP")?.status).toBe("kept");
  });
});
