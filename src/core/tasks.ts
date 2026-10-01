import { getDailyNote } from "./daily.js";
import type { TaskItem, TaskPriority } from "./types.js";
import { isCalendarDate, todayISO } from "./util.js";
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
      if (status === "open" && (t.done || t.cancelled)) continue;
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
  const text = input.text.trim();
  if (text === "") throw new Error("Task text is empty");
  // A newline would smuggle extra lines (or extra tasks) into the note.
  if (/[\r\n]/.test(text)) throw new Error("Task text must be a single line");
  let line = `- [ ] ${text}`;
  if (input.priority === "high") line += " ⏫";
  if (input.priority === "low") line += " 🔽";
  if (input.due) {
    if (!isCalendarDate(input.due)) {
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

/** Find exactly one task by id, falling back to a case-insensitive text fragment. */
function resolveTask(candidates: TaskItem[], idOrText: string, kind: string): TaskItem {
  let matches = candidates.filter((t) => t.id === idOrText);
  if (matches.length === 0) {
    const needle = idOrText.trim().toLowerCase();
    if (needle !== "") matches = candidates.filter((t) => t.text.toLowerCase().includes(needle));
  }
  if (matches.length === 0) throw new Error(`No ${kind}task matches: ${idOrText}`);
  if (matches.length > 1) {
    const list = matches
      .slice(0, 5)
      .map((t) => `  ${t.id}  ${t.text} (${t.file})`)
      .join("\n");
    throw new Error(`Ambiguous — ${matches.length} ${kind}tasks match:\n${list}\nUse the task id.`);
  }
  return matches[0]!;
}

/**
 * Rewrite one task line under the note lock. The task is re-found by id in the
 * latest file contents (and must still satisfy `stillApplies`), so a concurrent
 * edit fails loudly instead of touching the wrong line or undoing a change. Returns the task as re-parsed from its (unchanged) line index.
 */
function rewriteTask(
  vault: Vault,
  task: TaskItem,
  operation: string,
  edit: (line: string) => string,
  stillApplies: (current: TaskItem) => boolean = () => true,
): TaskItem {
  const stale = () =>
    new Error(`Task changed before it could be updated; re-list tasks and retry (${task.id})`);
  let lineIndex = -1;
  const updated = vault.mutateNote(task.file, operation, (note) => {
    const current = note.tasks.find((candidate) => candidate.id === task.id);
    const lines = note.raw.split("\n");
    const line = current ? lines[current.line] : undefined;
    if (!current || line === undefined || !stillApplies(current)) throw stale();
    lineIndex = current.line;
    lines[lineIndex] = edit(line);
    return lines.join("\n");
  });
  const result = updated.tasks.find((candidate) => candidate.line === lineIndex);
  if (!result) throw new Error(`Task was written but could not be read back: ${task.id}`);
  return result;
}

/** Mark a task done by id (or unique text prefix), stamping the completion date. */
export function completeTask(vault: Vault, idOrText: string): CompleteResult {
  const open = listTasks(vault, { status: "open", includeArchived: true });
  const task = resolveTask(open, idOrText, "open ");
  const completed = rewriteTask(
    vault,
    task,
    "complete task in",
    (line) => setStatus(line, "done"),
    (current) => !current.done && !current.cancelled,
  );
  return { task: completed, file: task.file };
}

export type TaskStatus = "open" | "done" | "cancelled";

export interface TaskUpdate {
  /** New description; existing dates and priority are kept unless also changed. */
  text?: string;
  /** New due date (YYYY-MM-DD), or null to clear it. */
  due?: string | null;
  /** New priority, or null for normal. */
  priority?: TaskPriority | null;
  /** Reopen, complete (stamps today), or cancel the task. */
  status?: TaskStatus;
}

export interface UpdateResult {
  task: TaskItem;
  file: string;
  /** The id before the update; differs from `task.id` when the text changed. */
  previousId: string;
}

// Same patterns as the parser (optional VS16 selector); global so every occurrence is removed.
const DUE_TOKEN = /\s*📅\uFE0F?\s*\d{4}-\d{2}-\d{2}/gu;
const DONE_TOKEN = /\s*✅\uFE0F?\s*\d{4}-\d{2}-\d{2}/gu;
const PRIORITY_TOKEN = /\s*(?:⏫|🔽)\uFE0F?/gu;
const METADATA_TOKEN = /(?:(?:⏫|🔽)\uFE0F?|(?:📅|⏳|✅)\uFE0F?\s*\d{4}-\d{2}-\d{2})/gu;
const LINE_RE = /^(\s*[-*] \[)([ xX/\-])(\]\s+)(.*)$/;

function splitLine(line: string): { head: string; box: string; gap: string; rest: string } {
  const m = LINE_RE.exec(line);
  if (!m) throw new Error(`Not a task line: ${line}`);
  return { head: m[1]!, box: m[2]!, gap: m[3]!, rest: m[4]! };
}

function setStatus(line: string, status: TaskStatus): string {
  const { head, gap, rest } = splitLine(line);
  const box = status === "done" ? "x" : status === "cancelled" ? "-" : " ";
  let next = rest.replace(DONE_TOKEN, "");
  if (status === "done") next += ` ✅ ${todayISO()}`;
  return `${head}${box}${gap}${next.trim()}`;
}

function applyUpdate(line: string, update: TaskUpdate): string {
  const { head, box, gap } = splitLine(line);
  let { rest } = splitLine(line);
  if (update.text !== undefined) {
    const metadata = rest.match(METADATA_TOKEN) ?? [];
    rest = [update.text, ...metadata].join(" ");
  }
  if (update.priority !== undefined) {
    rest = rest.replace(PRIORITY_TOKEN, "");
    if (update.priority === "high") rest += " ⏫";
    if (update.priority === "low") rest += " 🔽";
  }
  if (update.due !== undefined) {
    rest = rest.replace(DUE_TOKEN, "");
    if (update.due !== null) rest += ` 📅 ${update.due}`;
  }
  let result = `${head}${box}${gap}${rest.trim()}`;
  if (update.status !== undefined) result = setStatus(result, update.status);
  return result;
}

/**
 * Edit a task in place — reschedule, reprioritize, reword, reopen, or cancel —
 * matched by id (or a unique text fragment) across open, done, and cancelled
 * tasks. Only the task's own line is rewritten.
 */
export function updateTask(vault: Vault, idOrText: string, changes: TaskUpdate): UpdateResult {
  if (Object.values(changes).every((v) => v === undefined)) {
    throw new Error("Nothing to update: pass text, due, priority, or status");
  }
  const text = changes.text?.trim();
  if (text !== undefined) {
    if (text === "") throw new Error("Task text is empty");
    if (/[\r\n]/.test(text)) throw new Error("Task text must be a single line");
  }
  const update: TaskUpdate = { ...changes, text };
  if (update.due != null && !isCalendarDate(update.due)) {
    throw new Error(`Invalid due date (want YYYY-MM-DD): ${update.due}`);
  }
  const all = listTasks(vault, { status: "all", includeArchived: true });
  const task = resolveTask(all, idOrText, "");
  const updated = rewriteTask(vault, task, "update task in", (line) => applyUpdate(line, update));
  return { task: updated, file: task.file, previousId: task.id };
}
