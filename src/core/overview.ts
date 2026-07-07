import { type ProjectSummary, listProjects } from "./projects.js";
import { listTasks } from "./tasks.js";
import type { Note, TaskItem } from "./types.js";
import { todayISO } from "./util.js";
import type { Vault } from "./vault.js";

export interface VaultOverview {
  name: string;
  stats: {
    notes: number;
    projects: number;
    openTasks: number;
    tags: number;
    inboxItems: number;
  };
  activeProjects: ProjectSummary[];
  overdueTasks: TaskItem[];
  dueSoonTasks: TaskItem[];
  recentNotes: Array<{ path: string; title: string; type: string; excerpt: string }>;
  inbox: Array<{ path: string; title: string; excerpt: string }>;
}

/** One structured payload that orients an LLM (or a human) at session start. */
export function vaultOverview(vault: Vault, opts: { recentLimit?: number } = {}): VaultOverview {
  const notes = vault.notes();
  const today = todayISO();
  const soon = addDays(today, 7);
  const open = listTasks(vault, { status: "open" });
  const inboxFolder = vault.config.folders.inbox;
  const inbox = notes.filter((n) => n.path.startsWith(`${inboxFolder}/`));
  const recent = [...notes]
    .filter((n) => n.type !== "daily")
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, opts.recentLimit ?? 8);

  return {
    name: vault.config.name,
    stats: {
      notes: notes.length,
      projects: notes.filter((n) => n.type === "project").length,
      openTasks: open.length,
      tags: vault.tags().length,
      inboxItems: inbox.length,
    },
    activeProjects: listProjects(vault, { status: "active" }),
    overdueTasks: open.filter((t) => t.due !== undefined && t.due < today),
    dueSoonTasks: open.filter((t) => t.due !== undefined && t.due >= today && t.due <= soon),
    recentNotes: recent.map((n) => ({
      path: n.path,
      title: n.title,
      type: n.type,
      excerpt: n.excerpt,
    })),
    inbox: inbox.map((n) => ({ path: n.path, title: n.title, excerpt: n.excerpt })),
  };
}

function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const date = new Date(y!, m! - 1, d! + days);
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${mm}-${dd}`;
}

/** Human-readable one-screen rendering of the overview (used by CLI + MCP). */
export function renderOverview(o: VaultOverview): string {
  const lines: string[] = [];
  lines.push(`# ${o.name} — overview`);
  lines.push(
    `${o.stats.notes} notes · ${o.stats.projects} projects · ${o.stats.openTasks} open tasks · ${o.stats.tags} tags · ${o.stats.inboxItems} inbox items`,
  );
  if (o.activeProjects.length > 0) {
    lines.push("", "## Active projects");
    for (const p of o.activeProjects) {
      const next = p.nextTasks[0] ? ` → next: ${p.nextTasks[0].text}` : "";
      lines.push(`- **${p.title}** (${p.openTasks} open)${next}`);
    }
  }
  if (o.overdueTasks.length > 0) {
    lines.push("", "## Overdue");
    for (const t of o.overdueTasks)
      lines.push(`- [${t.id}] ${t.text} 📅 ${t.due} (${t.noteTitle})`);
  }
  if (o.dueSoonTasks.length > 0) {
    lines.push("", "## Due in the next 7 days");
    for (const t of o.dueSoonTasks)
      lines.push(`- [${t.id}] ${t.text} 📅 ${t.due} (${t.noteTitle})`);
  }
  if (o.inbox.length > 0) {
    lines.push("", `## Inbox (${o.inbox.length} to process)`);
    for (const n of o.inbox.slice(0, 10)) lines.push(`- ${n.title} — ${n.excerpt.slice(0, 80)}`);
  }
  if (o.recentNotes.length > 0) {
    lines.push("", "## Recently touched");
    for (const n of o.recentNotes) lines.push(`- ${n.title} (${n.type}) — ${n.path}`);
  }
  return lines.join("\n");
}
