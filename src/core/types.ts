/** A parsed `[[wikilink]]` occurrence inside a note body. */
export interface NoteLink {
  /** Link target as written (note title, alias, or filename stem). */
  target: string;
  /** Optional heading fragment (`[[Note#Heading]]`). */
  heading?: string;
  /** Optional display alias (`[[Note|alias]]`). */
  alias?: string;
  /** The raw matched text, e.g. `[[Note|alias]]`. */
  raw: string;
}

export interface Heading {
  depth: number;
  text: string;
  /** 0-based line index in the note body (after frontmatter). */
  line: number;
}

export type TaskPriority = "high" | "low";

/** A `- [ ]` checkbox line anywhere in the vault. */
export interface TaskItem {
  /** Stable short id derived from file path + task text. */
  id: string;
  /** Task text with checkbox and emoji metadata stripped. */
  text: string;
  /** The full original line. */
  raw: string;
  done: boolean;
  /** Vault-relative posix path of the containing file. */
  file: string;
  /** 0-based line index in the file (including frontmatter lines). */
  line: number;
  /** Due date from `📅 YYYY-MM-DD`. */
  due?: string;
  /** Scheduled date from `⏳ YYYY-MM-DD`. */
  scheduled?: string;
  /** Completion date from `✅ YYYY-MM-DD`. */
  completedOn?: string;
  /** `⏫` = high, `🔽` = low. */
  priority?: TaskPriority;
  /** Inline #tags on the task line. */
  tags: string[];
  /** Title of the containing note (project name when the file is a project). */
  noteTitle: string;
  /** Type of the containing note. */
  noteType: string;
}

export type NoteType =
  | "note"
  | "project"
  | "daily"
  | "person"
  | "reference"
  | "inbox"
  | (string & {});

export type ProjectStatus = "idea" | "active" | "paused" | "done" | "dropped" | (string & {});

export interface Note {
  /** Vault-relative posix path, e.g. `projects/Big Brain.md`. */
  path: string;
  absPath: string;
  /** frontmatter `title` > first H1 > filename stem. */
  title: string;
  type: NoteType;
  frontmatter: Record<string, unknown>;
  /** Frontmatter tags + inline #tags, lowercased, deduped. */
  tags: string[];
  aliases: string[];
  links: NoteLink[];
  tasks: TaskItem[];
  headings: Heading[];
  /** Body without frontmatter. */
  body: string;
  /** Full raw file content. */
  raw: string;
  mtimeMs: number;
  /** True when the note lives under the archive folder. */
  archived: boolean;
  /** First ~200 chars of prose, for listings. */
  excerpt: string;
}

export interface SearchResult {
  path: string;
  title: string;
  type: NoteType;
  score: number;
  tags: string[];
  excerpt: string;
  /** Terms that matched, useful for debugging relevance. */
  matches: string[];
}

export interface SearchOptions {
  /** Restrict to a note type (e.g. `project`). */
  type?: string;
  /** Restrict to notes carrying this tag. */
  tag?: string;
  /** Restrict to a folder prefix (e.g. `projects/`). */
  folder?: string;
  /** Restrict to notes whose frontmatter `status` matches. */
  status?: string;
  /** Include archived notes (default false). */
  includeArchived?: boolean;
  limit?: number;
}

export interface BrainConfig {
  /** Human name for the vault, used in greetings/overviews. */
  name: string;
  /** Folder names, overridable so people can adapt existing vaults. */
  folders: {
    inbox: string;
    daily: string;
    projects: string;
    areas: string;
    notes: string;
    people: string;
    reference: string;
    archive: string;
    templates: string;
  };
  /** Extra glob patterns to ignore when scanning. */
  ignore: string[];
  /** Days without modification before an active project is flagged stale. */
  staleProjectDays: number;
  /** Auto-commit (and optionally push) after every write, so saves never sit uncommitted. */
  git: GitConfig;
}

export interface GitConfig {
  /** Commit the vault after each write via the tool (default false). Best-effort — a git failure never blocks the save. */
  autoCommit: boolean;
  /** Also `git push` after each auto-commit (default false). Requires a configured upstream; failures are non-fatal. */
  autoPush: boolean;
  /** Commit author name; falls back to the repo/global git identity when empty. */
  authorName?: string;
  /** Commit author email; set both to avoid unattributed commits on shared boxes. */
  authorEmail?: string;
}

export interface DoctorFinding {
  severity: "error" | "warning" | "info";
  rule: string;
  message: string;
  path?: string;
}
