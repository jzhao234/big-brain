export { CONFIG_FILENAME, DEFAULT_CONFIG, loadConfig, resolveVault } from "./config.js";
export { getDailyNote, logToDaily, renderTemplate } from "./daily.js";
export { runDoctor } from "./doctor.js";
export {
  chunkNote,
  createEmbeddingProvider,
  type EmbeddingProvider,
  type HybridDeps,
  hybridSearch,
  INDEX_DIR,
  INDEX_FILE,
  rrfFuse,
  SemanticIndex,
} from "./embeddings.js";
export { autoCommit, settlePushes } from "./git.js";
export { renderOverview, type VaultOverview, vaultOverview } from "./overview.js";
export {
  extractHeadings,
  extractInlineTags,
  extractLinks,
  extractTasks,
  parseNote,
} from "./parse.js";
export {
  type CreateProjectInput,
  createProject,
  listProjects,
  type ProjectSummary,
  projectStatus,
  setProjectStatus,
  summarizeProject,
} from "./projects.js";
export { type RelatedNote, type RelatedOptions, relatedNotes } from "./related.js";
export { type InitOptions, type InitResult, initVault, templateDir } from "./scaffold.js";
export {
  defaultClaudeSkillsDir,
  type InstallSkillsResult,
  installSkills,
  skillsDir,
} from "./skills.js";
export {
  type AddTaskInput,
  addTask,
  type CompleteResult,
  compareTasks,
  completeTask,
  formatTaskLine,
  listTasks,
  type TaskFilter,
  type TaskStatus,
  type TaskUpdate,
  type UpdateResult,
  updateTask,
} from "./tasks.js";
export type {
  BrainConfig,
  DoctorFinding,
  EmbeddingsConfig,
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
export { type CreateNoteInput, Vault } from "./vault.js";
export { PACKAGE_NAME, VERSION } from "./version.js";
