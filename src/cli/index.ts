#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import pc from "picocolors";
import { resolveVault } from "../core/config.js";
import { getDailyNote, logToDaily } from "../core/daily.js";
import { runDoctor } from "../core/doctor.js";
import { SemanticIndex, createEmbeddingProvider, hybridSearch } from "../core/embeddings.js";
import { renderOverview, vaultOverview } from "../core/overview.js";
import { createProject, listProjects, setProjectStatus } from "../core/projects.js";
import { relatedNotes } from "../core/related.js";
import { initVault } from "../core/scaffold.js";
import { defaultClaudeSkillsDir, installSkills } from "../core/skills.js";
import { addTask, completeTask, listTasks } from "../core/tasks.js";
import type { TaskItem } from "../core/types.js";
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
  const box = t.done ? pc.green("[x]") : "[ ]";
  const due = t.due ? pc.yellow(` 📅 ${t.due}`) : "";
  const prio = t.priority === "high" ? pc.red(" ⏫") : t.priority === "low" ? " 🔽" : "";
  return `${pc.dim(t.id)} ${box} ${t.text}${prio}${due} ${pc.dim(`(${t.noteTitle})`)}`;
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
        limit: Number(opts.limit),
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
        limit: Number(opts.limit),
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
      const vault = openVault();
      if (!vault.config.embeddings.enabled) {
        return console.log(
          pc.yellow(
            'Embeddings are off. Enable with "embeddings": { "enabled": true } in brain.config.json.',
          ),
        );
      }
      const provider = await createEmbeddingProvider(vault.config.embeddings);
      if (opts.rebuild) {
        const { INDEX_DIR, INDEX_FILE } = await import("../core/embeddings.js");
        const { rmSync } = await import("node:fs");
        rmSync(path.join(vault.dir, INDEX_DIR, INDEX_FILE), { force: true });
      }
      const index = new SemanticIndex(vault.dir, provider.id);
      if (opts.status) {
        const s = index.status();
        const stale = index.stale(vault.notes(true)).length;
        return console.log(
          `model ${s.model} · ${s.notes} notes · ${s.chunks} chunks · ${(s.sizeBytes / 1024).toFixed(0)}KB · ${stale} stale`,
        );
      }
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
        title: `${new Date().toISOString().slice(0, 10)} ${body.slice(0, 60)}`,
        type: "inbox",
        folder: vault.config.folders.inbox,
        body,
      });
      console.log(pc.green(`Captured to ${note.path}`));
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
  .option("--json", "JSON output")
  .action(
    (opts: { all?: boolean; done?: boolean; project?: string; dueBy?: string; json?: boolean }) => {
      try {
        const vault = openVault();
        const tasks = listTasks(vault, {
          status: opts.done ? "done" : opts.all ? "all" : "open",
          project: opts.project,
          dueBy: opts.dueBy,
        });
        if (opts.json) return console.log(JSON.stringify(tasks, null, 2));
        if (tasks.length === 0) return console.log(pc.dim("No tasks."));
        for (const t of tasks) console.log(taskLine(t));
      } catch (err) {
        fail(err);
      }
    },
  );

const task = program.command("task").description("add or complete tasks");

task
  .command("add <text...>")
  .description("add a task (to a project with -n, else today's daily note)")
  .option("-n, --note <ref>", "project/note to attach to")
  .option("-d, --due <date>", "YYYY-MM-DD")
  .option("-p, --priority <p>", "high|low")
  .action((words: string[], opts: { note?: string; due?: string; priority?: string }) => {
    try {
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
    child.on("exit", (code) => process.exit(code ?? 0));
  });

program.parseAsync().catch(fail);
