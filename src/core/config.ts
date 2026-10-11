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
    agents: "agents",
  },
  ignore: [],
  staleProjectDays: 21,
  git: { autoCommit: false, autoPush: false },
  embeddings: { enabled: false, model: "Xenova/all-MiniLM-L6-v2" },
};

export function loadConfig(vaultDir: string): BrainConfig {
  const file = path.join(vaultDir, CONFIG_FILENAME);
  if (!fs.existsSync(file)) return { ...DEFAULT_CONFIG, folders: { ...DEFAULT_CONFIG.folders } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const raw = validateConfig(parsed, file);
  const folders = { ...DEFAULT_CONFIG.folders, ...(raw.folders ?? {}) };
  for (const key of Object.keys(folders) as Array<keyof typeof folders>) {
    folders[key] = normalizeFolder(folders[key]);
  }
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    folders,
    ignore: raw.ignore ?? [],
    git: { ...DEFAULT_CONFIG.git, ...(raw.git ?? {}) },
    embeddings: { ...DEFAULT_CONFIG.embeddings, ...(raw.embeddings ?? {}) },
  };
}

/**
 * One spelling per folder, so `daily/`, `./daily`, and `daily` name the same
 * place in lookups, archive checks, and type inference as in writes.
 */
function normalizeFolder(folder: string): string {
  return folder
    .split(/[\\/]+/)
    .filter((s) => s !== "" && s !== ".")
    .join("/");
}

const typeName = (v: unknown): string => typeof v;

/**
 * Check the shape of brain.config.json before defaults are merged in. Types
 * are not coerced: `"autoPush": "false"` is a string, and a truthy one, so it
 * would turn on the very feature it was meant to turn off.
 */
function validateConfig(value: unknown, file: string): Partial<BrainConfig> {
  const fail = (field: string, want: string): never => {
    throw new Error(`${file}: ${field} must be ${want}`);
  };
  const isObject = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === "object" && !Array.isArray(v);
  if (!isObject(value)) fail("the top level", "a JSON object");
  const raw = value as Record<string, unknown>;
  const check = (obj: Record<string, unknown>, prefix: string, types: Record<string, string>) => {
    for (const [key, type] of Object.entries(types)) {
      if (obj[key] !== undefined && typeName(obj[key]) !== type) {
        fail(`${prefix}${key}`, type === "boolean" ? "true or false" : `a ${type}`);
      }
    }
  };
  check(raw, "", { name: "string", staleProjectDays: "number" });
  for (const [section, types] of [
    ["folders", Object.fromEntries(Object.keys(DEFAULT_CONFIG.folders).map((k) => [k, "string"]))],
    [
      "git",
      { autoCommit: "boolean", autoPush: "boolean", authorName: "string", authorEmail: "string" },
    ],
    ["embeddings", { enabled: "boolean", model: "string" }],
  ] as const) {
    const sub = raw[section];
    if (sub === undefined) continue;
    if (!isObject(sub)) fail(section, "an object");
    check(sub as Record<string, unknown>, `${section}.`, types);
  }
  if (raw.ignore !== undefined) {
    if (!Array.isArray(raw.ignore) || !raw.ignore.every((g) => typeof g === "string")) {
      fail("ignore", "a list of glob strings");
    }
  }
  return raw as Partial<BrainConfig>;
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
