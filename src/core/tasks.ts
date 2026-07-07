import fs from "node:fs";
import path from "node:path";
import { getDailyNote } from "./daily.js";
import type { TaskItem, TaskPriority } from "./types.js";
import { todayISO } from "./util.js";
import type { Vault } from "./vault.js";

export interface TaskFilter {
  /** "open" (default), "done", or "all". */
  status?: "open" | "done" | "all";
  /** Restrict to tasks inside this project (title/path/alias). */
  project?: string;
  /** Restrict to tasks due on or before this date (YYYY-MM-DD). */
  dueBy?: string;
  tag?: string;
  includeArchived?: boolean;
}

export function listTasks(vault: Vault, filter: TaskFilter = {}): TaskItem[] {
  const status = filter.status ?? "open";
  let projectPath: string | undefined;
  if (filter.project) {
    const note = vault.get(filter.project);
    if (!note) throw new Error(`Project not found: ${filter.project}`);
    projectPath = note.path;
  }
  const tag = filter.tag?.replace(/^#/, "").toLowerCase();
  const tasks: TaskItem[] = [];
  for (const note of vault.notes(filter.includeArchived ?? false)) {
    if (projectPath && note.path !== projectPath) continue;
    for (const t of note.tasks) {
      if (status === "open" && t.done) continue;
      if (status === "done" && !t.done) continue;
      if (tag && !t.tags.includes(tag)) continue;
      if (filter.dueBy && (!t.due || t.due > filter.dueBy)) continue;
      tasks.push(t);
    }
  }
  return tasks.sort(compareTasks);
}

/** Sort: overdue/due first (earliest), then high priority, then file order. */
export function compareTasks(a: TaskItem, b: TaskItem): number {
  const aDue = a.due ?? "9999-99-99";
  const bDue = b.due ?? "9999-99-99";
  if (aDue !== bDue) return aDue < bDue ? -1 : 1;
  const prio = (t: TaskItem) => (t.priority === "high" ? 0 : t.priority === "low" ? 2 : 1);
  if (prio(a) !== prio(b)) return prio(a) - prio(b);
  return a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file);
}

export interface AddTaskInput {
  text: string;
  /** Project (or any note) to attach the task to; defaults to today's daily note. */
  note?: string;
  due?: string;
  priority?: TaskPriority;
  /** Heading to file the task under (default "Tasks" for projects, "Log" skipped for daily). */
  heading?: string;
}

export function formatTaskLine(input: AddTaskInput): string {
  let line = `- [ ] ${input.text.trim()}`;
  if (input.priority === "high") line += " ⏫";
  if (input.priority === "low") line += " 🔽";
  if (input.due) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.due)) {
      throw new Error(`Invalid due date (want YYYY-MM-DD): ${input.due}`);
    }
    line += ` 📅 ${input.due}`;
  }
  return line;
}

export function addTask(vault: Vault, input: AddTaskInput): TaskItem {
  const line = formatTaskLine(input);
  let targetRef: string;
  let heading: string | undefined;
  if (input.note) {
    const note = vault.get(input.note);
    if (!note) throw new Error(`Note not found: ${input.note}`);
    targetRef = note.path;
    heading = input.heading ?? (note.type === "project" ? "Tasks" : undefined);
  } else {
    targetRef = getDailyNote(vault).path;
    heading = input.heading ?? "Tasks";
  }
  const updated = vault.appendToNote(targetRef, line, heading);
  const added = updated.tasks.find((t) => t.raw.trim() === line.trim() && !t.done);
  if (!added) throw new Error("Task was written but could not be read back");
  return added;
}

export interface CompleteResult {
  task: TaskItem;
  file: string;
}

/** Mark a task done by id (or unique text prefix), stamping the completion date. */
export function completeTask(vault: Vault, idOrText: string): CompleteResult {
  const open = listTasks(vault, { status: "open", includeArchived: true });
  let matches = open.filter((t) => t.id === idOrText);
  if (matches.length === 0) {
    const needle = idOrText.trim().toLowerCase();
    matches = open.filter((t) => t.text.toLowerCase().includes(needle));
  }
  if (matches.length === 0) throw new Error(`No open task matches: ${idOrText}`);
  if (matches.length > 1) {
    const list = matches
      .slice(0, 5)
      .map((t) => `  ${t.id}  ${t.text} (${t.file})`)
      .join("\n");
    throw new Error(`Ambiguous — ${matches.length} open tasks match:\n${list}\nUse the task id.`);
  }
  const task = matches[0]!;
  const abs = path.join(vault.dir, task.file);
  const lines = fs.readFileSync(abs, "utf8").split("\n");
  const line = lines[task.line];
  if (line === undefined || !line.includes(task.raw.trim().slice(0, 20))) {
    throw new Error(
      `Task file changed on disk; re-list tasks and retry (${task.file}:${task.line})`,
    );
  }
  lines[task.line] = `${line.replace(/\[([ /\-])\]/, "[x]")} ✅ ${todayISO()}`;
  fs.writeFileSync(abs, lines.join("\n"), "utf8");
  vault.refresh();
  return { task: { ...task, done: true, completedOn: todayISO() }, file: task.file };
}
