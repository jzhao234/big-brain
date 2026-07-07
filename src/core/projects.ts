import { compareTasks } from "./tasks.js";
import type { Note, ProjectStatus, TaskItem } from "./types.js";
import { todayISO } from "./util.js";
import type { Vault } from "./vault.js";

export interface ProjectSummary {
  path: string;
  title: string;
  status: ProjectStatus;
  priority?: string;
  area?: string;
  due?: string;
  openTasks: number;
  doneTasks: number;
  /** The next few open tasks, sorted by due date / priority. */
  nextTasks: TaskItem[];
  /** Last time the project file was touched (ms epoch). */
  updatedMs: number;
  excerpt: string;
  tags: string[];
}

const PROJECT_STATUSES: ProjectStatus[] = ["idea", "active", "paused", "done", "dropped"];

export function projectStatus(note: Note): ProjectStatus {
  const s = String(note.frontmatter.status ?? "")
    .trim()
    .toLowerCase();
  return s === "" ? "active" : s;
}

export function summarizeProject(note: Note): ProjectSummary {
  const open = note.tasks.filter((t) => !t.done).sort(compareTasks);
  return {
    path: note.path,
    title: note.title,
    status: projectStatus(note),
    priority: note.frontmatter.priority ? String(note.frontmatter.priority) : undefined,
    area: note.frontmatter.area ? String(note.frontmatter.area) : undefined,
    due: note.frontmatter.due ? String(note.frontmatter.due) : undefined,
    openTasks: open.length,
    doneTasks: note.tasks.length - open.length,
    nextTasks: open.slice(0, 3),
    updatedMs: note.mtimeMs,
    excerpt: note.excerpt,
    tags: note.tags,
  };
}

export function listProjects(
  vault: Vault,
  opts: { status?: string; includeArchived?: boolean } = {},
): ProjectSummary[] {
  const projects = vault
    .notes(opts.includeArchived ?? false)
    .filter((n) => n.type === "project")
    .map(summarizeProject);
  const filtered = opts.status ? projects.filter((p) => p.status === opts.status) : projects;
  const rank = (s: ProjectStatus) => {
    const i = PROJECT_STATUSES.indexOf(s);
    return i === -1 ? PROJECT_STATUSES.length : i;
  };
  return filtered.sort((a, b) => rank(a.status) - rank(b.status) || b.updatedMs - a.updatedMs);
}

export interface CreateProjectInput {
  title: string;
  goal?: string;
  status?: ProjectStatus;
  area?: string;
  due?: string;
  tags?: string[];
}

export function createProject(vault: Vault, input: CreateProjectInput): Note {
  const tpl = vault.template("project");
  const goal = input.goal?.trim() ?? "";
  const body = tpl
    ? tpl.replace(/\{\{\s*goal\s*\}\}/g, goal).replace(/\{\{\s*title\s*\}\}/g, input.title)
    : `## Goal\n\n${goal}\n\n## Tasks\n\n## Notes\n\n## Log\n`;
  return vault.createNote({
    title: input.title,
    type: "project",
    tags: input.tags,
    frontmatter: {
      status: input.status ?? "active",
      started: todayISO(),
      ...(input.area ? { area: input.area } : {}),
      ...(input.due ? { due: input.due } : {}),
    },
    body,
  });
}

export function setProjectStatus(vault: Vault, ref: string, status: ProjectStatus): Note {
  const note = vault.get(ref);
  if (!note) throw new Error(`Project not found: ${ref}`);
  if (note.type !== "project") throw new Error(`Not a project: ${note.path} (type=${note.type})`);
  const updates: Record<string, unknown> = { status };
  if (status === "done") updates.completed = todayISO();
  return vault.updateFrontmatter(note.path, updates);
}
