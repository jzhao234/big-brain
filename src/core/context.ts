/**
 * Session context: the few notes an agent should see when it starts work in
 * a directory, chosen deterministically so it never has to remember to look.
 *
 *   1. The git repository's remote (owner/repo) is matched against notes'
 *      `repos:` frontmatter. Exactly one owning note is shown (summary, status,
 *      open tasks); notes listing the repo in `related_repos:` are named only.
 *   2. Otherwise the longest `context.paths` rule in brain.config.json whose
 *      `path` contains the directory picks the notes and project folder to show.
 *   3. Otherwise a short list of active projects.
 *
 * Output is capped at `context.maxChars` so a hook can never flood a session.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectStatus, summarizeProject } from "./projects.js";
import { compareTasks } from "./tasks.js";
import type { ContextPathRule, Note, TaskItem } from "./types.js";
import { asStringArray } from "./util.js";
import type { Vault } from "./vault.js";

export interface ContextOptions {
  /** Working directory to describe. */
  cwd: string;
  /** Overrides `context.maxChars`. */
  maxChars?: number;
  /** Home directory for `~` in path rules (injectable for tests). */
  home?: string;
}

export interface SessionContext {
  /** What chose the content. */
  source: "repo" | "path" | "overview";
  /** owner/repo of the working directory, when it has a remote. */
  repo?: string;
  /** Path of the note shown in full, for `source: "repo"`. */
  note?: string;
  text: string;
}

const GIT_TIMEOUT_MS = 3_000;
const MAX_TASKS = 10;
const MAX_PROJECTS = 15;
const MAX_TASK_CHARS = 120;
const TRUNCATED = "\n… (cut to fit; read the note for the rest)";

/**
 * Normalize a git remote or a frontmatter entry to lowercase `owner/repo`:
 * `git@github.com:Owner/Repo.git`, `https://github.com/owner/repo`,
 * `ssh://git@host/owner/repo.git` and `owner/repo` all qualify.
 */
export function repoSlug(input: string): string | undefined {
  const s = input
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  if (s === "") return undefined;
  let pathname: string;
  const scp = /^[^\s/@]+@[^\s:/]+:(.+)$/.exec(s);
  if (scp) pathname = scp[1]!;
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try {
      pathname = new URL(s).pathname;
    } catch {
      return undefined;
    }
  } else pathname = s;
  const parts = pathname.split("/").filter(Boolean);
  const owner = parts[parts.length - 2];
  const repo = parts[parts.length - 1];
  // Owner and repository names are plain words: anything else (spaces, a
  // stray colon) means the input was not a repository reference.
  const plain = /^[\w.-]+$/;
  if (owner === undefined || repo === undefined || !plain.test(owner) || !plain.test(repo)) {
    return undefined;
  }
  return `${owner}/${repo}`.toLowerCase();
}

/** The repos a note lists under a frontmatter key, normalized. */
export function noteRepos(note: Note, key: "repos" | "related_repos"): string[] {
  return asStringArray(note.frontmatter[key])
    .map(repoSlug)
    .filter((r): r is string => r !== undefined);
}

/** owner/repo of the directory's git remote (origin first), if any. */
export function gitRepoSlug(cwd: string): string | undefined {
  const run = (args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: GIT_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }).trim();
  try {
    const remotes = run(["remote"]).split("\n").filter(Boolean);
    const remote = remotes.includes("origin") ? "origin" : remotes[0];
    return remote === undefined ? undefined : repoSlug(run(["remote", "get-url", remote]));
  } catch {
    return undefined; // not a repository, no git, or a hung remote helper
  }
}

export function sessionContext(vault: Vault, opts: ContextOptions): SessionContext {
  const maxChars = opts.maxChars ?? vault.config.context.maxChars;
  const footer = `\n---\nVault: ${vault.dir}. This is a summary: read a note in full with read_note or \`big-brain show\`, look things up with search_notes or \`big-brain search\`, and check GitHub for code history before asking the user.`;
  const budget = Math.max(0, maxChars - footer.length);
  const notes = vault.notes();
  const repo = gitRepoSlug(opts.cwd);

  if (repo !== undefined) {
    const owners = notes.filter((n) => noteRepos(n, "repos").includes(repo));
    const related = notes.filter(
      (n) => !owners.includes(n) && noteRepos(n, "related_repos").includes(repo),
    );
    if (owners.length === 1) {
      const owner = owners[0]!;
      const parts = [
        `# Brain context: ${owner.title}`,
        `Repository ${repo} belongs to ${owner.path} (status: ${statusOf(owner)}).`,
        summaryOf(owner),
        tasksBlock(owner),
        related.length > 0
          ? `Related notes (not loaded): ${related.map((n) => `${n.title} (${n.path})`).join("; ")}`
          : "",
      ];
      return { source: "repo", repo, note: owner.path, text: clip(parts, budget) + footer };
    }
    if (owners.length > 1) {
      // Never guess between owners: two notes claiming one repo is a vault
      // error (doctor reports it), and loading both could mix two clients.
      const parts = [
        `# Brain context: ${repo}`,
        `Several notes list ${repo} under repos:, so none was loaded: ${owners.map((n) => `${n.title} (${n.path})`).join("; ")}. Read the right one before starting.`,
      ];
      return { source: "repo", repo, text: clip(parts, budget) + footer };
    }
  }

  const rule = matchPathRule(vault.config.context.paths, opts.cwd, opts.home ?? os.homedir());
  if (rule) {
    const parts = [
      `# Brain context (${vault.config.name})`,
      `Working directory is under ${rule.path}.`,
    ];
    for (const ref of rule.notes ?? []) {
      const note = vault.get(ref);
      if (note) parts.push(`## ${note.title} (${note.path})\n${summaryOf(note)}`);
    }
    if (rule.projects !== undefined) parts.push(projectsBlock(notes, rule.projects));
    return { source: "path", repo, text: clip(parts, budget) + footer };
  }

  const parts = [`# Brain context (${vault.config.name})`, projectsBlock(notes, "")];
  return { source: "overview", repo, text: clip(parts, budget) + footer };
}

/** The longest rule whose path contains `cwd` (both compared as real paths). */
export function matchPathRule(
  rules: ContextPathRule[],
  cwd: string,
  home: string,
): ContextPathRule | undefined {
  const here = realPath(cwd);
  let best: { rule: ContextPathRule; length: number } | undefined;
  for (const rule of rules) {
    const expanded =
      rule.path === "~" || rule.path.startsWith("~/") ? home + rule.path.slice(1) : rule.path;
    const root = realPath(expanded);
    const inside =
      here === root || here.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
    if (inside && (best === undefined || root.length > best.length)) {
      best = { rule, length: root.length };
    }
  }
  return best?.rule;
}

function realPath(p: string): string {
  try {
    return fs.realpathSync(path.resolve(p));
  } catch {
    return path.resolve(p);
  }
}

function statusOf(note: Note): string {
  if (note.type === "project") return projectStatus(note);
  const status = note.frontmatter.status;
  return status === undefined || status === null ? "none" : String(status);
}

/**
 * The note's `Summary` (or `Overview`, or `Goal`) section; without one, the
 * text before its first section; without that, its excerpt.
 */
export function summaryOf(note: Note): string {
  const lines = note.body.split("\n");
  const heading = ["summary", "overview", "goal"]
    .map((name) => note.headings.find((h) => h.text.trim().toLowerCase() === name))
    .find((h) => h !== undefined);
  let section: string[];
  if (heading) {
    const next = note.headings.find((h) => h.line > heading.line && h.depth <= heading.depth);
    section = lines.slice(heading.line + 1, next?.line ?? lines.length);
  } else {
    const first = note.headings.find((h) => h.depth >= 2);
    section = lines
      .slice(0, first?.line ?? lines.length)
      .filter((_, i) => !note.headings.some((h) => h.depth === 1 && h.line === i));
  }
  const text = section.join("\n").trim();
  return text === "" ? note.excerpt : text;
}

function taskLine(t: TaskItem): string {
  const due = t.due ? ` 📅 ${t.due}` : "";
  const prio = t.priority === "high" ? " ⏫" : "";
  return `- [ ] ${t.text}${prio}${due}`;
}

function tasksBlock(note: Note): string {
  const open = note.tasks.filter((t) => !t.done && !t.cancelled).sort(compareTasks);
  if (open.length === 0) return "Open tasks: none.";
  const shown = open.slice(0, MAX_TASKS).map(taskLine);
  const more =
    open.length > MAX_TASKS ? `\n- …and ${open.length - MAX_TASKS} more in the note` : "";
  return `Open tasks (${open.length}):\n${shown.join("\n")}${more}`;
}

function projectsBlock(notes: Note[], folder: string): string {
  const prefix = folder.replace(/\/+$/, "");
  const projects = notes
    .filter((n) => n.type === "project" && (prefix === "" || n.path.startsWith(`${prefix}/`)))
    .map(summarizeProject)
    .filter((p) => p.status === "active")
    .sort((a, b) => b.updatedMs - a.updatedMs);
  const label = prefix === "" ? "Active projects" : `Active projects in ${prefix}/`;
  if (projects.length === 0) return `${label}: none.`;
  const rows = projects.slice(0, MAX_PROJECTS).map((p) => {
    const next = p.nextTasks[0] ? `: next "${clipLine(p.nextTasks[0].text, MAX_TASK_CHARS)}"` : "";
    return `- ${p.title} (${p.path})${next}`;
  });
  const more =
    projects.length > MAX_PROJECTS ? `\n- …and ${projects.length - MAX_PROJECTS} more` : "";
  return `${label}, most recently touched first:\n${rows.join("\n")}${more}`;
}

function clipLine(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Join non-empty parts, cutting at a line break so the result fits `budget`. */
function clip(parts: string[], budget: number): string {
  const text = parts.filter((p) => p.trim() !== "").join("\n\n");
  if (text.length <= budget) return text;
  const room = Math.max(0, budget - TRUNCATED.length);
  const cut = text.lastIndexOf("\n", room);
  return `${text.slice(0, cut > 0 ? cut : room)}${TRUNCATED}`;
}

/** Wrap context text in a coding agent's session-start hook output. */
export function hookOutput(format: "claude" | "codex" | "agy", text: string): string {
  if (format === "agy") {
    return JSON.stringify({ injectSteps: [{ systemMessage: { systemMessage: text } }] });
  }
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text },
  });
}
