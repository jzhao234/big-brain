/**
 * Agent profiles: a vault folder per coding agent (agents/<name>/) holds that
 * agent's personal setup, which big-brain installs on a machine and can save
 * back from it.
 *
 *   agents/<name>/instructions.md   -> the agent's global instructions file
 *   agents/<name>/skills/<skill>/   -> one link per skill directory
 *   agents/<name>/files/**          -> one link per file (status line, hooks…)
 *   agents/<name>/<settings file>   -> fragment merged into the agent's settings
 *
 * Safety rules: nothing unmanaged is replaced unless asked (`replace`), and
 * then it is moved to a backup outside every agent folder; every change is
 * planned and validated before the first write; settings merges are
 * three-way (fragment, last applied, current), so local edits are reported,
 * never overwritten.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { bundledSkillsDir } from "./skills.js";

// ---------------------------------------------------------------------------
// Agent table

export type SettingsFormat = "json" | "toml";

export interface AgentDef {
  /** Vault folder name and CLI argument. */
  name: string;
  label: string;
  /** Environment variable that overrides the agent's home directory. */
  homeEnv: string;
  /** Home directory relative to the user's home when homeEnv is unset. */
  defaultHome: string;
  /** Global instructions file inside the home. */
  instructionsFile: string;
  /** A file that silently supersedes instructionsFile when present (status warns). */
  instructionsOverride?: string;
  /** Skill root inside the home. */
  skillsDir: string;
  /** Settings file inside the home; the vault fragment uses the same name. */
  settingsFile: string;
  format: SettingsFormat;
  /** Whether hook registrations in the fragment are managed for this agent. */
  managesHooks: boolean;
  /** Files in the home that are never linked or saved as plain files. */
  reserved: string[];
}

export const AGENTS: readonly AgentDef[] = [
  {
    name: "claude",
    label: "Claude Code",
    homeEnv: "CLAUDE_CONFIG_DIR",
    defaultHome: ".claude",
    instructionsFile: "CLAUDE.md",
    skillsDir: "skills",
    settingsFile: "settings.json",
    format: "json",
    managesHooks: true,
    reserved: ["settings.json", "settings.local.json", ".credentials.json"],
  },
  {
    name: "codex",
    label: "Codex",
    homeEnv: "CODEX_HOME",
    defaultHome: ".codex",
    instructionsFile: "AGENTS.md",
    instructionsOverride: "AGENTS.override.md",
    skillsDir: "skills",
    settingsFile: "config.toml",
    format: "toml",
    // Codex hooks need a per-machine trust review; registrations stay local.
    managesHooks: false,
    reserved: ["config.toml", "auth.json", "hooks.json"],
  },
];

export function getAgent(name: string): AgentDef {
  const agent = AGENTS.find((a) => a.name === name);
  if (!agent) {
    throw new Error(`Unknown agent: ${name} (known: ${AGENTS.map((a) => a.name).join(", ")})`);
  }
  return agent;
}

/** Where things live on this machine; injectable so tests never touch the real home. */
export interface SystemEnv {
  userHome: string;
  env: Record<string, string | undefined>;
}

export function defaultSystem(): SystemEnv {
  return { userHome: os.homedir(), env: process.env };
}

export interface AgentPaths {
  agent: AgentDef;
  /** The agent's home on this machine (e.g. ~/.claude). */
  home: string;
  /** The agent's profile folder in the vault (agents/<name>). */
  profile: string;
  /** big-brain's record of what it applied for this agent on this machine. */
  stateFile: string;
  /** Root for backups; always outside every agent home. */
  backupRoot: string;
}

export function agentPaths(
  vaultDir: string,
  agentsFolder: string,
  agent: AgentDef,
  sys: SystemEnv = defaultSystem(),
): AgentPaths {
  const home = sys.env[agent.homeEnv] || path.join(sys.userHome, agent.defaultHome);
  const stateRoot = path.join(
    sys.env.XDG_STATE_HOME || path.join(sys.userHome, ".local", "state"),
    "big-brain",
  );
  return {
    agent,
    home: path.resolve(home),
    profile: path.resolve(vaultDir, agentsFolder, agent.name),
    stateFile: path.join(stateRoot, "agents", `${agent.name}.json`),
    backupRoot: path.join(stateRoot, "backups", agent.name),
  };
}

// ---------------------------------------------------------------------------
// Managed entries

export type EntryKind = "instructions" | "skill" | "file" | "bundled-skill";

export interface Entry {
  /** Path relative to the agent home, POSIX separators. */
  rel: string;
  /** Absolute source path (vault profile, or the package for bundled skills). */
  src: string;
  kind: EntryKind;
}

const INSTRUCTIONS = "instructions.md";
const SKILLS = "skills";
const FILES = "files";

function toRel(p: string): string {
  return p.split(path.sep).join("/");
}

/** Names never saved into a vault and never linked: secrets, history, caches, databases. */
const DENY_BASENAME = [
  /^\.credentials\.json$/,
  /^auth\.json$/,
  /^\.env(\..*)?$/,
  /\.env$/,
  /\.(sqlite|sqlite3|db)(-.*)?$/,
  /^history(\..*)?$/,
];
const DENY_TOP_DIRS = new Set([
  "projects",
  "sessions",
  "shell-snapshots",
  "shell_snapshots",
  "file-history",
  "todos",
  "statsig",
  "cache",
  "logs",
  "plugins",
  "session-env",
  "paste-cache",
  "downloads",
  "backups",
  "packages",
  "tmp",
  ".tmp",
  "telemetry",
  "ide",
  "debug",
]);

function isDenied(rel: string): boolean {
  const parts = rel.split("/");
  if (DENY_TOP_DIRS.has(parts[0] ?? "")) return true;
  return parts.some((part) => DENY_BASENAME.some((re) => re.test(part)));
}

/** Normalize a user- or vault-supplied relative path; throws on escapes. */
export function normalizeRel(input: string): string {
  const rel = path.posix.normalize(input.replaceAll("\\", "/")).replace(/\/+$/, "");
  if (rel === "" || rel === "." || rel.startsWith("/") || rel === ".." || rel.startsWith("../")) {
    throw new Error(`Not a path inside the agent folder: ${input}`);
  }
  return rel;
}

function checkManageable(p: AgentPaths, rel: string, what: string): void {
  if (p.agent.reserved.includes(rel)) {
    throw new Error(
      `${what}: ${rel} is ${p.agent.label}'s own settings or credentials file and is never managed as a file`,
    );
  }
  if (isDenied(rel)) {
    throw new Error(`${what}: ${rel} looks like a secret, history, cache, or database path`);
  }
}

/** Walk a vault directory; refuses symlinks so nothing can point outside the vault. */
function walkFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(dir, entry.name);
    if (entry.name === ".DS_Store") continue;
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Symlinks are not allowed in an agent profile: ${toRel(path.relative(base, abs))}`,
      );
    }
    if (entry.isDirectory()) out.push(...walkFiles(abs, base));
    else if (entry.isFile()) out.push(abs);
  }
  return out;
}

/**
 * Everything the vault (and the package's bundled skills) says this agent
 * should have. Throws before any change if the profile is unsafe to apply.
 */
export function collectEntries(p: AgentPaths): Entry[] {
  const entries: Entry[] = [];
  const instructions = path.join(p.profile, INSTRUCTIONS);
  if (fs.existsSync(instructions)) {
    entries.push({ rel: p.agent.instructionsFile, src: instructions, kind: "instructions" });
  }

  const vaultSkills = new Set<string>();
  const skillsRoot = path.join(p.profile, SKILLS);
  if (fs.existsSync(skillsRoot)) {
    for (const entry of fs
      .readdirSync(skillsRoot, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(skillsRoot, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Symlinks are not allowed in an agent profile: skills/${entry.name}`);
      }
      if (!entry.isDirectory()) continue;
      if (!fs.existsSync(path.join(abs, "SKILL.md"))) {
        throw new Error(`skills/${entry.name} has no SKILL.md`);
      }
      walkFiles(abs); // refuses symlinks inside the skill
      vaultSkills.add(entry.name);
      entries.push({ rel: `${p.agent.skillsDir}/${entry.name}`, src: abs, kind: "skill" });
    }
  }

  const filesRoot = path.join(p.profile, FILES);
  if (fs.existsSync(filesRoot)) {
    for (const abs of walkFiles(filesRoot)) {
      const rel = toRel(path.relative(filesRoot, abs));
      checkManageable(p, rel, "files/");
      if (rel === p.agent.instructionsFile) {
        throw new Error(`files/${rel}: put global instructions in ${INSTRUCTIONS} instead`);
      }
      if (rel === p.agent.skillsDir || rel.startsWith(`${p.agent.skillsDir}/`)) {
        throw new Error(`files/${rel}: put skills in ${SKILLS}/ instead`);
      }
      entries.push({ rel, src: abs, kind: "file" });
    }
  }

  const bundled = bundledSkillsDir(p.agent.name);
  if (bundled) {
    for (const entry of fs.readdirSync(bundled, { withFileTypes: true })) {
      if (!entry.isDirectory() || vaultSkills.has(entry.name)) continue; // the vault wins
      entries.push({
        rel: `${p.agent.skillsDir}/${entry.name}`,
        src: path.join(bundled, entry.name),
        kind: "bundled-skill",
      });
    }
  }
  return entries.sort((a, b) => a.rel.localeCompare(b.rel));
}

// ---------------------------------------------------------------------------
// Link planning

export type LinkState =
  | "linked" // a symlink to the vault source
  | "missing"
  | "occupied" // a real file or directory that is not ours
  | "other-link" // a symlink pointing somewhere else
  | "copied" // bundled skill present with the packaged content
  | "copy-differs"; // bundled skill present but edited or from another version

function readLinkAbs(dst: string): string | null {
  try {
    const target = fs.readlinkSync(dst);
    return path.resolve(path.dirname(dst), target);
  } catch {
    return null;
  }
}

function sameTree(a: string, b: string): boolean {
  const sa = fs.statSync(a);
  const sb = fs.statSync(b);
  if (sa.isDirectory() !== sb.isDirectory()) return false;
  if (!sa.isDirectory()) return fs.readFileSync(a).equals(fs.readFileSync(b));
  const la = fs.readdirSync(a).sort();
  const lb = fs.readdirSync(b).sort();
  if (la.join("\0") !== lb.join("\0")) return false;
  return la.every((n) => sameTree(path.join(a, n), path.join(b, n)));
}

export function entryState(p: AgentPaths, entry: Entry): LinkState {
  const dst = path.join(p.home, entry.rel);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(dst);
  } catch {
    return "missing";
  }
  if (entry.kind === "bundled-skill") {
    if (st.isSymbolicLink()) return "other-link";
    try {
      return sameTree(entry.src, dst) ? "copied" : "copy-differs";
    } catch {
      return "copy-differs";
    }
  }
  if (st.isSymbolicLink()) return readLinkAbs(dst) === entry.src ? "linked" : "other-link";
  return "occupied";
}

export type LinkAction = "none" | "link" | "copy" | "replace" | "conflict" | "keep";

export interface LinkPlan {
  entry: Entry;
  state: LinkState;
  action: LinkAction;
}

function planLink(p: AgentPaths, entry: Entry, replace: boolean): LinkPlan {
  const state = entryState(p, entry);
  let action: LinkAction;
  if (entry.kind === "bundled-skill") {
    // Bundled skills are copied (the package path can change between versions)
    // and an existing copy is kept: it may hold the user's own edits.
    action = state === "missing" ? "copy" : state === "other-link" && replace ? "replace" : "keep";
  } else if (state === "linked") action = "none";
  else if (state === "missing") action = "link";
  else action = replace ? "replace" : "conflict";
  return { entry, state, action };
}

// ---------------------------------------------------------------------------
// Settings: three-way merge of the vault fragment into the agent's settings

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function isPlainObject(v: unknown): v is Record<string, Json> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return deepEqual(ka, kb) && ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

function clone<T>(v: T): T {
  return structuredClone(v);
}

/**
 * A managed setting. Plain keys are addressed by their path; a hook is
 * addressed by (event, matcher, command) so editing its timeout updates it
 * in place instead of registering it twice.
 */
export type Leaf =
  | { kind: "key"; path: string[] }
  | { kind: "hook"; event: string; matcher: string; command: string };

export function leafId(leaf: Leaf): string {
  return leaf.kind === "key"
    ? `key:${JSON.stringify(leaf.path)}`
    : `hook:${JSON.stringify([leaf.event, leaf.matcher, leaf.command])}`;
}

export function parseLeafId(id: string): Leaf {
  if (id.startsWith("key:")) return { kind: "key", path: JSON.parse(id.slice(4)) };
  const [event, matcher, command] = JSON.parse(id.slice(5)) as string[];
  return { kind: "hook", event: event ?? "", matcher: matcher ?? "", command: command ?? "" };
}

export function leafLabel(leaf: Leaf): string {
  return leaf.kind === "key"
    ? leaf.path.join(".")
    : `hook ${leaf.event}${leaf.matcher ? ` [${leaf.matcher}]` : ""}: ${leaf.command}`;
}

/** Flatten a fragment into managed leaves and the values they should have. */
export function fragmentLeaves(fragment: Record<string, Json>, agent: AgentDef): Map<string, Json> {
  const out = new Map<string, Json>();
  const walk = (obj: Record<string, Json>, prefix: string[]) => {
    for (const [k, v] of Object.entries(obj)) {
      if (prefix.length === 0 && k === "hooks") {
        if (!agent.managesHooks) {
          throw new Error(
            `${agent.label} hook registrations need a per-machine trust review; keep them out of the vault fragment`,
          );
        }
        for (const [event, groups] of Object.entries(isPlainObject(v) ? v : {})) {
          if (!Array.isArray(groups)) throw new Error(`hooks.${event} must be a list`);
          for (const group of groups) {
            if (!isPlainObject(group) || !Array.isArray(group.hooks)) {
              throw new Error(`hooks.${event} entries need a "hooks" list`);
            }
            const matcher = typeof group.matcher === "string" ? group.matcher : "";
            for (const hook of group.hooks) {
              if (!isPlainObject(hook) || typeof hook.command !== "string") {
                throw new Error(`hooks.${event}: every hook needs a "command"`);
              }
              out.set(leafId({ kind: "hook", event, matcher, command: hook.command }), clone(hook));
            }
          }
        }
        continue;
      }
      if (isPlainObject(v)) walk(v, [...prefix, k]);
      else out.set(leafId({ kind: "key", path: [...prefix, k] }), clone(v));
    }
  };
  walk(fragment, []);
  return out;
}

function getAt(obj: Record<string, Json>, leaf: Leaf): Json | undefined {
  if (leaf.kind === "key") {
    let cur: Json | undefined = obj;
    for (const k of leaf.path) {
      if (!isPlainObject(cur)) return undefined;
      cur = cur[k];
    }
    return cur;
  }
  const groups = isPlainObject(obj.hooks) ? obj.hooks[leaf.event] : undefined;
  if (!Array.isArray(groups)) return undefined;
  for (const g of groups) {
    if (!isPlainObject(g) || !Array.isArray(g.hooks)) continue;
    if ((typeof g.matcher === "string" ? g.matcher : "") !== leaf.matcher) continue;
    const hook = g.hooks.find((h) => isPlainObject(h) && h.command === leaf.command);
    if (hook !== undefined) return hook;
  }
  return undefined;
}

function setAt(obj: Record<string, Json>, leaf: Leaf, value: Json): void {
  if (leaf.kind === "key") {
    let cur = obj;
    for (const k of leaf.path.slice(0, -1)) {
      if (!isPlainObject(cur[k])) cur[k] = {};
      cur = cur[k] as Record<string, Json>;
    }
    cur[leaf.path[leaf.path.length - 1] as string] = value;
    return;
  }
  if (!isPlainObject(obj.hooks)) obj.hooks = {};
  const hooks = obj.hooks as Record<string, Json>;
  if (!Array.isArray(hooks[leaf.event])) hooks[leaf.event] = [];
  const groups = hooks[leaf.event] as Json[];
  for (const g of groups) {
    if (!isPlainObject(g) || !Array.isArray(g.hooks)) continue;
    if ((typeof g.matcher === "string" ? g.matcher : "") !== leaf.matcher) continue;
    const i = g.hooks.findIndex((h) => isPlainObject(h) && h.command === leaf.command);
    if (i >= 0) {
      g.hooks[i] = value;
      return;
    }
  }
  const group = groups.find(
    (g) =>
      isPlainObject(g) &&
      Array.isArray(g.hooks) &&
      (typeof g.matcher === "string" ? g.matcher : "") === leaf.matcher,
  );
  if (group && isPlainObject(group) && Array.isArray(group.hooks)) group.hooks.push(value);
  else groups.push(leaf.matcher ? { matcher: leaf.matcher, hooks: [value] } : { hooks: [value] });
}

function deleteAt(obj: Record<string, Json>, leaf: Leaf): void {
  if (leaf.kind === "key") {
    let cur: Json | undefined = obj;
    for (const k of leaf.path.slice(0, -1)) {
      if (!isPlainObject(cur)) return;
      cur = cur[k];
    }
    if (isPlainObject(cur)) delete cur[leaf.path[leaf.path.length - 1] as string];
    return;
  }
  const hooks = isPlainObject(obj.hooks) ? obj.hooks : undefined;
  const groups = hooks?.[leaf.event];
  if (!hooks || !Array.isArray(groups)) return;
  for (const g of groups) {
    if (!isPlainObject(g) || !Array.isArray(g.hooks)) continue;
    if ((typeof g.matcher === "string" ? g.matcher : "") !== leaf.matcher) continue;
    g.hooks = g.hooks.filter((h) => !(isPlainObject(h) && h.command === leaf.command));
  }
  hooks[leaf.event] = groups.filter(
    (g) => !(isPlainObject(g) && Array.isArray(g.hooks) && g.hooks.length === 0),
  );
  if ((hooks[leaf.event] as Json[]).length === 0) delete hooks[leaf.event];
}

export type SettingAction =
  | "ok" // already has the vault value
  | "add" // missing here
  | "update" // vault value changed and this machine still has the last applied one
  | "remove" // dropped from the vault and unedited here
  | "conflict" // differs here and was not set by big-brain (or edited locally)
  | "edited-kept"; // dropped from the vault but edited here: left alone

export interface SettingPlan {
  id: string;
  leaf: Leaf;
  action: SettingAction;
  current: Json | undefined;
  wanted: Json | undefined;
}

/**
 * Decide each managed setting from three values: what the vault wants, what
 * big-brain last applied here, and what the machine has now.
 */
export function planSettings(
  current: Record<string, Json>,
  wanted: Map<string, Json>,
  lastApplied: Record<string, Json>,
  replace: boolean,
): SettingPlan[] {
  const plans: SettingPlan[] = [];
  const ids = [...new Set([...wanted.keys(), ...Object.keys(lastApplied)])].sort();
  for (const id of ids) {
    const leaf = parseLeafId(id);
    const cur = getAt(current, leaf);
    const want = wanted.get(id);
    const last = Object.hasOwn(lastApplied, id) ? lastApplied[id] : undefined;
    let action: SettingAction;
    if (want !== undefined) {
      if (cur === undefined) action = "add";
      else if (deepEqual(cur, want)) action = "ok";
      else if (replace || (last !== undefined && deepEqual(cur, last))) action = "update";
      else action = "conflict";
    } else if (cur === undefined) {
      continue; // was managed, already gone: just forget it
    } else {
      action = last !== undefined && deepEqual(cur, last) ? "remove" : "edited-kept";
    }
    plans.push({ id, leaf, action, current: cur, wanted: want });
  }
  return plans;
}

/** Apply planned setting changes to a parsed settings object (returns a copy). */
export function applySettingPlans(current: Record<string, Json>, plans: SettingPlan[]) {
  const next = clone(current);
  for (const plan of plans) {
    if (plan.action === "add" || plan.action === "update") {
      setAt(next, plan.leaf, clone(plan.wanted as Json));
    } else if (plan.action === "remove") deleteAt(next, plan.leaf);
  }
  return next;
}

// --- TOML text editing ------------------------------------------------------

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

function tomlLine(key: string, value: Json): string {
  return stringifyToml({ [key]: value as never }).trim();
}

interface HeaderSpan {
  start: number; // header line index (-1 = top-level region)
  end: number; // exclusive end of the table body
}

function findTableSpan(lines: string[], table: string[]): HeaderSpan | null {
  const isHeader = (l: string) => /^\s*\[/.test(l);
  if (table.length === 0) {
    const first = lines.findIndex(isHeader);
    return { start: -1, end: first === -1 ? lines.length : first };
  }
  const want = table.join(".");
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*\[\s*([A-Za-z0-9_\-.\s]+?)\s*\]\s*(#.*)?$/.exec(lines[i] ?? "");
    if (!m || /^\s*\[\[/.test(lines[i] ?? "")) continue;
    if ((m[1] ?? "").replace(/\s*\.\s*/g, ".") !== want) continue;
    let end = i + 1;
    while (end < lines.length && !isHeader(lines[end] ?? "")) end++;
    return { start: i, end };
  }
  return null;
}

/**
 * Edit TOML text for the planned changes, touching only the managed keys'
 * lines so comments, ordering, trust entries and hook hashes survive. The
 * result is parsed and must equal the expected object exactly, otherwise the
 * edit is refused (inline tables, multi-line values, quoted keys…).
 */
export function editToml(text: string, plans: SettingPlan[]): string {
  const before = parseToml(text) as Record<string, Json>;
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  for (const plan of plans) {
    if (plan.leaf.kind !== "key") continue;
    if (!["add", "update", "remove"].includes(plan.action)) continue;
    const table = plan.leaf.path.slice(0, -1);
    const key = plan.leaf.path[plan.leaf.path.length - 1] as string;
    if (!plan.leaf.path.every((k) => BARE_KEY.test(k))) {
      throw new Error(
        `Cannot safely edit ${plan.leaf.path.join(".")}: only bare TOML keys are supported`,
      );
    }
    let span = findTableSpan(lines, table);
    if (plan.action === "add") {
      const line = tomlLine(key, plan.wanted as Json);
      if (!span) {
        if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
        lines.push(`[${table.join(".")}]`, line);
        continue;
      }
      let at = span.end;
      while (at > span.start + 1 && (lines[at - 1] ?? "").trim() === "") at--;
      lines.splice(at, 0, line);
      continue;
    }
    if (!span) throw new Error(`Cannot find [${table.join(".")}] to edit ${key}`);
    const keyRe = new RegExp(`^\\s*${key.replace(/[-]/g, "\\-")}\\s*=`);
    const idx = lines.findIndex((l, i) => i > span!.start && i < span!.end && keyRe.test(l));
    if (idx === -1) throw new Error(`Cannot find the line for ${plan.leaf.path.join(".")}`);
    if (plan.action === "update") lines[idx] = tomlLine(key, plan.wanted as Json);
    else lines.splice(idx, 1);
    span = null;
  }
  const out = lines.length ? `${lines.join("\n")}\n` : "";
  let after: Record<string, Json>;
  try {
    after = parseToml(out) as Record<string, Json>;
  } catch (err) {
    throw new Error(
      `Editing would produce invalid TOML (${(err as Error).message.split("\n")[0]})`,
    );
  }
  if (!deepEqual(after, applySettingPlans(before, plans))) {
    throw new Error(
      "Editing would change more than the managed keys (inline table, multi-line value, or unusual layout); edit by hand",
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reading and writing files safely

export function parseSettings(
  text: string,
  format: SettingsFormat,
  where: string,
): Record<string, Json> {
  if (text.trim() === "") return {};
  try {
    const value = format === "json" ? JSON.parse(text) : parseToml(text);
    if (!isPlainObject(value)) throw new Error("top level is not a table/object");
    return value as Record<string, Json>;
  } catch (err) {
    throw new Error(`Cannot parse ${where}: ${(err as Error).message.split("\n")[0]}`);
  }
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Write via a temp file in the same directory and rename, keeping the mode. */
function atomicWrite(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let mode: number | undefined;
  try {
    mode = fs.statSync(file).mode & 0o777;
  } catch {
    mode = undefined;
  }
  const tmp = `${file}.big-brain-${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, mode !== undefined ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// State: what big-brain applied on this machine

export interface AgentState {
  vault: string;
  /** Linked entries (relative to the agent home) from the last install. */
  links: string[];
  /** Last applied value of every managed setting, by leaf id. */
  settings: Record<string, Json>;
}

export function readState(p: AgentPaths): AgentState {
  const text = readText(p.stateFile);
  if (text === null) return { vault: "", links: [], settings: {} };
  const raw = JSON.parse(text) as Partial<AgentState>;
  return { vault: raw.vault ?? "", links: raw.links ?? [], settings: raw.settings ?? {} };
}

function writeState(p: AgentPaths, state: AgentState): void {
  atomicWrite(p.stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Backups (outside every agent home, so a backed-up skill is never discovered)

class Backup {
  readonly dir: string;
  private moved: { rel: string; backup: string }[] = [];
  constructor(p: AgentPaths, now = new Date()) {
    const stamp = now.toISOString().replace(/[:.]/g, "-");
    let dir = path.join(p.backupRoot, stamp);
    for (let n = 2; fs.existsSync(dir); n++) dir = path.join(p.backupRoot, `${stamp}-${n}`);
    this.dir = dir;
  }
  /** Move (or copy, for files we keep using) something out of the agent home. */
  take(home: string, rel: string, mode: "move" | "copy"): string {
    const from = path.join(home, rel);
    const to = path.join(this.dir, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (mode === "move") fs.renameSync(from, to);
    else fs.cpSync(from, to, { recursive: true, preserveTimestamps: true });
    this.moved.push({ rel, backup: to });
    return to;
  }
  finish(home: string): string | null {
    if (this.moved.length === 0) return null;
    const manifest = {
      home,
      restore: this.moved.map((m) => ({ from: m.backup, to: path.join(home, m.rel) })),
    };
    fs.writeFileSync(
      path.join(this.dir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    return this.dir;
  }
}

// ---------------------------------------------------------------------------
// Install

export interface InstallOptions {
  dryRun?: boolean;
  /** Back up and replace unmanaged files in the way, and overwrite locally edited settings. */
  replace?: boolean;
  /** Remove links from an earlier install whose vault source is gone. */
  prune?: boolean;
}

export interface InstallReport {
  paths: AgentPaths;
  links: LinkPlan[];
  settings: SettingPlan[];
  settingsFile: string;
  settingsChanged: boolean;
  stale: string[];
  pruned: string[];
  backupDir: string | null;
  hookChanges: boolean;
  dryRun: boolean;
}

export function planInstall(p: AgentPaths, opts: InstallOptions = {}) {
  const entries = collectEntries(p);
  const links = entries.map((e) => planLink(p, e, Boolean(opts.replace)));

  const fragmentFile = path.join(p.profile, p.agent.settingsFile);
  const fragmentText = readText(fragmentFile);
  const wanted =
    fragmentText === null
      ? new Map<string, Json>()
      : fragmentLeaves(
          parseSettings(
            fragmentText,
            p.agent.format,
            `vault ${p.agent.name}/${p.agent.settingsFile}`,
          ),
          p.agent,
        );

  const settingsFile = path.join(p.home, p.agent.settingsFile);
  const settingsText = readText(settingsFile) ?? "";
  const current = parseSettings(settingsText, p.agent.format, settingsFile);
  const state = readState(p);
  const settings = planSettings(current, wanted, state.settings, Boolean(opts.replace));
  const changes = settings.filter((s) => ["add", "update", "remove"].includes(s.action));
  let newSettingsText: string | null = null;
  if (changes.length > 0) {
    newSettingsText =
      p.agent.format === "json"
        ? `${JSON.stringify(applySettingPlans(current, settings), null, 2)}\n`
        : editToml(settingsText, settings);
  }

  const linkedNow = new Set(entries.filter((e) => e.kind !== "bundled-skill").map((e) => e.rel));
  const stale = state.links.filter((rel) => {
    if (linkedNow.has(rel)) return false;
    const target = readLinkAbs(path.join(p.home, rel));
    return target?.startsWith(`${p.profile}${path.sep}`) ?? false;
  });
  return { entries, links, settings, settingsFile, settingsText, newSettingsText, stale, state };
}

export function installAgent(p: AgentPaths, opts: InstallOptions = {}): InstallReport {
  // Plan and validate everything first: a refusal leaves the machine untouched.
  const plan = planInstall(p, opts);
  const hookChanges = plan.settings.some(
    (s) => s.leaf.kind === "hook" && ["add", "update", "remove"].includes(s.action),
  );
  const report: InstallReport = {
    paths: p,
    links: plan.links,
    settings: plan.settings,
    settingsFile: plan.settingsFile,
    settingsChanged: plan.newSettingsText !== null,
    stale: plan.stale,
    pruned: [],
    backupDir: null,
    hookChanges,
    dryRun: Boolean(opts.dryRun),
  };
  if (opts.dryRun) return report;

  const backup = new Backup(p);
  for (const lp of plan.links) {
    const dst = path.join(p.home, lp.entry.rel);
    if (lp.action === "none" || lp.action === "keep" || lp.action === "conflict") continue;
    if (lp.action === "replace") backup.take(p.home, lp.entry.rel, "move");
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (lp.entry.kind === "bundled-skill") fs.cpSync(lp.entry.src, dst, { recursive: true });
    else fs.symlinkSync(lp.entry.src, dst);
  }

  if (plan.newSettingsText !== null) {
    // Refuse if the settings changed while we were planning.
    if ((readText(plan.settingsFile) ?? "") !== plan.settingsText) {
      throw new Error(`${plan.settingsFile} changed during install; run it again`);
    }
    if (fs.existsSync(plan.settingsFile)) backup.take(p.home, p.agent.settingsFile, "copy");
    atomicWrite(plan.settingsFile, plan.newSettingsText);
  }

  if (opts.prune) {
    for (const rel of plan.stale) {
      fs.unlinkSync(path.join(p.home, rel));
      report.pruned.push(rel);
    }
  }

  const settingsState: Record<string, Json> = { ...plan.state.settings };
  for (const s of plan.settings) {
    if (s.action === "ok" || s.action === "add" || s.action === "update") {
      settingsState[s.id] = clone(s.wanted as Json);
    } else if (s.action === "remove" || s.action === "edited-kept") delete settingsState[s.id];
  }
  const links = plan.links
    .filter((l) => l.entry.kind !== "bundled-skill" && l.action !== "conflict")
    .map((l) => l.entry.rel);
  const keptStale = opts.prune ? [] : plan.stale;
  writeState(p, {
    vault: path.dirname(path.dirname(p.profile)),
    links: [...links, ...keptStale].sort(),
    settings: settingsState,
  });
  report.backupDir = backup.finish(p.home);
  return report;
}

// ---------------------------------------------------------------------------
// Status

export interface StatusReport extends InstallReport {
  overrideActive: string | null;
  localSkills: string[];
}

export function agentStatus(p: AgentPaths): StatusReport {
  const report = installAgent(p, { dryRun: true });
  const override = p.agent.instructionsOverride
    ? path.join(p.home, p.agent.instructionsOverride)
    : null;
  const managed = new Set(report.links.map((l) => l.entry.rel));
  const localSkills: string[] = [];
  const skillRoot = path.join(p.home, p.agent.skillsDir);
  if (fs.existsSync(skillRoot)) {
    for (const entry of fs.readdirSync(skillRoot, { withFileTypes: true })) {
      const rel = `${p.agent.skillsDir}/${entry.name}`;
      if (entry.name.startsWith(".") || managed.has(rel)) continue;
      const abs = path.join(skillRoot, entry.name);
      if (fs.existsSync(path.join(abs, "SKILL.md"))) localSkills.push(entry.name);
    }
  }
  return {
    ...report,
    overrideActive: override && fs.existsSync(override) ? override : null,
    localSkills: localSkills.sort(),
  };
}

// ---------------------------------------------------------------------------
// Save: capture something set up on this machine into the vault

export interface SaveResult {
  saved: { rel: string; vaultPath: string }[];
  settings: { key: string; value: Json }[];
  /** Vault-relative paths written, for the commit. */
  touched: string[];
  backupDir: string | null;
}

function vaultTarget(p: AgentPaths, rel: string, isDir: boolean): string {
  if (rel === p.agent.instructionsFile) return path.join(p.profile, INSTRUCTIONS);
  const skillPrefix = `${p.agent.skillsDir}/`;
  if (rel.startsWith(skillPrefix)) {
    const name = rel.slice(skillPrefix.length);
    if (!isDir || name.includes("/")) {
      throw new Error(`${rel}: save a whole skill folder (${p.agent.skillsDir}/<name>)`);
    }
    return path.join(p.profile, SKILLS, name);
  }
  return path.join(p.profile, FILES, rel);
}

/** Refuse anything inside a directory that should not land in a vault. */
function checkTree(p: AgentPaths, abs: string, rel: string): void {
  const st = fs.lstatSync(abs);
  if (st.isSymbolicLink())
    throw new Error(`${rel} is a symlink; save the file it points to instead`);
  checkManageable(p, rel, "save");
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(abs)) checkTree(p, path.join(abs, name), `${rel}/${name}`);
  }
}

/** Every ancestor of target inside the vault must be a real directory (no symlink escapes). */
function checkVaultParents(vaultDir: string, target: string): void {
  let dir = path.dirname(target);
  while (dir.startsWith(vaultDir) && dir !== vaultDir) {
    if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) {
      throw new Error(`${dir} is a symlink; refusing to write through it`);
    }
    dir = path.dirname(dir);
  }
}

export function saveToProfile(
  p: AgentPaths,
  vaultDir: string,
  rels: string[],
  settingKeys: string[],
  opts: { force?: boolean } = {},
): SaveResult {
  const result: SaveResult = { saved: [], settings: [], touched: [], backupDir: null };

  // Validate everything before changing anything.
  const jobs = rels.map((input) => {
    const rel = normalizeRel(input);
    const abs = path.join(p.home, rel);
    if (!fs.existsSync(abs) && !fs.lstatSync(abs, { throwIfNoEntry: false })) {
      throw new Error(`${rel} does not exist in ${p.home}`);
    }
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) {
      const target = readLinkAbs(abs);
      if (target?.startsWith(`${p.profile}${path.sep}`)) return null; // already saved
      throw new Error(`${rel} is a symlink to ${target}; save the file it points to instead`);
    }
    checkTree(p, abs, rel);
    if (st.isDirectory() && !rel.startsWith(`${p.agent.skillsDir}/`)) {
      throw new Error(`${rel} is a folder; save its files one by one`);
    }
    if (st.isDirectory() && !fs.existsSync(path.join(abs, "SKILL.md"))) {
      throw new Error(`${rel} has no SKILL.md`);
    }
    const target = vaultTarget(p, rel, st.isDirectory());
    checkVaultParents(vaultDir, target);
    if (fs.existsSync(target) && !opts.force) {
      throw new Error(
        `${toRel(path.relative(vaultDir, target))} already exists in the vault (use --force to overwrite)`,
      );
    }
    return { rel, abs, target, isDir: st.isDirectory() };
  });

  const fragmentFile = path.join(p.profile, p.agent.settingsFile);
  let fragmentText: string | null = null;
  if (settingKeys.length > 0) {
    const current = parseSettings(
      readText(path.join(p.home, p.agent.settingsFile)) ?? "",
      p.agent.format,
      p.agent.settingsFile,
    );
    const fragment = parseSettings(
      readText(fragmentFile) ?? "",
      p.agent.format,
      `vault ${p.agent.settingsFile}`,
    );
    for (const key of settingKeys) {
      const keyPath = key.split(".").filter(Boolean);
      if (keyPath.length === 0) throw new Error(`Empty setting key: ${key}`);
      if (keyPath[0] === "hooks") {
        throw new Error("Hooks are not saved by key; add them to the vault fragment by hand");
      }
      const value = getAt(current, { kind: "key", path: keyPath });
      if (value === undefined) throw new Error(`${key} is not set in ${p.agent.settingsFile}`);
      setAt(fragment, { kind: "key", path: keyPath }, clone(value));
      result.settings.push({ key, value });
    }
    fragmentLeaves(fragment, p.agent); // validates the result
    fragmentText =
      p.agent.format === "json"
        ? `${JSON.stringify(fragment, null, 2)}\n`
        : stringifyToml(fragment as never);
  }

  const backup = new Backup(p);
  const state = readState(p);
  for (const job of jobs) {
    if (!job) continue;
    if (fs.existsSync(job.target)) fs.rmSync(job.target, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(job.target), { recursive: true });
    fs.cpSync(job.abs, job.target, { recursive: true, preserveTimestamps: true });
    backup.take(p.home, job.rel, "move");
    fs.symlinkSync(job.target, job.abs);
    result.saved.push({ rel: job.rel, vaultPath: job.target });
    result.touched.push(toRel(path.relative(vaultDir, job.target)));
    if (!state.links.includes(job.rel)) state.links.push(job.rel);
  }
  if (fragmentText !== null) {
    checkVaultParents(vaultDir, fragmentFile);
    atomicWrite(fragmentFile, fragmentText);
    result.touched.push(toRel(path.relative(vaultDir, fragmentFile)));
    for (const s of result.settings) {
      state.settings[leafId({ kind: "key", path: s.key.split(".").filter(Boolean) })] = clone(
        s.value,
      );
    }
  }
  state.vault = vaultDir;
  state.links.sort();
  writeState(p, state);
  result.backupDir = backup.finish(p.home);
  return result;
}
