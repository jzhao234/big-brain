#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import pc from "picocolors";
import {
  AGENTS,
  type AgentDef,
  type InstallReport,
  agentPaths,
  agentStatus,
  getAgent,
  installAgent,
  leafLabel,
  saveToProfile,
} from "../core/agents.js";
import { resolveVault } from "../core/config.js";
import { getDailyNote, logToDaily } from "../core/daily.js";
import { runDoctor } from "../core/doctor.js";
import { SemanticIndex, createEmbeddingProvider, hybridSearch } from "../core/embeddings.js";
import { parseFrontmatterAssignments } from "../core/frontmatter.js";
import { renderOverview, vaultOverview } from "../core/overview.js";
import { createProject, listProjects, setProjectStatus } from "../core/projects.js";
import { relatedNotes } from "../core/related.js";
import { initVault } from "../core/scaffold.js";
import { defaultClaudeSkillsDir, installSkills } from "../core/skills.js";
import { type TaskStatus, addTask, completeTask, listTasks, updateTask } from "../core/tasks.js";
import type { TaskItem } from "../core/types.js";
import { todayISO } from "../core/util.js";
import { Vault } from "../core/vault.js";

const program = new Command();

program
  .name("big-brain")
  .description("A plain-markdown second brain for humans and LLMs")
  .version("0.2.0")
  .option(
    "--vault <dir>",
    "vault directory (default: $BIG_BRAIN_VAULT or nearest brain.config.json)",
  );

function openVault(): Vault {
  const opts = program.opts<{ vault?: string }>();
  return new Vault(resolveVault(opts.vault));
}

function fail(err: unknown): never {
  console.error(pc.red(err instanceof Error ? err.message : String(err)));
  process.exit(1);
}

function taskLine(t: TaskItem): string {
  const box = t.done ? pc.green("[x]") : t.cancelled ? pc.dim("[-]") : "[ ]";
  const due = t.due ? pc.yellow(` 📅 ${t.due}`) : "";
  const prio = t.priority === "high" ? pc.red(" ⏫") : t.priority === "low" ? " 🔽" : "";
  return `${pc.dim(t.id)} ${box} ${t.text}${prio}${due} ${pc.dim(`(${t.noteTitle})`)}`;
}

function parseLimit(value: string): number {
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error(`Invalid limit: ${value} (want a positive integer)`);
  }
  return limit;
}

program
  .command("init [dir]")
  .description("scaffold a new vault (folders, templates, starter notes)")
  .option("--name <name>", "vault display name")
  .option("--force", "overwrite existing files")
  .action((dir: string | undefined, opts: { name?: string; force?: boolean }) => {
    try {
      const result = initVault(dir ?? ".", opts);
      console.log(pc.green(`Vault ready at ${result.dir}`));
      for (const f of result.written) console.log(`  ${pc.green("+")} ${f}`);
      for (const f of result.skipped) console.log(`  ${pc.dim(`= ${f} (kept existing)`)}`);
      console.log(
        `\nNext: ${pc.bold("big-brain status")} in that directory, or wire up the MCP server (see README).`,
      );
    } catch (err) {
      fail(err);
    }
  });

program
  .command("status")
  .description("overview: active projects, due tasks, inbox, recent notes")
  .action(() => {
    try {
      console.log(renderOverview(vaultOverview(openVault())));
    } catch (err) {
      fail(err);
    }
  });

program
  .command("search <query...>")
  .description("full-text search")
  .option("-t, --type <type>", "note type filter")
  .option("--tag <tag>", "tag filter")
  .option("-f, --folder <folder>", "folder prefix filter")
  .option("-s, --status <status>", "frontmatter status filter")
  .option("-n, --limit <n>", "max results", "20")
  .option("--lexical", "full-text only (skip semantic fusion even if enabled)")
  .option("--json", "JSON output")
  .action(async (words: string[], opts: Record<string, string | boolean>) => {
    try {
      const vault = openVault();
      const searchOpts = {
        type: opts.type as string | undefined,
        tag: opts.tag as string | undefined,
        folder: opts.folder as string | undefined,
        status: opts.status as string | undefined,
        limit: parseLimit(String(opts.limit)),
      };
      const query = words.join(" ");
      const results = opts.lexical
        ? vault.search(query, searchOpts)
        : await hybridSearch(vault, query, searchOpts);
      if (opts.json) return console.log(JSON.stringify(results, null, 2));
      if (results.length === 0) return console.log(pc.dim("No matches."));
      for (const r of results) {
        const sem = r.matches.includes("semantic") ? pc.cyan(" ~") : "";
        console.log(`${pc.bold(r.title)}${sem} ${pc.dim(`(${r.type}) ${r.path}`)}`);
        if (r.excerpt) console.log(`  ${pc.dim(r.excerpt.slice(0, 120))}`);
      }
    } catch (err) {
      fail(err);
    }
  });

program
  .command("related <ref...>")
  .description("notes related to a note (links, shared tags, mentions, semantic)")
  .option("-n, --limit <n>", "max results", "8")
  .option("--json", "JSON output")
  .action(async (refWords: string[], opts: { limit: string; json?: boolean }) => {
    try {
      const vault = openVault();
      const results = await relatedNotes(vault, refWords.join(" "), {
        limit: parseLimit(opts.limit),
      });
      if (opts.json) return console.log(JSON.stringify(results, null, 2));
      if (results.length === 0) return console.log(pc.dim("No related notes found."));
      for (const r of results) {
        console.log(`${pc.bold(r.title)} ${pc.dim(`(${r.type}) ${r.path}`)}`);
        console.log(`  ${pc.dim(r.reasons.join(" · "))}`);
      }
    } catch (err) {
      fail(err);
    }
  });

program
  .command("index")
  .description("build/refresh the local semantic index (requires embeddings.enabled)")
  .option("--rebuild", "discard and re-embed everything")
  .option("--status", "show index status only")
  .action(async (opts: { rebuild?: boolean; status?: boolean }) => {
    try {
      if (opts.status && opts.rebuild) {
        throw new Error("Cannot combine --status with --rebuild");
      }
      const vault = openVault();
      if (!vault.config.embeddings.enabled) {
        return console.log(
          pc.yellow(
            'Embeddings are off. Enable with "embeddings": { "enabled": true } in brain.config.json.',
          ),
        );
      }
      if (opts.status) {
        const index = new SemanticIndex(vault.dir, vault.config.embeddings.model);
        const s = index.status();
        const stale = index.stale(vault.notes(true)).length;
        return console.log(
          `model ${s.model} · ${s.notes} notes · ${s.chunks} chunks · ${(s.sizeBytes / 1024).toFixed(0)}KB · ${stale} stale`,
        );
      }
      const provider = await createEmbeddingProvider(vault.config.embeddings);
      if (opts.rebuild) {
        const { INDEX_DIR, INDEX_FILE } = await import("../core/embeddings.js");
        const { rmSync } = await import("node:fs");
        rmSync(path.join(vault.dir, INDEX_DIR, INDEX_FILE), { force: true });
      }
      const index = new SemanticIndex(vault.dir, provider.id);
      const embedded = await index.ensure(vault.notes(true), provider);
      const s = index.status();
      console.log(
        pc.green(
          `Indexed ${embedded} changed note${embedded === 1 ? "" : "s"} (${s.notes} total, ${s.chunks} chunks, ${(s.sizeBytes / 1024).toFixed(0)}KB).`,
        ),
      );
    } catch (err) {
      fail(err);
    }
  });

program
  .command("show <ref...>")
  .description("print a note (by path, title, or alias)")
  .action((refWords: string[]) => {
    try {
      const vault = openVault();
      const note = vault.get(refWords.join(" "));
      if (!note) fail(new Error(`Note not found: ${refWords.join(" ")}`));
      console.log(pc.dim(`# ${note.path}`));
      console.log(note.raw.trimEnd());
    } catch (err) {
      fail(err);
    }
  });

program
  .command("new <title...>")
  .description("create a note")
  .option("-t, --type <type>", "note|project|person|reference|area", "note")
  .option("--tags <tags>", "comma-separated tags")
  .option("-b, --body <body>", "initial markdown body")
  .action((titleWords: string[], opts: { type: string; tags?: string; body?: string }) => {
    try {
      const vault = openVault();
      const note = vault.createNote({
        title: titleWords.join(" "),
        type: opts.type,
        tags: opts.tags
          ?.split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        body: opts.body,
      });
      console.log(pc.green(`Created ${note.path}`));
    } catch (err) {
      fail(err);
    }
  });

program
  .command("capture <text...>")
  .description("quick-capture into the inbox")
  .action((words: string[]) => {
    try {
      const vault = openVault();
      const body = words.join(" ");
      const note = vault.createNote({
        title: `${todayISO()} ${body.slice(0, 60)}`,
        type: "inbox",
        folder: vault.config.folders.inbox,
        body,
        unique: true,
      });
      console.log(pc.green(`Captured to ${note.path}`));
    } catch (err) {
      fail(err);
    }
  });

program
  .command("append <ref> <text...>")
  .description(
    'append markdown to a note (quote a multi-word note name; put -- before text that starts with "-")',
  )
  .option("-H, --heading <heading>", "section to append under, e.g. Log (created if missing)")
  .action((ref: string, words: string[], opts: { heading?: string }) => {
    try {
      const vault = openVault();
      const note = vault.appendToNote(ref, words.join(" "), opts.heading);
      console.log(
        pc.green(`Appended to ${note.path}${opts.heading ? ` under '${opts.heading}'` : ""}`),
      );
    } catch (err) {
      fail(err);
    }
  });

program
  .command("frontmatter <ref> <assignments...>")
  .description("set frontmatter keys: key=value (read as YAML); key=null removes the key")
  .action((ref: string, assignments: string[]) => {
    try {
      const updates = parseFrontmatterAssignments(assignments);
      const vault = openVault();
      const note = vault.updateFrontmatter(ref, updates);
      const set = Object.keys(updates).filter((k) => updates[k] !== null);
      const removed = Object.keys(updates).filter((k) => updates[k] === null);
      const parts = [
        set.length ? `set ${set.join(", ")}` : "",
        removed.length ? `removed ${removed.join(", ")}` : "",
      ].filter(Boolean);
      console.log(pc.green(`Updated frontmatter of ${note.path} (${parts.join("; ")})`));
    } catch (err) {
      fail(err);
    }
  });

program
  .command("archive <ref...>")
  .description("move a note into the archive folder (the non-destructive alternative to deleting)")
  .action((refWords: string[]) => {
    try {
      const vault = openVault();
      const ref = refWords.join(" ");
      const existing = vault.get(ref);
      if (existing?.archived) return console.log(pc.dim(`Already archived: ${existing.path}`));
      const note = vault.archiveNote(ref);
      console.log(pc.green(`Archived to ${note.path}`));
    } catch (err) {
      fail(err);
    }
  });

program
  .command("daily")
  .description("open info for today's daily note (creates it if missing)")
  .option("-d, --date <date>", "YYYY-MM-DD (default today)")
  .option("-l, --log <text>", "append a timestamped Log entry instead")
  .action((opts: { date?: string; log?: string }) => {
    try {
      const vault = openVault();
      if (opts.log) {
        const note = logToDaily(vault, opts.log, opts.date);
        return console.log(pc.green(`Logged to ${note.path}`));
      }
      const note = getDailyNote(vault, opts.date);
      console.log(pc.dim(`# ${note.path}`));
      console.log(note.raw.trimEnd());
    } catch (err) {
      fail(err);
    }
  });

program
  .command("tasks")
  .description("list open tasks (due-date order)")
  .option("-a, --all", "include completed tasks")
  .option("--done", "only completed tasks")
  .option("-p, --project <ref>", "only tasks in this project")
  .option("--due-by <date>", "due on or before YYYY-MM-DD")
  .option("-t, --tag <tag>", "only tasks with this #tag")
  .option("--json", "JSON output")
  .action(
    (opts: {
      all?: boolean;
      done?: boolean;
      project?: string;
      dueBy?: string;
      tag?: string;
      json?: boolean;
    }) => {
      try {
        const vault = openVault();
        const tasks = listTasks(vault, {
          status: opts.done ? "done" : opts.all ? "all" : "open",
          project: opts.project,
          dueBy: opts.dueBy,
          tag: opts.tag,
        });
        if (opts.json) return console.log(JSON.stringify(tasks, null, 2));
        if (tasks.length === 0) return console.log(pc.dim("No tasks."));
        for (const t of tasks) console.log(taskLine(t));
      } catch (err) {
        fail(err);
      }
    },
  );

const task = program.command("task").description("add, update, or complete tasks");

task
  .command("add <text...>")
  .description("add a task (to a project with -n, else today's daily note)")
  .option("-n, --note <ref>", "project/note to attach to")
  .option("-d, --due <date>", "YYYY-MM-DD")
  .option("-p, --priority <p>", "high|low")
  .action((words: string[], opts: { note?: string; due?: string; priority?: string }) => {
    try {
      if (opts.priority !== undefined && opts.priority !== "high" && opts.priority !== "low") {
        throw new Error(`Invalid task priority: ${opts.priority} (want high or low)`);
      }
      const vault = openVault();
      const t = addTask(vault, {
        text: words.join(" "),
        note: opts.note,
        due: opts.due,
        priority: opts.priority === "high" || opts.priority === "low" ? opts.priority : undefined,
      });
      console.log(pc.green(`Added ${t.id} to ${t.file}`));
    } catch (err) {
      fail(err);
    }
  });

task
  .command("done <task...>")
  .description("complete a task by id or unique text fragment")
  .action((words: string[]) => {
    try {
      const vault = openVault();
      const result = completeTask(vault, words.join(" "));
      console.log(pc.green(`Done: ${result.task.text} (${result.file})`));
    } catch (err) {
      fail(err);
    }
  });

task
  .command("update <task...>")
  .description("update a task by id or unique text fragment")
  .option("--text <text>", "replace the task description")
  .option("--due <date|none>", "YYYY-MM-DD, or 'none' to clear")
  .option("--priority <priority>", "high|low|normal")
  .option("--status <status>", "open|done|cancelled")
  .action(
    (
      words: string[],
      opts: { text?: string; due?: string; priority?: string; status?: string },
    ) => {
      try {
        if (opts.priority !== undefined && !["high", "low", "normal"].includes(opts.priority)) {
          throw new Error(`Invalid task priority: ${opts.priority} (want high, low, or normal)`);
        }
        if (opts.status !== undefined && !["open", "done", "cancelled"].includes(opts.status)) {
          throw new Error(`Invalid task status: ${opts.status} (want open, done, or cancelled)`);
        }
        const vault = openVault();
        const priority =
          opts.priority === "high" || opts.priority === "low"
            ? opts.priority
            : opts.priority === "normal"
              ? null
              : undefined;
        const result = updateTask(vault, words.join(" "), {
          text: opts.text,
          due:
            opts.due === undefined
              ? undefined
              : opts.due.toLowerCase() === "none"
                ? null
                : opts.due,
          priority,
          status: opts.status as TaskStatus | undefined,
        });
        const renamed = result.task.id === result.previousId ? "" : ` (new id ${result.task.id})`;
        console.log(
          pc.green(`Updated task${renamed} in ${result.file}: ${result.task.raw.trim()}`),
        );
      } catch (err) {
        fail(err);
      }
    },
  );

program
  .command("projects")
  .description("list projects")
  .option("-s, --status <status>", "idea|active|paused|done|dropped")
  .option("--json", "JSON output")
  .action((opts: { status?: string; json?: boolean }) => {
    try {
      const vault = openVault();
      const projects = listProjects(vault, { status: opts.status });
      if (opts.json) return console.log(JSON.stringify(projects, null, 2));
      if (projects.length === 0) return console.log(pc.dim("No projects."));
      for (const p of projects) {
        const badge =
          p.status === "active"
            ? pc.green(p.status)
            : p.status === "done"
              ? pc.dim(p.status)
              : pc.yellow(p.status);
        console.log(
          `${pc.bold(p.title)} [${badge}] ${pc.dim(`${p.openTasks} open`)} ${pc.dim(p.path)}`,
        );
        if (p.nextTasks[0]) console.log(`  next: ${p.nextTasks[0].text}`);
      }
    } catch (err) {
      fail(err);
    }
  });

const project = program.command("project").description("create projects, change status");

project
  .command("new <title...>")
  .description("create a project")
  .option("-g, --goal <goal>", "definition of done")
  .option("-a, --area <area>", "life/work area")
  .option("-d, --due <date>", "YYYY-MM-DD")
  .action((words: string[], opts: { goal?: string; area?: string; due?: string }) => {
    try {
      const vault = openVault();
      const note = createProject(vault, { title: words.join(" "), ...opts });
      console.log(pc.green(`Created project ${note.path}`));
    } catch (err) {
      fail(err);
    }
  });

project
  .command("status <ref> <status>")
  .description("set project status (idea|active|paused|done|dropped)")
  .action((ref: string, status: string) => {
    try {
      const vault = openVault();
      const note = setProjectStatus(vault, ref, status);
      console.log(pc.green(`${note.title} → ${status}`));
    } catch (err) {
      fail(err);
    }
  });

program
  .command("links <ref...>")
  .description("show a note's outgoing links and backlinks")
  .action((refWords: string[]) => {
    try {
      const vault = openVault();
      const ref = refWords.join(" ");
      const note = vault.get(ref);
      if (!note) fail(new Error(`Note not found: ${ref}`));
      console.log(pc.bold(`→ outgoing from ${note.path}`));
      if (note.links.length === 0) console.log(pc.dim("  (none)"));
      for (const l of note.links) {
        const resolved = vault.resolveLink(l);
        console.log(`  [[${l.target}]] ${resolved ? pc.dim(resolved.path) : pc.red("(broken)")}`);
      }
      const backlinks = vault.backlinks(note.path);
      console.log(pc.bold("← backlinks"));
      if (backlinks.length === 0) console.log(pc.dim("  (none)"));
      for (const b of backlinks) console.log(`  ${b.title} ${pc.dim(b.path)}`);
    } catch (err) {
      fail(err);
    }
  });

program
  .command("tags")
  .description("list tags with usage counts")
  .action(() => {
    try {
      for (const { tag, count } of openVault().tags()) {
        console.log(`${pc.bold(`#${tag}`)} ${pc.dim(String(count))}`);
      }
    } catch (err) {
      fail(err);
    }
  });

program
  .command("doctor")
  .description("lint the vault (broken links, stale projects, overdue tasks…)")
  .option("--json", "JSON output")
  .action((opts: { json?: boolean }) => {
    try {
      const findings = runDoctor(openVault());
      if (opts.json) return console.log(JSON.stringify(findings, null, 2));
      if (findings.length === 0) return console.log(pc.green("Vault is healthy — no findings."));
      for (const f of findings) {
        const sev =
          f.severity === "error"
            ? pc.red(f.severity)
            : f.severity === "warning"
              ? pc.yellow(f.severity)
              : pc.dim(f.severity);
        console.log(
          `${sev} ${pc.bold(f.rule)}${f.path ? pc.dim(` ${f.path}`) : ""}\n  ${f.message}`,
        );
      }
      const errors = findings.filter((f) => f.severity === "error").length;
      process.exitCode = errors > 0 ? 1 : 0;
    } catch (err) {
      fail(err);
    }
  });

program
  .command("install-skills")
  .description("install the brain/capture/weekly skills into Claude Code (~/.claude/skills)")
  .option("--dir <dir>", "target skills directory", defaultClaudeSkillsDir())
  .option("--force", "overwrite skills that already exist")
  .action((opts: { dir: string; force?: boolean }) => {
    try {
      const result = installSkills(opts.dir, { force: opts.force });
      console.log(pc.green(`Skills → ${result.targetDir}`));
      for (const s of result.installed) console.log(`  ${pc.green("+")} /${s}`);
      for (const s of result.skipped)
        console.log(pc.dim(`  = /${s} (kept existing; --force to replace)`));
      console.log(pc.dim("\nRestart Claude Code (or start a new session) to pick them up."));
    } catch (err) {
      fail(err);
    }
  });

// --- agents: each coding agent's setup, kept in the vault -------------------

const LINK_MARKS: Record<string, string> = {
  none: pc.green("✓"),
  keep: pc.dim("="),
  link: pc.green("+"),
  copy: pc.green("+"),
  replace: pc.yellow("~"),
  conflict: pc.red("!"),
};

const SETTING_MARKS: Record<string, string> = {
  ok: pc.green("✓"),
  add: pc.green("+"),
  update: pc.yellow("↻"),
  remove: pc.yellow("−"),
  conflict: pc.red("!"),
  "edited-kept": pc.dim("="),
  forget: pc.dim("·"),
};

function agentsFor(names: string[], vaultDir: string, agentsFolder: string): AgentDef[] {
  if (names.length > 0) return names.map(getAgent);
  return AGENTS.filter((a) => fs.existsSync(path.join(vaultDir, agentsFolder, a.name)));
}

function tilde(p: string): string {
  const home = os.homedir();
  return p === home || p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

function printAgentReport(report: InstallReport, verbose: boolean): number {
  const p = report.paths;
  let problems = 0;
  let shown = 0;
  console.log(pc.bold(`${p.agent.label} ${pc.dim(`(${tilde(p.home)})`)}`));
  for (const l of report.links) {
    if (l.action === "conflict") problems++;
    if (!verbose && (l.action === "none" || l.action === "keep") && l.state !== "copy-differs")
      continue;
    shown++;
    const what =
      l.action === "conflict" && l.reason
        ? `${l.entry.rel}: ${l.reason}; fix that by hand (--replace never changes parent folders)`
        : l.action === "conflict"
          ? `${l.entry.rel}: ${l.state === "other-link" ? "a link to somewhere else" : "an unmanaged file"} is in the way (--replace backs it up and links the vault's)`
          : l.action === "replace"
            ? `${l.entry.rel}: back up what's there, then link`
            : l.entry.kind === "bundled-skill" && l.state === "copy-differs"
              ? `${l.entry.rel}: kept (differs from big-brain's bundled copy)`
              : `${l.entry.rel}${l.entry.kind === "bundled-skill" ? pc.dim(" (bundled)") : ""}`;
    console.log(`  ${LINK_MARKS[l.action] ?? " "} ${what}`);
  }
  for (const s of report.settings) {
    if (s.action === "conflict") problems++;
    if (!verbose && (s.action === "ok" || s.action === "forget")) continue;
    shown++;
    const note =
      s.action === "conflict" && s.deletedHere
        ? " — removed here after big-brain set it (--replace adds it back)"
        : s.action === "conflict"
          ? " — set differently here (--replace takes the vault's value)"
          : s.action === "edited-kept"
            ? " — no longer in the vault, but edited here, so left as is"
            : s.action === "forget"
              ? " — no longer managed"
              : "";
    console.log(
      `  ${SETTING_MARKS[s.action] ?? " "} ${tilde(report.settingsFile)}: ${leafLabel(s.leaf)}${note}`,
    );
  }
  for (const rel of report.stale) {
    shown++;
    const done = report.pruned.includes(rel);
    console.log(
      `  ${pc.yellow(done ? "−" : "?")} ${rel}: ${done ? "removed (vault copy is gone)" : "links to a vault file that is gone (--prune removes it)"}`,
    );
  }
  if (report.hookChanges && p.agent.name === "claude") {
    console.log(
      pc.dim("  Hooks changed: review them with /hooks in Claude Code or start a new session."),
    );
  }
  if (shown === 0) console.log(pc.dim("  ✓ everything in place"));
  if (report.backupDir)
    console.log(pc.dim(`  Previous versions of changed files saved to ${tilde(report.backupDir)}`));
  return problems;
}

const agents = program
  .command("agents")
  .description(
    "install or save each coding agent's setup (skills, instructions, hooks, status line)",
  );

agents
  .command("status [agents...]")
  .description("show what is linked, missing, edited here, or not saved yet")
  .option("-v, --verbose", "also list everything that is already in place")
  .action((names: string[], opts: { verbose?: boolean }) => {
    try {
      const vault = openVault();
      const folder = vault.config.folders.agents;
      const list = names.length > 0 ? names.map(getAgent) : AGENTS;
      for (const agent of list) {
        const p = agentPaths(vault.dir, folder, agent);
        if (!fs.existsSync(p.profile) && !fs.existsSync(p.home)) continue;
        const report = agentStatus(p);
        printAgentReport(report, Boolean(opts.verbose));
        if (!fs.existsSync(p.profile))
          console.log(pc.dim(`  No profile in the vault (${folder}/${agent.name}).`));
        if (report.overrideActive) {
          console.log(
            pc.yellow(
              `  ! ${tilde(report.overrideActive)} exists and overrides ${agent.instructionsFile}`,
            ),
          );
        }
        for (const skill of report.localSkills) {
          console.log(
            `  ${pc.cyan("·")} ${agent.skillsDir}/${skill}: only on this machine (big-brain agents save ${agent.name} ${agent.skillsDir}/${skill})`,
          );
        }
      }
    } catch (err) {
      fail(err);
    }
  });

agents
  .command("install [agents...]")
  .description("link each agent's setup from the vault (default: agents with a profile)")
  .option("-n, --dry-run", "show the plan, change nothing")
  .option("--replace", "back up and replace unmanaged files and locally edited settings")
  .option("--prune", "remove links whose vault file was deleted")
  .option("-v, --verbose", "also list everything that is already in place")
  .action(
    (
      names: string[],
      opts: { dryRun?: boolean; replace?: boolean; prune?: boolean; verbose?: boolean },
    ) => {
      try {
        const vault = openVault();
        const folder = vault.config.folders.agents;
        const list = agentsFor(names, vault.dir, folder);
        if (list.length === 0) {
          return console.log(
            pc.dim(
              `No agent profiles in ${folder}/ yet. Name an agent to install big-brain's own skills.`,
            ),
          );
        }
        if (opts.dryRun) console.log(pc.dim("Dry run: nothing will change.\n"));
        let problems = 0;
        for (const agent of list) {
          problems += printAgentReport(
            installAgent(agentPaths(vault.dir, folder, agent), opts),
            Boolean(opts.verbose),
          );
        }
        if (problems > 0) {
          console.log(pc.yellow(`\n${problems} item(s) left as is; see the ! lines above.`));
          process.exitCode = 1;
        } else if (!opts.dryRun) {
          console.log(pc.dim("\nStart a new agent session to pick up the changes."));
        }
      } catch (err) {
        fail(err);
      }
    },
  );

agents
  .command("save <agent> [paths...]")
  .description("copy files or skills set up on this machine into the vault, then link them")
  .option(
    "-s, --setting <key>",
    "also save a settings key, e.g. statusLine or tui.status_line (repeatable)",
    (value: string, prev: string[]) => [...prev, value],
    [] as string[],
  )
  .option("--force", "overwrite what the vault already has at that path")
  .action((name: string, rels: string[], opts: { setting: string[]; force?: boolean }) => {
    try {
      if (rels.length === 0 && opts.setting.length === 0) {
        throw new Error("Name at least one path (e.g. statusline.sh, skills/foo) or --setting key");
      }
      const vault = openVault();
      const agent = getAgent(name);
      const p = agentPaths(vault.dir, vault.config.folders.agents, agent);
      const result = saveToProfile(p, vault.dir, rels, opts.setting, { force: opts.force });
      vault.commit(`big-brain: save ${agent.name} agent setup`, result.touched);
      for (const s of result.saved) console.log(pc.green(`Saved ${s.rel} → ${tilde(s.vaultPath)}`));
      for (const s of result.settings) {
        console.log(
          pc.green(
            `Saved setting ${s.key} → ${vault.config.folders.agents}/${agent.name}/${agent.settingsFile}`,
          ),
        );
      }
      if (result.saved.length === 0 && result.settings.length === 0) {
        console.log(pc.dim("Nothing to save: already linked from the vault."));
      }
      if (result.backupDir)
        console.log(pc.dim(`Originals backed up to ${tilde(result.backupDir)}`));
    } catch (err) {
      fail(err);
    }
  });

program
  .command("mcp")
  .description("run the MCP server over stdio (same as big-brain-mcp)")
  .action(() => {
    const opts = program.opts<{ vault?: string }>();
    const serverPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "mcp",
      "index.js",
    );
    const args = opts.vault ? ["--vault", opts.vault] : [];
    const child = spawn(process.execPath, [serverPath, ...args], { stdio: "inherit" });
    child.on("exit", (code, signal) =>
      process.exit(code ?? (signal ? 128 + os.constants.signals[signal] : 1)),
    );
  });

program
  .command("mcp-http")
  .description("run the authenticated Streamable HTTP MCP server")
  .option("--host <host>", "listen address", process.env.BIG_BRAIN_MCP_HOST ?? "127.0.0.1")
  .option("--port <port>", "listen port", process.env.BIG_BRAIN_MCP_PORT ?? "3333")
  .option(
    "--allowed-hosts <hosts>",
    "comma-separated Host header allowlist",
    process.env.BIG_BRAIN_MCP_ALLOWED_HOSTS,
  )
  .option(
    "--allowed-origins <origins>",
    "comma-separated browser Origin allowlist (requests without Origin are always allowed)",
    process.env.BIG_BRAIN_MCP_ALLOWED_ORIGINS,
  )
  .action(
    (opts: { host: string; port: string; allowedHosts?: string; allowedOrigins?: string }) => {
      const globalOpts = program.opts<{ vault?: string }>();
      const serverPath = path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "mcp",
        "http.js",
      );
      const args = ["--host", opts.host, "--port", opts.port];
      if (globalOpts.vault) args.push("--vault", globalOpts.vault);
      if (opts.allowedHosts) args.push("--allowed-hosts", opts.allowedHosts);
      if (opts.allowedOrigins) args.push("--allowed-origins", opts.allowedOrigins);
      const child = spawn(process.execPath, [serverPath, ...args], { stdio: "inherit" });
      child.on("exit", (code, signal) =>
        process.exit(code ?? (signal ? 128 + os.constants.signals[signal] : 1)),
      );
    },
  );

program.parseAsync().catch(fail);
