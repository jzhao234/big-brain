import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CONFIG_FILENAME, loadConfig } from "../core/config.js";
import { initVault } from "../core/scaffold.js";
import { installSkills } from "../core/skills.js";
import { PACKAGE_NAME, VERSION } from "../core/version.js";

/**
 * One-step setup behind `npx @jzhao234/big-brain setup`: install big-brain,
 * create or adopt a vault, register the MCP server with Claude Code and Codex,
 * and print config for the apps that can't be registered from the shell.
 *
 * Every step is idempotent: existing installs, vaults, registrations, and
 * skills are reported and left alone, so running it twice is safe.
 */

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Everything setup touches outside the vault, injectable for tests. */
export interface SetupDeps {
  run(command: string, args: string[]): RunResult;
  env: NodeJS.ProcessEnv;
  home: string;
  platform: NodeJS.Platform;
  /** Absolute path of the running node binary. */
  nodePath: string;
  /** Root of the running big-brain package (contains package.json). */
  packageRoot: string;
}

export interface SetupOptions {
  /** Vault folder; defaults to ~/brain. */
  dir?: string;
  name?: string;
  /** Install globally when running from npx (default true). */
  global?: boolean;
  claude?: boolean;
  codex?: boolean;
  /** Use a folder that looks like a code project as the vault anyway. */
  adopt?: boolean;
  dryRun?: boolean;
}

export type StepStatus = "done" | "kept" | "skipped" | "failed" | "planned";

export interface SetupStep {
  step: string;
  status: StepStatus;
  detail: string;
}

/** How a client should launch the MCP server (before `--vault <dir>`). */
export interface ServerLaunch {
  kind: "installed" | "global" | "npx";
  /** For shell-launched clients (Claude Code, Codex), which inherit PATH. */
  command: string;
  args: string[];
  /**
   * For GUI apps, which start without the shell's PATH: absolute node plus
   * the server script, so neither a `node` lookup nor a shim is needed. Null
   * when no such launch exists (big-brain only reachable through npx).
   */
  gui: { command: string; args: string[] } | null;
}

export interface SetupResult {
  vault: string;
  server: ServerLaunch;
  steps: SetupStep[];
}

const SERVER_NAME = "big-brain";
const SERVER_SCRIPT = path.join("dist", "mcp", "index.js");

// Characters cmd.exe expands or interprets even inside double quotes.
const CMD_UNSAFE = /[%!"^\r\n]/;

export function defaultSetupDeps(packageRoot: string): SetupDeps {
  const deps: SetupDeps = {
    run(command, args) {
      const r =
        deps.platform === "win32"
          ? runWindows(command, args, deps)
          : spawnSync(command, args, { encoding: "utf8", timeout: 300_000 });
      if ("refused" in r) return { status: null, stdout: "", stderr: r.refused };
      return {
        status: r.error ? null : r.status,
        stdout: r.stdout ?? "",
        stderr: r.error ? r.error.message : (r.stderr ?? ""),
      };
    },
    env: process.env,
    home: process.env.HOME ?? process.env.USERPROFILE ?? "",
    platform: process.platform,
    nodePath: process.execPath,
    packageRoot,
  };
  return deps;
}

/**
 * Windows: npm runs through node directly; a real .exe runs without a shell;
 * a .cmd shim needs cmd.exe, so arguments it would expand are refused rather
 * than passed through altered.
 */
function runWindows(
  command: string,
  args: string[],
  deps: SetupDeps,
): SpawnSyncReturns<string> | { refused: string } {
  const opts = { encoding: "utf8" as const, timeout: 300_000 };
  if (command === "npm") {
    const cli = path.join(path.dirname(deps.nodePath), "node_modules", "npm", "bin", "npm-cli.js");
    if (fs.existsSync(cli)) return spawnSync(deps.nodePath, [cli, ...args], opts);
  }
  const resolved = findOnPath(command, deps) ?? command;
  if (resolved.toLowerCase().endsWith(".exe")) return spawnSync(resolved, args, opts);
  if (args.some((a) => CMD_UNSAFE.test(a))) {
    return {
      refused: `an argument contains a character cmd.exe would change (${CMD_UNSAFE.source}); run the command yourself`,
    };
  }
  const quoted = args.map((a) => (/[\s&|<>()]/.test(a) ? `"${a}"` : a));
  return spawnSync(`"${resolved}"`, quoted, { ...opts, shell: true });
}

/** Find an executable on PATH, skipping npx's temporary install folders. */
export function findOnPath(name: string, deps: Pick<SetupDeps, "env" | "platform">): string | null {
  const sep = deps.platform === "win32" ? ";" : ":";
  const exts = deps.platform === "win32" ? (deps.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (deps.env.PATH ?? deps.env.Path ?? "").split(sep)) {
    if (!dir || isNpxCache(dir)) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext.toLowerCase());
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // not here
      }
    }
  }
  return null;
}

function realpathOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/** Canonical form of a path that may not exist yet: resolve the nearest existing ancestor. */
function canonical(p: string): string {
  const abs = path.resolve(p);
  const real = realpathOrNull(abs);
  if (real) return real;
  const parent = path.dirname(abs);
  return parent === abs ? abs : path.join(canonical(parent), path.basename(abs));
}

function isNpxCache(p: string): boolean {
  return p.split(/[\\/]/).includes("_npx");
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function expandHome(dir: string, home: string): string {
  if (dir === "~") return home;
  if (dir.startsWith("~/") || dir.startsWith("~\\")) return path.join(home, dir.slice(2));
  return dir;
}

type VaultPlan = "create" | "existing" | "adopt";

const CODE_PROJECT_MARKERS = [
  "package.json",
  "go.mod",
  "Cargo.toml",
  "pyproject.toml",
  "setup.py",
  "pom.xml",
  "build.gradle",
  "Gemfile",
  "composer.json",
];

/**
 * Decide what to do with the vault folder. Refuses the home folder and any
 * folder containing it, a folder whose big-brain config doesn't load, a code
 * project (unless `adopt`), and a non-empty folder with no markdown notes.
 */
export function classifyVault(
  dir: string,
  home: string,
  opts: { platform?: NodeJS.Platform; adopt?: boolean } = {},
): VaultPlan {
  const abs = path.resolve(dir);
  const fold = (p: string) =>
    (opts.platform ?? process.platform) === "linux" ? p : p.toLowerCase();
  const target = fold(canonical(abs));
  const homeDir = fold(canonical(home));
  if (isInside(homeDir, target)) {
    throw new Error(
      `Refusing to use ${abs} as a vault: it is (or contains) your home folder. Pick a dedicated folder such as ~/brain.`,
    );
  }
  if (!fs.existsSync(abs)) return "create";
  if (!fs.statSync(abs).isDirectory()) throw new Error(`${abs} is a file, not a folder.`);

  const config = path.join(abs, CONFIG_FILENAME);
  if (fs.existsSync(config)) {
    if (!fs.statSync(config).isFile()) throw new Error(`${config} is not a file.`);
    try {
      loadConfig(abs);
    } catch (err) {
      throw new Error(
        `${abs} has a ${CONFIG_FILENAME} that doesn't load (${(err as Error).message}). Fix it, then run setup again.`,
      );
    }
    return "existing";
  }

  const names = fs.readdirSync(abs);
  if (names.length === 0) return "create";
  const obsidian = names.includes(".obsidian");
  const marker = CODE_PROJECT_MARKERS.find((m) => names.includes(m));
  if (marker && !obsidian && !opts.adopt) {
    throw new Error(
      `${abs} looks like a code project (it has ${marker}). Pick a notes folder, or pass --adopt to use its markdown files as your vault anyway.`,
    );
  }
  if (obsidian || hasMarkdown(abs, { left: 20_000 })) return "adopt";
  throw new Error(
    `${abs} is not empty and has no markdown notes. Pick an empty folder or an existing vault.`,
  );
}

/** Same rule as the vault scanner (`**\/*.md`, dot folders skipped), with a visit budget. */
function hasMarkdown(dir: string, budget: { left: number }): boolean {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (--budget.left < 0) return false;
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    if (e.isFile() && e.name.endsWith(".md")) return true;
    if (e.isDirectory() && hasMarkdown(path.join(dir, e.name), budget)) return true;
  }
  return false;
}

/**
 * Launch one installation, for both terminal and GUI clients. Terminal
 * clients get the `big-brain-mcp` command only when that command on PATH is
 * this same installation; otherwise they get node and the script too.
 */
function launchFrom(root: string, kind: ServerLaunch["kind"], deps: SetupDeps): ServerLaunch {
  const realRoot = realpathOrNull(root) ?? root;
  const script = path.join(realRoot, SERVER_SCRIPT);
  const onPath = findOnPath("big-brain-mcp", deps);
  const resolved = onPath ? realpathOrNull(onPath) : null;
  const same = resolved !== null && isInside(resolved, realRoot);
  return {
    kind,
    command: same ? "big-brain-mcp" : deps.nodePath,
    args: same ? [] : [script],
    gui: { command: deps.nodePath, args: [script] },
  };
}

function npxLaunch(): ServerLaunch {
  return { kind: "npx", command: "npx", args: ["-y", PACKAGE_NAME, "mcp"], gui: null };
}

function tail(text: string): string {
  const lines = text.trim().split("\n");
  return lines.slice(-3).join(" ").slice(0, 300);
}

/** The package behind an installed `big-brain-mcp` command, when it links to the script. */
function rootFromBin(bin: string): string | null {
  const script = realpathOrNull(bin);
  if (!script?.endsWith(SERVER_SCRIPT)) return null;
  const root = script.slice(0, -SERVER_SCRIPT.length - 1);
  return hasServer(root) ? root : null;
}

function hasServer(root: string): boolean {
  return fs.existsSync(path.join(root, SERVER_SCRIPT));
}

/** npm's global package folder for big-brain, or the folder it searched. */
function globalPackageRoot(deps: SetupDeps): { root: string | null; searched: string } | null {
  const r = deps.run("npm", ["root", "-g"]);
  if (r.status !== 0) return null;
  const root = path.join(r.stdout.trim(), ...PACKAGE_NAME.split("/"));
  if (hasServer(root)) return { root, searched: root };
  // npm masks output that looks like a token (a UUID in the path, for one), so
  // fall back to the package behind the installed command.
  const bin = findOnPath("big-brain-mcp", deps);
  return { root: bin ? rootFromBin(bin) : null, searched: root };
}

/**
 * Pick how clients launch the server. A copy that isn't running from npx's
 * cache is already installed; from npx, prefer an existing global install,
 * then a new one, and fall back to launching through npx.
 */
function resolveServer(opts: SetupOptions, deps: SetupDeps, steps: SetupStep[]): ServerLaunch {
  if (!isNpxCache(deps.packageRoot)) {
    steps.push({
      step: "install",
      status: "kept",
      detail: `using big-brain ${VERSION} from ${deps.packageRoot}`,
    });
    return launchFrom(deps.packageRoot, "installed", deps);
  }
  const existing = findOnPath("big-brain-mcp", deps);
  if (existing) {
    // A version-manager shim isn't a link to the script; npm's global folder
    // for the active node is then the installation the shim runs.
    const root = rootFromBin(existing) ?? globalPackageRoot(deps)?.root ?? null;
    steps.push({ step: "install", status: "kept", detail: `already installed (${existing})` });
    if (root) return launchFrom(root, "global", deps);
    return { kind: "global", command: "big-brain-mcp", args: [], gui: null };
  }
  if (opts.global === false) {
    steps.push({
      step: "install",
      status: "skipped",
      detail: "--no-global: clients will launch big-brain through npx",
    });
    return npxLaunch();
  }
  const spec = `${PACKAGE_NAME}@${VERSION}`;
  if (opts.dryRun) {
    steps.push({ step: "install", status: "planned", detail: `npm install -g ${spec}` });
    return npxLaunch();
  }
  const r = deps.run("npm", ["install", "-g", spec]);
  const found = r.status === 0 ? globalPackageRoot(deps) : null;
  if (!found?.root) {
    const why =
      r.status !== 0
        ? `npm install -g ${spec} failed (${tail(r.stderr) || `exit ${r.status}`})`
        : `installed, but not found under npm's global folder (${found?.searched ?? "npm root -g failed"})`;
    steps.push({
      step: "install",
      status: "failed",
      detail: `${why}; clients will launch big-brain through npx instead`,
    });
    return npxLaunch();
  }
  steps.push({ step: "install", status: "done", detail: `installed ${spec} globally` });
  return launchFrom(found.root, "global", deps);
}

/** Summarize `claude mcp get` / `codex mcp get` output for an existing registration. */
function describeExisting(output: string): { summary: string; broken: boolean; scope?: string } {
  const field = (name: string) =>
    new RegExp(`^\\s*${name}:\\s*(.+)$`, "mi").exec(output)?.[1]?.trim();
  const scope = field("Scope");
  const status = field("Status");
  const command = [field("Command"), field("Args")].filter(Boolean).join(" ");
  const summary = [scope, status, command].filter(Boolean).join("; ");
  return { summary, broken: status !== undefined && !/connected/i.test(status), scope };
}

function registerClient(
  client: "claude" | "codex",
  server: ServerLaunch,
  vault: string,
  opts: SetupOptions,
  deps: SetupDeps,
  steps: SetupStep[],
): void {
  const label = client === "claude" ? "Claude Code" : "Codex";
  const bin = findOnPath(client, deps);
  if (!bin) {
    steps.push({ step: label, status: "skipped", detail: `${client} not found on PATH` });
    return;
  }
  const replace = `\`${client} mcp remove ${SERVER_NAME}\`, then run setup again`;
  const existing = deps.run(client, ["mcp", "get", SERVER_NAME]);
  if (existing.status === 0) {
    const { summary, broken, scope } = describeExisting(existing.stdout);
    const notUser = scope !== undefined && !/^user/i.test(scope);
    steps.push({
      step: `${label} MCP`,
      status: broken ? "failed" : "kept",
      detail: [
        `a "${SERVER_NAME}" server is already registered${summary ? ` (${summary})` : ""}`,
        broken ? `it doesn't start; to replace it: ${replace}` : "",
        notUser ? "it's not user-scoped, so other projects won't see it" : "",
        !broken ? `to replace it: ${replace}` : "",
      ]
        .filter(Boolean)
        .join("; "),
    });
  } else {
    const launch = [server.command, ...server.args, "--vault", vault];
    const args =
      client === "claude"
        ? ["mcp", "add", "--scope", "user", SERVER_NAME, "--", ...launch]
        : ["mcp", "add", SERVER_NAME, "--", ...launch];
    const shown = `${client} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`;
    if (opts.dryRun) {
      steps.push({ step: `${label} MCP`, status: "planned", detail: shown });
    } else {
      const r = deps.run(client, args);
      steps.push(
        r.status === 0
          ? { step: `${label} MCP`, status: "done", detail: `registered "${SERVER_NAME}"` }
          : {
              step: `${label} MCP`,
              status: "failed",
              detail: `${tail(r.stderr || r.stdout) || `exit ${r.status}`}. To do it by hand: ${shown}`,
            },
      );
    }
  }

  const skillsHome =
    client === "claude"
      ? (deps.env.CLAUDE_CONFIG_DIR ?? path.join(deps.home, ".claude"))
      : (deps.env.CODEX_HOME ?? path.join(deps.home, ".codex"));
  const target = path.join(skillsHome, "skills");
  if (opts.dryRun) {
    steps.push({
      step: `${label} skills`,
      status: "planned",
      detail: `brain, capture, weekly → ${target}`,
    });
    return;
  }
  try {
    const r = installSkills(target, { agent: client });
    const parts = [
      r.installed.length > 0 ? `added ${r.installed.join(", ")}` : "",
      r.skipped.length > 0 ? `kept existing ${r.skipped.join(", ")}` : "",
    ].filter(Boolean);
    steps.push({
      step: `${label} skills`,
      status: r.installed.length > 0 ? "done" : "kept",
      detail: `${parts.join("; ")} (${target})`,
    });
  } catch (err) {
    steps.push({ step: `${label} skills`, status: "failed", detail: (err as Error).message });
  }
}

export function runSetup(opts: SetupOptions, deps: SetupDeps): SetupResult {
  const steps: SetupStep[] = [];
  const vault = path.resolve(expandHome(opts.dir ?? "~/brain", deps.home));
  // Validate the folder before anything is installed or registered.
  const plan = classifyVault(vault, deps.home, { platform: deps.platform, adopt: opts.adopt });

  const server = resolveServer(opts, deps, steps);

  if (plan === "existing") {
    steps.push({ step: "vault", status: "kept", detail: `existing big-brain vault at ${vault}` });
  } else if (plan === "adopt") {
    steps.push({
      step: "vault",
      status: "kept",
      detail: `using the notes at ${vault} as they are (nothing written; add ${CONFIG_FILENAME} later to map folder names)`,
    });
  } else if (opts.dryRun) {
    steps.push({ step: "vault", status: "planned", detail: `create a new vault at ${vault}` });
  } else {
    initVault(vault, { name: opts.name });
    steps.push({ step: "vault", status: "done", detail: `created a new vault at ${vault}` });
  }

  if (opts.claude !== false) registerClient("claude", server, vault, opts, deps, steps);
  if (opts.codex !== false) registerClient("codex", server, vault, opts, deps, steps);

  return { vault, server, steps };
}

/**
 * Config for MCP apps that read a JSON file (Claude Desktop, Cursor, and
 * others), or null when big-brain has no launch that works without PATH.
 */
export function guiConfigSnippet(result: SetupResult): string | null {
  if (!result.server.gui) return null;
  const { command, args } = result.server.gui;
  return JSON.stringify(
    { mcpServers: { [SERVER_NAME]: { command, args: [...args, "--vault", result.vault] } } },
    null,
    2,
  );
}

/** A shell line that sets BIG_BRAIN_VAULT to `vault`, quoted so the path is taken literally. */
export function vaultEnvLine(vault: string, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    return `PowerShell: [Environment]::SetEnvironmentVariable('BIG_BRAIN_VAULT', '${vault.replace(/'/g, "''")}', 'User')`;
  }
  return `export BIG_BRAIN_VAULT='${vault.replace(/'/g, "'\\''")}'`;
}
