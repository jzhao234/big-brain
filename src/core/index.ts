export { CONFIG_FILENAME, DEFAULT_CONFIG, loadConfig, resolveVault } from "./config.js";
export { getDailyNote, logToDaily, renderTemplate } from "./daily.js";
export { runDoctor } from "./doctor.js";
export { autoCommit } from "./git.js";
export { renderOverview, vaultOverview, type VaultOverview } from "./overview.js";
export {
  extractHeadings,
  extractInlineTags,
  extractLinks,
  extractTasks,
  parseNote,
} from "./parse.js";
export {
  createProject,
  listProjects,
  projectStatus,
  setProjectStatus,
  summarizeProject,
  type CreateProjectInput,
  type ProjectSummary,
} from "./projects.js";
export { initVault, templateDir, type InitOptions, type InitResult } from "./scaffold.js";
export {
  addTask,
  compareTasks,
  completeTask,
  formatTaskLine,
  listTasks,
  type AddTaskInput,
  type CompleteResult,
  type TaskFilter,
} from "./tasks.js";
export type {
  BrainConfig,
  DoctorFinding,
  GitConfig,
  Heading,
  Note,
  NoteLink,
  NoteType,
  ProjectStatus,
  SearchOptions,
  SearchResult,
  TaskItem,
  TaskPriority,
} from "./types.js";
export { makeExcerpt, nowStamp, safeFilename, shortHash, todayISO } from "./util.js";
export { Vault, type CreateNoteInput } from "./vault.js";
