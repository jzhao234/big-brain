import fs from "node:fs";
import path from "node:path";
import type { BrainConfig } from "./types.js";

export const CONFIG_FILENAME = "brain.config.json";

export const DEFAULT_CONFIG: BrainConfig = {
  name: "Brain",
  folders: {
    inbox: "inbox",
    daily: "daily",
    projects: "projects",
    areas: "areas",
    notes: "notes",
    people: "people",
    reference: "reference",
    archive: "archive",
    templates: "templates",
  },
  ignore: [],
  staleProjectDays: 21,
  git: { autoCommit: false, autoPush: false },
};

export function loadConfig(vaultDir: string): BrainConfig {
  const file = path.join(vaultDir, CONFIG_FILENAME);
  if (!fs.existsSync(file)) return { ...DEFAULT_CONFIG, folders: { ...DEFAULT_CONFIG.folders } };
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<BrainConfig>;
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    folders: { ...DEFAULT_CONFIG.folders, ...(raw.folders ?? {}) },
    ignore: raw.ignore ?? [],
    git: { ...DEFAULT_CONFIG.git, ...(raw.git ?? {}) },
  };
}

/**
 * Resolve the vault directory: explicit arg > BIG_BRAIN_VAULT env > walk up
 * from cwd looking for brain.config.json. Throws with guidance if none found.
 */
export function resolveVault(explicit?: string): string {
  if (explicit) {
    const dir = path.resolve(explicit);
    if (!fs.existsSync(dir)) throw new Error(`Vault directory does not exist: ${dir}`);
    return dir;
  }
  const env = process.env.BIG_BRAIN_VAULT;
  if (env && env.trim() !== "") {
    const dir = path.resolve(env);
    if (!fs.existsSync(dir))
      throw new Error(`BIG_BRAIN_VAULT points to a missing directory: ${dir}`);
    return dir;
  }
  let dir = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(dir, CONFIG_FILENAME))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `No vault found. Pass --vault <dir>, set BIG_BRAIN_VAULT, or run inside a directory containing ${CONFIG_FILENAME} (create one with \`big-brain init\`).`,
  );
}

/** Map top-level folder names to default note types. */
export function folderTypeMap(config: BrainConfig): Record<string, string> {
  const f = config.folders;
  return {
    [f.inbox]: "inbox",
    [f.daily]: "daily",
    [f.projects]: "project",
    [f.areas]: "area",
    [f.notes]: "note",
    [f.people]: "person",
    [f.reference]: "reference",
  };
}
