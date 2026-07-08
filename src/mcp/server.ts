import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDailyNote, logToDaily } from "../core/daily.js";
import { runDoctor } from "../core/doctor.js";
import { hybridSearch } from "../core/embeddings.js";
import { renderOverview, vaultOverview } from "../core/overview.js";
import { createProject, listProjects, setProjectStatus } from "../core/projects.js";
import { relatedNotes } from "../core/related.js";
import { addTask, completeTask, listTasks } from "../core/tasks.js";
import type { Note } from "../core/types.js";
import { nowStamp, todayISO } from "../core/util.js";
import type { Vault } from "../core/vault.js";

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function json(v: unknown) {
  return text(JSON.stringify(v, null, 2));
}

function renderNote(note: Note): string {
  const fm = Object.entries(note.frontmatter)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join(", ");
  const head = [
    `path: ${note.path}`,
    `title: ${note.title}`,
    `type: ${note.type}`,
    fm ? `frontmatter: { ${fm} }` : undefined,
    note.tags.length > 0 ? `tags: ${note.tags.join(", ")}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
  return `${head}\n---\n${note.body.trim()}\n`;
}

function taskRow(t: {
  id: string;
  text: string;
  done: boolean;
  due?: string;
  priority?: string;
  noteTitle: string;
  file: string;
}) {
  return {
    id: t.id,
    text: t.text,
    done: t.done,
    due: t.due,
    priority: t.priority,
    note: t.noteTitle,
    file: t.file,
  };
}

/**
 * Build the big-brain MCP server over a vault. Every handler calls
 * vault.refresh() first so edits made outside this process (editor, git pull,
 * another agent) are always visible.
 */
export function buildServer(vault: Vault): McpServer {
  const server = new McpServer({ name: "big-brain", version: "0.2.0" });
  const fresh = <T>(fn: () => T): T => {
    vault.refresh();
    return fn();
  };

  server.registerTool(
    "brain_overview",
    {
      title: "Vault overview",
      description:
        "Orient yourself in the user's second brain: active projects with next tasks, overdue and upcoming tasks, unprocessed inbox items, and recently touched notes. Call this at the start of a session or when asked 'what am I working on?'.",
      inputSchema: {},
    },
    async () => fresh(() => text(renderOverview(vaultOverview(vault)))),
  );

  server.registerTool(
    "search_notes",
    {
      title: "Search notes",
      description:
        "Search the vault: full-text (titles boosted, fuzzy + prefix matching), fused with local semantic search when the vault has embeddings enabled. Filter by type (note/project/daily/person/reference/area), tag, folder prefix, or frontmatter status.",
      inputSchema: {
        query: z.string().describe("Search terms"),
        type: z.string().optional().describe("Restrict to a note type, e.g. 'project'"),
        tag: z.string().optional().describe("Restrict to notes with this tag (no #)"),
        folder: z.string().optional().describe("Restrict to a folder prefix, e.g. 'reference'"),
        status: z.string().optional().describe("Restrict by frontmatter status, e.g. 'active'"),
        limit: z.number().int().min(1).max(50).optional().describe("Max results (default 20)"),
      },
    },
    async (args) => {
      vault.refresh();
      const results = await hybridSearch(vault, args.query, args);
      return json(
        results.map((r) => ({ path: r.path, title: r.title, type: r.type, excerpt: r.excerpt })),
      );
    },
  );

  server.registerTool(
    "related_notes",
    {
      title: "Related notes",
      description:
        "Find notes related to a given note, with reasons: direct links, shared link-neighbors, shared (rarity-weighted) tags, unlinked title mentions, and semantic similarity when embeddings are enabled. Use to pull surrounding context before working on a topic, or to find where a new note should link.",
      inputSchema: {
        ref: z.string().describe("Note path, title, or alias"),
        limit: z.number().int().min(1).max(25).optional().describe("Max results (default 8)"),
      },
    },
    async ({ ref, limit }) => {
      vault.refresh();
      return json(await relatedNotes(vault, ref, { limit }));
    },
  );

  server.registerTool(
    "read_note",
    {
      title: "Read a note",
      description:
        "Read a note by path, title, alias, or filename (case-insensitive). Returns frontmatter and full body.",
      inputSchema: { ref: z.string().describe("Path like 'projects/Foo.md', or a title/alias") },
    },
    async ({ ref }) =>
      fresh(() => {
        const note = vault.get(ref);
        if (!note) return text(`Note not found: ${ref}. Try search_notes first.`);
        return text(renderNote(note));
      }),
  );

  server.registerTool(
    "create_note",
    {
      title: "Create a note",
      description:
        "Create a markdown note. type decides the folder (note→notes/, project→projects/, person→people/, reference→reference/, area→areas/). Use [[wikilinks]] in the body to connect it to related notes — always link generously.",
      inputSchema: {
        title: z.string().describe("Note title (becomes the filename)"),
        body: z.string().optional().describe("Markdown body; use [[wikilinks]] to related notes"),
        type: z
          .enum(["note", "project", "person", "reference", "area", "inbox"])
          .optional()
          .describe("Note type (default 'note')"),
        tags: z.array(z.string()).optional().describe("Tags without #"),
        frontmatter: z
          .record(z.unknown())
          .optional()
          .describe("Extra frontmatter keys, e.g. {status:'active'} "),
        overwrite: z.boolean().optional().describe("Replace an existing note at the same path"),
      },
    },
    async (args) =>
      fresh(() => {
        const note = vault.createNote(args);
        return text(`Created ${note.path}`);
      }),
  );

  server.registerTool(
    "append_note",
    {
      title: "Append to a note",
      description:
        "Append markdown to a note, optionally under a specific heading (created at the end if missing). The safe default way to add content without overwriting anything.",
      inputSchema: {
        ref: z.string().describe("Note path, title, or alias"),
        text: z.string().describe("Markdown to append"),
        heading: z.string().optional().describe("Section heading to append under, e.g. 'Log'"),
      },
    },
    async ({ ref, text: body, heading }) =>
      fresh(() => {
        const note = vault.appendToNote(ref, body, heading);
        return text(`Appended to ${note.path}${heading ? ` under '${heading}'` : ""}`);
      }),
  );

  server.registerTool(
    "update_frontmatter",
    {
      title: "Update note frontmatter",
      description:
        "Merge keys into a note's YAML frontmatter (set a key to null to remove it). Use for status, priority, due, area, tags, aliases.",
      inputSchema: {
        ref: z.string().describe("Note path, title, or alias"),
        updates: z.record(z.unknown()).describe("Keys to set; null deletes a key"),
      },
    },
    async ({ ref, updates }) =>
      fresh(() => {
        const note = vault.updateFrontmatter(ref, updates);
        return text(`Updated frontmatter of ${note.path}`);
      }),
  );

  server.registerTool(
    "replace_note_body",
    {
      title: "Replace a note's body",
      description:
        "Rewrite a note's entire body (frontmatter preserved). Prefer append_note for additions; use this only for deliberate rewrites/reorganizations.",
      inputSchema: {
        ref: z.string().describe("Note path, title, or alias"),
        body: z.string().describe("New markdown body"),
      },
    },
    async ({ ref, body }) =>
      fresh(() => {
        const note = vault.replaceBody(ref, body);
        return text(`Rewrote ${note.path}`);
      }),
  );

  server.registerTool(
    "archive_note",
    {
      title: "Archive a note",
      description:
        "Move a note into the archive folder (the non-destructive alternative to deletion). Archived notes are excluded from search and listings by default.",
      inputSchema: { ref: z.string().describe("Note path, title, or alias") },
    },
    async ({ ref }) =>
      fresh(() => {
        const note = vault.archiveNote(ref);
        return text(`Archived to ${note.path}`);
      }),
  );

  server.registerTool(
    "capture",
    {
      title: "Capture to inbox",
      description:
        "Quick-capture a thought, link, or piece of information into the inbox for later processing. Use when something is worth keeping but you don't yet know where it belongs.",
      inputSchema: {
        text: z.string().describe("The content to capture (markdown ok)"),
        title: z.string().optional().describe("Optional title; derived from the text if omitted"),
      },
    },
    async ({ text: body, title }) =>
      fresh(() => {
        const t = title ?? body.replace(/\s+/g, " ").trim().slice(0, 60);
        const note = vault.createNote({
          title: `${todayISO()} ${t}`,
          type: "inbox",
          folder: vault.config.folders.inbox,
          body,
        });
        return text(`Captured to ${note.path}`);
      }),
  );

  server.registerTool(
    "daily_note",
    {
      title: "Get or create the daily note",
      description:
        "Return today's daily note (or a specific date's), creating it from the daily template if needed.",
      inputSchema: {
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("YYYY-MM-DD (default today)"),
      },
    },
    async ({ date }) => fresh(() => text(renderNote(getDailyNote(vault, date)))),
  );

  server.registerTool(
    "daily_log",
    {
      title: "Log to the daily note",
      description:
        "Append a timestamped entry to today's daily note Log section. Use to record decisions, progress, and events as they happen — this builds the user's work journal.",
      inputSchema: { text: z.string().describe("What happened / what was decided") },
    },
    async ({ text: entry }) =>
      fresh(() => {
        const note = logToDaily(vault, entry);
        return text(`Logged to ${note.path} at ${nowStamp()}`);
      }),
  );

  server.registerTool(
    "list_notes",
    {
      title: "List notes",
      description:
        "List notes by folder, type, or tag, most recently modified first. Use for browsing; use search_notes for content queries.",
      inputSchema: {
        folder: z.string().optional().describe("Folder prefix, e.g. 'people'"),
        type: z.string().optional().describe("Note type filter"),
        tag: z.string().optional().describe("Tag filter (no #)"),
        limit: z.number().int().min(1).max(100).optional().describe("Max results (default 30)"),
      },
    },
    async ({ folder, type, tag, limit }) =>
      fresh(() => {
        const t = tag?.replace(/^#/, "").toLowerCase();
        const f = folder?.replace(/\/+$/, "");
        const rows = vault
          .notes()
          .filter((n) => !type || n.type === type)
          .filter((n) => !f || n.path.startsWith(`${f}/`))
          .filter((n) => !t || n.tags.includes(t))
          .sort((a, b) => b.mtimeMs - a.mtimeMs)
          .slice(0, limit ?? 30)
          .map((n) => ({ path: n.path, title: n.title, type: n.type, excerpt: n.excerpt }));
        return json(rows);
      }),
  );

  server.registerTool(
    "note_links",
    {
      title: "Note connections",
      description:
        "Show a note's graph neighborhood: outgoing wikilinks (resolved and broken) and backlinks from other notes. Use to explore context around a topic.",
      inputSchema: { ref: z.string().describe("Note path, title, or alias") },
    },
    async ({ ref }) =>
      fresh(() => {
        const note = vault.get(ref);
        if (!note) return text(`Note not found: ${ref}`);
        const outgoing = note.links.map((l) => {
          const target = vault.resolveLink(l);
          return { target: l.target, resolved: target?.path ?? null };
        });
        const backlinks = vault.backlinks(note.path).map((n) => ({ path: n.path, title: n.title }));
        return json({ note: note.path, outgoing, backlinks });
      }),
  );

  server.registerTool(
    "list_tags",
    {
      title: "List tags",
      description: "All tags in the vault with usage counts, most used first.",
      inputSchema: {},
    },
    async () => fresh(() => json(vault.tags())),
  );

  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description:
        "List projects with status, open/done task counts, and next tasks. Statuses: idea, active, paused, done, dropped.",
      inputSchema: {
        status: z.string().optional().describe("Filter by status, e.g. 'active'"),
      },
    },
    async ({ status }) =>
      fresh(() =>
        json(
          listProjects(vault, { status }).map((p) => ({
            path: p.path,
            title: p.title,
            status: p.status,
            area: p.area,
            due: p.due,
            openTasks: p.openTasks,
            nextTasks: p.nextTasks.map((t) => ({ id: t.id, text: t.text, due: t.due })),
          })),
        ),
      ),
  );

  server.registerTool(
    "create_project",
    {
      title: "Create a project",
      description:
        "Create a project note (Goal/Tasks/Notes/Log sections) with status frontmatter. Projects are the unit of ongoing work; link related notes to them with [[wikilinks]].",
      inputSchema: {
        title: z.string().describe("Project name"),
        goal: z.string().optional().describe("One-paragraph definition of done"),
        status: z
          .enum(["idea", "active", "paused"])
          .optional()
          .describe("Initial status (default active)"),
        area: z.string().optional().describe("Life/work area this belongs to"),
        due: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Target date YYYY-MM-DD"),
        tags: z.array(z.string()).optional(),
      },
    },
    async (args) =>
      fresh(() => {
        const note = createProject(vault, args);
        return text(`Created project ${note.path}`);
      }),
  );

  server.registerTool(
    "set_project_status",
    {
      title: "Set project status",
      description:
        "Change a project's status (idea/active/paused/done/dropped). 'done' stamps a completion date.",
      inputSchema: {
        ref: z.string().describe("Project path or title"),
        status: z.enum(["idea", "active", "paused", "done", "dropped"]),
      },
    },
    async ({ ref, status }) =>
      fresh(() => {
        const note = setProjectStatus(vault, ref, status);
        return text(`${note.title} → ${status}`);
      }),
  );

  server.registerTool(
    "list_tasks",
    {
      title: "List tasks",
      description:
        "List checkbox tasks across the vault, sorted by due date then priority. Filter by status (open/done/all), project, tag, or dueBy date.",
      inputSchema: {
        status: z.enum(["open", "done", "all"]).optional().describe("Default 'open'"),
        project: z.string().optional().describe("Only tasks in this project (title or path)"),
        tag: z.string().optional(),
        dueBy: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Due on or before this date"),
      },
    },
    async (args) => fresh(() => json(listTasks(vault, args).map(taskRow))),
  );

  server.registerTool(
    "add_task",
    {
      title: "Add a task",
      description:
        "Add a checkbox task to a project's Tasks section (or today's daily note if no note given). Supports due date and priority.",
      inputSchema: {
        text: z.string().describe("Task description"),
        note: z
          .string()
          .optional()
          .describe("Project/note to attach to (title or path); default today's daily note"),
        due: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("YYYY-MM-DD"),
        priority: z.enum(["high", "low"]).optional(),
        heading: z.string().optional().describe("Section to file under (default 'Tasks')"),
      },
    },
    async (args) =>
      fresh(() => {
        const task = addTask(vault, args);
        return text(`Added task ${task.id} to ${task.file}: ${task.text}`);
      }),
  );

  server.registerTool(
    "complete_task",
    {
      title: "Complete a task",
      description:
        "Mark a task done by id (from list_tasks) or by a unique text fragment. Stamps today's date.",
      inputSchema: { task: z.string().describe("Task id or unique text fragment") },
    },
    async ({ task }) =>
      fresh(() => {
        const result = completeTask(vault, task);
        return text(`Done: ${result.task.text} (${result.file})`);
      }),
  );

  server.registerTool(
    "vault_health",
    {
      title: "Vault health check",
      description:
        "Lint the vault: broken wikilinks, duplicate titles, stale active projects, overdue tasks, orphan notes, inbox pileup. Use during reviews.",
      inputSchema: {},
    },
    async () =>
      fresh(() => {
        const findings = runDoctor(vault);
        if (findings.length === 0) return text("Vault is healthy — no findings.");
        return json(findings);
      }),
  );

  server.registerPrompt(
    "orient",
    {
      title: "Orient in the brain",
      description: "Load the vault overview and act as a second-brain-aware assistant",
    },
    () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: "Call brain_overview to load my second brain, then briefly tell me: what I'm actively working on, anything overdue or due soon, and what's piled up in the inbox. Keep it to one screen. As we work, capture new information into the vault (capture/daily_log/append_note) and keep project statuses and tasks up to date.",
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "weekly-review",
    {
      title: "Weekly review",
      description: "Run a guided weekly review of projects, tasks, and inbox",
    },
    () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: "Run my weekly review: 1) brain_overview and vault_health; 2) walk through each active project — recent progress (read its Log), open tasks, and ask me whether it stays active; 3) triage every inbox note into a project/note/reference or archive it; 4) list overdue tasks and help me reschedule or drop them; 5) finish by writing a short review summary to today's daily note under 'Log'. Work through it step by step with me.",
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "process-inbox",
    {
      title: "Process inbox",
      description: "Triage unprocessed inbox captures into the right place",
    },
    () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: "List my inbox notes (list_notes folder=inbox). For each one, propose where it belongs: merge into an existing note/project (append_note), become a new note with [[links]], turn into tasks, or archive. Confirm with me per item, then do it and archive the processed capture.",
          },
        },
      ],
    }),
  );

  return server;
}
