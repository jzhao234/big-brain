import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import {
  AGENTS,
  type AgentDef,
  deepEqual,
  defaultSystem,
  moveAcross,
  type SystemEnv,
  stateDir,
} from "./agents.js";
import { parseFrontmatter } from "./frontmatter.js";
import {
  generatedUnedited,
  hashFiles,
  hashTree,
  markerLine,
  readMarker,
  readTree,
  type SkillFiles,
} from "./skill-marker.js";

/**
 * Skills written once and rendered for each agent.
 *
 * A source is a skill folder whose SKILL.md may use, beyond `name` and
 * `description`:
 *
 * - `agents: [claude, codex]`: which agents get it (default: every agent the
 *   caller names, for a vault the agents with a profile folder);
 * - `invocation: explicit`: run only when the user asks for it by name;
 * - `claude:`, `codex:`, `agy:` maps: frontmatter for that agent only, over
 *   the shared keys (`codex: { openai: ... }` becomes agents/openai.yaml);
 * - `{{/name}}` for how the user runs a skill (`/name`, or `$name` in Codex),
 *   `{{agent}}` for the agent's name and `{{agent.name}}` for its id;
 * - lines `<!-- only: codex -->` ... `<!-- /only -->` around text for some
 *   agents.
 *
 * Every Markdown file in the folder is a template; other files are copied
 * byte for byte. Rendering is deterministic: the same source always gives the
 * same files, so a copy can be checked against its source.
 */

const SKILL = "SKILL.md";
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED = new Set(["name", "description", "agents", "invocation"]);
const OPENAI_KEY = "openai";
const OPENAI_FILE = "agents/openai.yaml";

export interface SkillSource {
  name: string;
  dir: string;
  /** Agents this skill renders for, in table order. */
  agents: AgentDef[];
  explicit: boolean;
  description: string;
  /** Shared frontmatter keys other than name and description, in source order. */
  shared: Record<string, unknown>;
  /** Per-agent frontmatter maps. */
  perAgent: Map<string, Record<string, unknown>>;
  /** SKILL.md body and every other file. */
  body: string;
  files: SkillFiles;
}

function isMap(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function fail(dir: string, message: string): never {
  throw new Error(`${path.basename(dir)}: ${message}`);
}

/**
 * Read and check a skill source.
 * @param defaults the agents a source without `agents:` renders for
 * @param known every agent a source may name (default: big-brain's table)
 */
export function loadSkillSource(
  dir: string,
  defaults: readonly AgentDef[],
  known: readonly AgentDef[] = AGENTS,
): SkillSource {
  const files = readTree(dir);
  const raw = files.get(SKILL);
  if (!raw) fail(dir, `no ${SKILL}`);
  if (files.has(OPENAI_FILE)) {
    fail(dir, `write ${OPENAI_FILE} under codex: openai: in ${SKILL}, not as a file`);
  }
  files.delete(SKILL);

  let parsed: { data: Record<string, unknown>; content: string };
  try {
    parsed = parseFrontmatter(raw.bytes.toString("utf8"));
  } catch (err) {
    fail(dir, `frontmatter: ${err instanceof Error ? err.message : String(err)}`);
  }
  const { data, content } = parsed;
  const name = data.name;
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    fail(dir, "name must be lowercase words joined by hyphens");
  }
  if (name !== path.basename(dir)) fail(dir, `name is ${name}, but the folder is not`);
  const description = data.description;
  if (typeof description !== "string" || description.trim() === "") {
    fail(dir, "description is missing");
  }

  const byName = new Map(known.map((a) => [a.name, a]));
  let agents: AgentDef[];
  const listed = data.agents;
  if (listed === undefined) {
    agents = [...defaults];
  } else {
    if (!Array.isArray(listed) || listed.length === 0) {
      fail(dir, "agents must be a list of agent names");
    }
    const seen = new Set<string>();
    for (const a of listed) {
      if (typeof a !== "string" || !byName.has(a)) {
        fail(
          dir,
          `unknown agent in agents: ${String(a)} (known: ${[...byName.keys()].join(", ")})`,
        );
      }
      if (seen.has(a)) fail(dir, `${a} is listed twice in agents`);
      seen.add(a);
    }
    agents = known.filter((a) => seen.has(a.name));
  }

  const invocation = data.invocation ?? "auto";
  if (invocation !== "auto" && invocation !== "explicit") {
    fail(dir, "invocation must be auto or explicit");
  }

  const shared: Record<string, unknown> = {};
  const perAgent = new Map<string, Record<string, unknown>>();
  for (const [key, value] of Object.entries(data)) {
    if (RESERVED.has(key)) continue;
    if (!byName.has(key)) {
      shared[key] = value;
      continue;
    }
    if (!isMap(value)) fail(dir, `${key}: must be a map of frontmatter keys`);
    if (listed !== undefined && !agents.some((a) => a.name === key)) {
      fail(dir, `${key}: has settings, but ${key} is not in agents`);
    }
    for (const reserved of ["name", "agents", "invocation"]) {
      if (reserved in value) fail(dir, `${key}.${reserved}: set it once, at the top`);
    }
    if (OPENAI_KEY in value && key !== "codex") {
      fail(dir, `${key}.${OPENAI_KEY}: only Codex reads agents/openai.yaml`);
    }
    perAgent.set(key, value);
  }

  return {
    name,
    dir,
    agents,
    explicit: invocation === "explicit",
    description,
    shared,
    perAgent,
    body: content,
    files,
  };
}

// ---------------------------------------------------------------------------
// Rendering one agent's copy

const PLACEHOLDER_RE = /\{\{(\/[a-z0-9]+(?:-[a-z0-9]+)*|agent|agent\.name)\}\}/g;

function fill(text: string, agent: AgentDef): string {
  return text.replace(PLACEHOLDER_RE, (_, key: string) =>
    key === "agent"
      ? agent.skill.shortLabel
      : key === "agent.name"
        ? agent.name
        : `${agent.skill.prefix}${key.slice(1)}`,
  );
}

function fillDeep(value: unknown, agent: AgentDef): unknown {
  if (typeof value === "string") return fill(value, agent);
  if (Array.isArray(value)) return value.map((v) => fillDeep(v, agent));
  if (isMap(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillDeep(v, agent)]));
  }
  return value;
}

const ONLY_OPEN_RE = /^\s*<!--\s*only:\s*(.*?)\s*-->\s*$/;
const ONLY_CLOSE_RE = /^\s*<!--\s*\/only\s*-->\s*$/;
// A fence may sit after list markers or blockquote `>`s, at any indent, so
// code inside a list item counts as code too.
const FENCE_RE = /^\s*(?:(?:[-*+]|\d{1,9}[.)])\s+|>\s?)*(`{3,}|~{3,})(.*)$/;

/**
 * Keep the lines meant for `agent`: text inside `<!-- only: ... -->` blocks
 * survives only for the agents named. Markers inside fenced code are text.
 * A dropped block takes one of the blank lines around it along, so the
 * paragraphs on either side stay one blank line apart.
 */
export function selectLines(
  text: string,
  agent: AgentDef,
  known: readonly AgentDef[],
  where: string,
): string {
  const names = new Set(known.map((a) => a.name));
  const out: string[] = [];
  let fence: string | null = null;
  let only: Set<string> | null = null;
  let openedAt = 0;
  let collapse = false;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const bare = line.replace(/\r$/, "");
    if (fence === null) {
      const open = ONLY_OPEN_RE.exec(bare);
      if (open) {
        if (only) throw new Error(`${where}:${i + 1}: an only block inside another`);
        const listed = (open[1] as string)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (listed.length === 0) throw new Error(`${where}:${i + 1}: only names no agent`);
        for (const n of listed) {
          if (!names.has(n)) throw new Error(`${where}:${i + 1}: unknown agent ${n}`);
        }
        only = new Set(listed);
        openedAt = i + 1;
        continue;
      }
      if (ONLY_CLOSE_RE.test(bare)) {
        if (!only) throw new Error(`${where}:${i + 1}: /only without an opening only`);
        only = null;
        collapse = true;
        continue;
      }
    }
    const fenceMatch = FENCE_RE.exec(bare);
    if (fence === null && fenceMatch) {
      // A backtick fence's info string can't hold a backtick (that's inline code).
      const ticks = fenceMatch[1] as string;
      if (!(ticks[0] === "`" && (fenceMatch[2] as string).includes("`"))) fence = ticks;
    } else if (
      fence !== null &&
      fenceMatch &&
      (fenceMatch[1] as string)[0] === fence[0] &&
      (fenceMatch[1] as string).length >= fence.length &&
      (fenceMatch[2] as string).trim() === ""
    ) {
      fence = null;
    }
    if (only && !only.has(agent.name)) continue;
    if (collapse && bare.trim() === "" && (out.length === 0 || out.at(-1)?.trim() === "")) {
      collapse = false;
      continue;
    }
    collapse = false;
    out.push(line);
  }
  if (only) throw new Error(`${where}:${openedAt}: only block is never closed`);
  return out.join("\n");
}

function guardSentence(source: SkillSource, agent: AgentDef): string {
  return `Use it only when the user types ${agent.skill.prefix}${source.name}; never start it on your own.`;
}

/** Frontmatter and agents/openai.yaml content for one agent. */
function agentMetadata(
  source: SkillSource,
  agent: AgentDef,
): { frontmatter: Record<string, unknown>; openai?: Record<string, unknown> } {
  const own = { ...(source.perAgent.get(agent.name) ?? {}) };
  let openai = own[OPENAI_KEY] as unknown;
  delete own[OPENAI_KEY];
  if (openai !== undefined && !isMap(openai)) fail(source.dir, "codex.openai must be a map");

  const frontmatter: Record<string, unknown> = { name: source.name };
  frontmatter.description = source.description;
  Object.assign(frontmatter, source.shared, own);
  if (typeof frontmatter.description !== "string" || frontmatter.description.trim() === "") {
    fail(source.dir, `${agent.name}.description must be text`);
  }

  if (source.explicit) {
    const how = agent.skill.explicitOnly;
    if (how === "frontmatter") {
      if (frontmatter["disable-model-invocation"] === false) {
        fail(source.dir, "invocation: explicit, but disable-model-invocation is false");
      }
      frontmatter["disable-model-invocation"] = true;
    } else if (how === "openai-policy") {
      const base = (openai as Record<string, unknown> | undefined) ?? {};
      const policy = base.policy ?? {};
      if (!isMap(policy)) fail(source.dir, "codex.openai.policy must be a map");
      if (policy.allow_implicit_invocation === true) {
        fail(source.dir, "invocation: explicit, but allow_implicit_invocation is true");
      }
      openai = { ...base, policy: { ...policy, allow_implicit_invocation: false } };
    } else {
      frontmatter.description = `${(frontmatter.description as string).trimEnd()} ${guardSentence(source, agent)}`;
    }
  }

  const allowed = agent.skill.frontmatter;
  if (allowed) {
    for (const key of Object.keys(frontmatter)) {
      if (!allowed.includes(key)) {
        fail(
          source.dir,
          `${agent.label} reads only ${allowed.join(" and ")} in frontmatter; move ${key} under the agents that use it`,
        );
      }
    }
  }
  return {
    frontmatter: fillDeep(frontmatter, agent) as Record<string, unknown>,
    openai: openai === undefined ? undefined : (fillDeep(openai, agent) as Record<string, unknown>),
  };
}

const BARE_KEY_RE = /^[A-Za-z0-9_-]+$/;

/**
 * agents/openai.yaml the way Codex documents it: every string double quoted,
 * keys bare. Plain YAML, re-read before it is returned to prove it says what
 * was meant.
 */
function openaiYaml(value: Record<string, unknown>, dir: string): string {
  const scalar = (v: unknown): string => {
    if (typeof v === "string") return JSON.stringify(v);
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    if (v === null) return "null";
    fail(dir, `codex.openai: unsupported value ${JSON.stringify(v)}`);
  };
  const key = (k: string) => (BARE_KEY_RE.test(k) ? k : JSON.stringify(k));
  const emitMap = (map: Record<string, unknown>, indent: string): string[] => {
    const lines: string[] = [];
    for (const [k, v] of Object.entries(map)) {
      if (isMap(v) && Object.keys(v).length > 0) {
        lines.push(`${indent}${key(k)}:`, ...emitMap(v, `${indent}  `));
      } else if (Array.isArray(v) && v.length > 0) {
        lines.push(`${indent}${key(k)}:`);
        for (const item of v) {
          if (isMap(item) && Object.keys(item).length > 0) {
            const inner = emitMap(item, `${indent}    `);
            inner[0] = `${indent}  - ${(inner[0] as string).trimStart()}`;
            lines.push(...inner);
          } else {
            lines.push(
              `${indent}  - ${isMap(item) ? "{}" : Array.isArray(item) ? "[]" : scalar(item)}`,
            );
          }
        }
      } else {
        lines.push(`${indent}${key(k)}: ${isMap(v) ? "{}" : Array.isArray(v) ? "[]" : scalar(v)}`);
      }
    }
    return lines;
  };
  const text = `${emitMap(value, "").join("\n")}\n`;
  if (!deepEqual(yaml.load(text), value)) fail(dir, "codex.openai: could not write it faithfully");
  return text;
}

function checkOpenai(openai: Record<string, unknown>, source: SkillSource): void {
  const iface = openai.interface;
  if (iface === undefined) return;
  if (!isMap(iface)) fail(source.dir, "codex.openai.interface must be a map");
  const short = iface.short_description;
  if (
    short !== undefined &&
    (typeof short !== "string" || short.length < 25 || short.length > 64)
  ) {
    fail(source.dir, "codex.openai.interface.short_description must be 25 to 64 characters");
  }
  const prompt = iface.default_prompt;
  if (prompt !== undefined && (typeof prompt !== "string" || !prompt.includes(`$${source.name}`))) {
    fail(source.dir, `codex.openai.interface.default_prompt must mention $${source.name}`);
  }
}

/**
 * One agent's copy of a skill, by relative path.
 * @param marker the source path to name in a marker line; no marker when omitted
 */
export function renderSkill(
  source: SkillSource,
  agent: AgentDef,
  opts: { marker?: string; known?: readonly AgentDef[] } = {},
): SkillFiles {
  const known = opts.known ?? AGENTS;
  const { frontmatter, openai } = agentMetadata(source, agent);
  const yamlText = yaml.dump(frontmatter, { lineWidth: 80, noRefs: true, quotingType: '"' });
  const body = selectLines(fill(source.body, agent), agent, known, `${source.name}/${SKILL}`);
  const text = (t: string) => ({ bytes: Buffer.from(t, "utf8"), exec: false });
  const files: SkillFiles = new Map();
  for (const [rel, file] of source.files) {
    files.set(
      rel,
      rel.toLowerCase().endsWith(".md")
        ? {
            bytes: Buffer.from(
              selectLines(
                fill(file.bytes.toString("utf8"), agent),
                agent,
                known,
                `${source.name}/${rel}`,
              ),
              "utf8",
            ),
            exec: file.exec,
          }
        : file,
    );
  }
  if (openai !== undefined) {
    checkOpenai(openai, source);
    files.set(OPENAI_FILE, text(openaiYaml(openai, source.dir)));
  }
  const head = `---\n${yamlText}---\n`;
  files.set(SKILL, text(head + body));
  if (opts.marker !== undefined) {
    const hash = hashFiles(files);
    files.set(SKILL, text(`${head}${markerLine(opts.marker, hash)}\n${body}`));
  }
  return files;
}

// ---------------------------------------------------------------------------
// Rendering a vault's sources into its agent profiles

export type RenderState =
  | "current" // matches its source
  | "missing" // not written yet
  | "stale" // unedited since the last render, but the source changed
  | "edited" // changed by hand since the last render
  | "hand-written" // a folder render did not write is where a copy belongs
  | "orphan" // generated, but its source is gone or no longer lists this agent
  | "orphan-edited"; // the same, and changed by hand since

export type RenderAction = "none" | "write" | "update" | "replace" | "remove" | "keep" | "conflict";

export interface RenderItem {
  skill: string;
  agent: string;
  /** The copy's folder, absolute. */
  dir: string;
  /** The copy's folder relative to the agents folder, e.g. `codex/skills/test`. */
  rel: string;
  state: RenderState;
  action: RenderAction;
  files?: SkillFiles;
  /** Hash of the folder as planned; apply rechecks it so an edit made since is never lost. */
  seen?: string;
}

export interface RenderPlan {
  /** Where sources live (`<agents>/skills`). */
  sourceRoot: string;
  items: RenderItem[];
}

export interface RenderOptions {
  /** Overwrite or remove copies edited by hand, and hand-written folders in the way. */
  replace?: boolean;
  /** Remove generated copies whose source is gone. */
  prune?: boolean;
}

const SOURCES = "skills";

function sameFiles(a: SkillFiles, b: SkillFiles): boolean {
  if (a.size !== b.size) return false;
  for (const [rel, file] of a) {
    const other = b.get(rel);
    if (!other || other.exec !== file.exec || !other.bytes.equals(file.bytes)) return false;
  }
  return true;
}

/**
 * Render reads and writes only real folders inside the vault: a symlinked
 * agents folder, profile, skills folder or source folder could point at
 * another vault, whose copies `--prune` would then delete.
 */
function checkRealFolders(agentsRoot: string, agents: readonly AgentDef[]): void {
  const parts = [
    agentsRoot,
    path.join(agentsRoot, SOURCES),
    ...agents.flatMap((a) => [
      path.join(agentsRoot, a.name),
      path.join(agentsRoot, a.name, "skills"),
    ]),
  ];
  for (const dir of parts) {
    if (fs.lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(`${dir} is a symlink; render only works on real folders in the vault`);
    }
  }
}

/** What `agents render` would do. Throws, before anything changes, on a broken source. */
export function planRender(
  vaultDir: string,
  agentsFolder: string,
  opts: RenderOptions = {},
  known: readonly AgentDef[] = AGENTS,
): RenderPlan {
  const agentsRoot = path.join(vaultDir, agentsFolder);
  const sourceRoot = path.join(agentsRoot, SOURCES);
  checkRealFolders(agentsRoot, known);
  const profiles = known.filter((a) => fs.existsSync(path.join(agentsRoot, a.name)));
  const items: RenderItem[] = [];
  const planned = new Set<string>();

  if (fs.existsSync(sourceRoot)) {
    for (const entry of fs
      .readdirSync(sourceRoot, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue;
      const dir = path.join(sourceRoot, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`${entry.name}: sources cannot be symlinks`);
      if (!entry.isDirectory()) continue;
      const source = loadSkillSource(dir, profiles, known);
      const sourceRel = path.posix.join(agentsFolder, SOURCES, source.name, SKILL);
      for (const agent of source.agents) {
        const rel = `${agent.name}/skills/${source.name}`;
        const out = path.join(agentsRoot, agent.name, "skills", source.name);
        const files = renderSkill(source, agent, { marker: sourceRel, known });
        planned.add(rel);
        items.push({
          skill: source.name,
          agent: agent.name,
          dir: out,
          rel,
          files,
          ...stateOf(out, files, opts),
        });
      }
    }
  }

  for (const agent of profiles) {
    const skillsRoot = path.join(agentsRoot, agent.name, "skills");
    if (!fs.existsSync(skillsRoot)) continue;
    for (const entry of fs
      .readdirSync(skillsRoot, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = `${agent.name}/skills/${entry.name}`;
      if (!entry.isDirectory() || planned.has(rel)) continue;
      const dir = path.join(skillsRoot, entry.name);
      if (!readMarker(dir)) continue; // a hand-written skill: not render's
      let unedited = false;
      try {
        unedited = generatedUnedited(readTree(dir));
      } catch {
        // a symlink inside: not something render wrote
      }
      items.push({
        skill: entry.name,
        agent: agent.name,
        dir,
        rel,
        state: unedited ? "orphan" : "orphan-edited",
        action: !opts.prune ? "keep" : unedited || opts.replace ? "remove" : "conflict",
        seen: hashTree(dir),
      });
    }
  }
  return { sourceRoot, items };
}

function stateOf(
  dir: string,
  files: SkillFiles,
  opts: RenderOptions,
): { state: RenderState; action: RenderAction; seen?: string } {
  const st = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!st) return { state: "missing", action: "write" };
  const conflict = (state: RenderState, seen?: string) => ({
    state,
    action: (opts.replace && !st.isSymbolicLink() ? "replace" : "conflict") as RenderAction,
    seen,
  });
  if (!st.isDirectory() || !readMarker(dir)) return conflict("hand-written");
  let current: SkillFiles;
  try {
    current = readTree(dir);
  } catch {
    return conflict("edited"); // a symlink inside: not something render wrote
  }
  const seen = hashFiles(current);
  if (sameFiles(current, files)) return { state: "current", action: "none", seen };
  if (generatedUnedited(current)) return { state: "stale", action: "update", seen };
  return conflict("edited", seen);
}

export interface RenderResult {
  plan: RenderPlan;
  /** Where copies that held hand edits were saved before being replaced or removed. */
  backupDir: string | null;
  /** Copies that changed after the plan was made; left as they were. */
  changed: RenderItem[];
}

function writeFiles(dir: string, files: SkillFiles): void {
  for (const [rel, { bytes, exec }] of files) {
    const file = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    fs.chmodSync(file, exec ? 0o755 : 0o644);
  }
}

/**
 * Write the plan: new and stale copies, and with the options, replacements
 * and removals. A copy is staged beside the profiles and swapped in; a
 * failed swap puts the old copy back. A copy that held hand edits is moved
 * to big-brain's backups, never deleted. A copy that changed after the plan
 * was made is left as it is and reported, since the plan never saw that edit.
 */
export function applyRender(
  vaultDir: string,
  agentsFolder: string,
  plan: RenderPlan,
  sys: SystemEnv = defaultSystem(),
): RenderResult {
  const agentsRoot = path.join(vaultDir, agentsFolder);
  let backupDir: string | null = null;
  const changed: RenderItem[] = [];
  const backup = (from: string, item: RenderItem): void => {
    backupDir ??= path.join(
      stateDir(sys),
      "backups",
      "render",
      new Date().toISOString().replace(/[:.]/g, "-"),
    );
    const to = path.join(backupDir, item.agent, item.skill);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    moveAcross(from, to);
  };
  const handEdited = (item: RenderItem) =>
    item.state === "edited" || item.state === "hand-written" || item.state === "orphan-edited";

  for (const item of plan.items) {
    const writes = item.action === "write" || item.action === "update" || item.action === "replace";
    if (!writes && item.action !== "remove") continue;
    const exists = fs.lstatSync(item.dir, { throwIfNoEntry: false }) !== undefined;
    if (exists !== (item.action !== "write")) {
      changed.push(item); // created, or removed, since the plan
      continue;
    }
    const tmp = fs.mkdtempSync(path.join(agentsRoot, ".render-"));
    const aside = path.join(tmp, "old");
    const staged = path.join(tmp, "new");
    try {
      if (writes) writeFiles(staged, item.files as SkillFiles);
      if (exists) {
        // Moved aside first, then checked: an edit can't slip in between the
        // check and the swap.
        moveAcross(item.dir, aside);
        if (!handEdited(item) && (item.seen === undefined || hashTree(aside) !== item.seen)) {
          moveAcross(aside, item.dir);
          changed.push(item);
          continue;
        }
      }
      if (writes) {
        try {
          fs.mkdirSync(path.dirname(item.dir), { recursive: true });
          moveAcross(staged, item.dir);
        } catch (err) {
          if (exists) moveAcross(aside, item.dir);
          throw err;
        }
      }
      if (exists) {
        if (handEdited(item)) backup(aside, item);
        else fs.rmSync(aside, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  return { plan, backupDir, changed };
}
