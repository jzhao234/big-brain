export { CONFIG_FILENAME, DEFAULT_CONFIG, loadConfig, resolveVault } from "./config.js";
export { getDailyNote, logToDaily, renderTemplate } from "./daily.js";
export { runDoctor } from "./doctor.js";
export {
  INDEX_DIR,
  INDEX_FILE,
  SemanticIndex,
  chunkNote,
  createEmbeddingProvider,
  hybridSearch,
  rrfFuse,
  type EmbeddingProvider,
  type HybridDeps,
} from "./embeddings.js";
export { autoCommit } from "./git.js";
export { relatedNotes, type RelatedNote, type RelatedOptions } from "./related.js";
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
  defaultClaudeSkillsDir,
  installSkills,
  skillsDir,
  type InstallSkillsResult,
} from "./skills.js";
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
export { Vault, type CreateNoteInput } from "./vault.js";
