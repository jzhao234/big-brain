import matter from "gray-matter";
import yaml from "js-yaml";

/**
 * YAML schema for frontmatter. js-yaml's default schema turns `2026-01-05`
 * into a Date, which then re-serializes as `2026-01-05T00:00:00.000Z` on the
 * next write and stringifies as a locale date when read. This is the default
 * schema minus timestamps (and the rarely used binary/omap/pairs/set tags), so
 * dates stay the strings the user wrote while `<<: *anchor` merges still work.
 */
// Same definition as js-yaml's built-in merge type, which @types/js-yaml doesn't expose.
const MERGE = new yaml.Type("tag:yaml.org,2002:merge", {
  kind: "scalar",
  resolve: (data: unknown) => data === "<<" || data === null,
});
const SCHEMA = yaml.CORE_SCHEMA.extend({ implicit: [MERGE] });

const yamlEngine = {
  parse: (input: string): object => {
    const data = yaml.load(input, { schema: SCHEMA });
    if (data === null || data === undefined) return {};
    // A scalar or list has no keys to keep: reading it as {} would let the
    // next frontmatter write silently replace whatever the user wrote there.
    if (typeof data !== "object" || Array.isArray(data)) {
      throw new Error("Frontmatter must be a YAML mapping (key: value lines)");
    }
    return data;
  },
  stringify: (data: object): string => yaml.dump(data, { schema: SCHEMA }),
};

const OPTIONS = { engines: { yaml: yamlEngine } };

export interface ParsedFrontmatter {
  data: Record<string, unknown>;
  content: string;
}

/**
 * Offset in `raw` where the body starts after a frontmatter block, or
 * undefined when the file has none. Same delimiter rules as gray-matter
 * (leading BOM skipped, `----` is not an opener, the block ends at the first
 * line starting with `---`), except that an opener with no closing delimiter
 * is not frontmatter: a note that merely begins with a `---` rule keeps its
 * text as body instead of having all of it read as YAML.
 */
export function frontmatterEnd(raw: string): number | undefined {
  const start = raw.charCodeAt(0) === 0xfeff ? 1 : 0;
  if (!raw.startsWith("---", start) || raw.charAt(start + 3) === "-") return undefined;
  const close = raw.indexOf("\n---", start + 3);
  if (close === -1) return undefined;
  let end = close + 4;
  if (raw[end] === "\r") end++;
  if (raw[end] === "\n") end++;
  return end;
}

/** Split a markdown file into frontmatter data and body. Throws on malformed YAML. */
export function parseFrontmatter(raw: string): ParsedFrontmatter {
  if (frontmatterEnd(raw) === undefined) {
    return { data: {}, content: raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw };
  }
  // Passing options also bypasses gray-matter's shared parse cache, whose
  // cached `data` objects would otherwise be aliased across callers.
  const parsed = matter(raw, OPTIONS);
  return { data: (parsed.data ?? {}) as Record<string, unknown>, content: parsed.content };
}

/** Serialize a body and frontmatter data back into a markdown file. */
export function stringifyNote(body: string, data: Record<string, unknown>): string {
  // A string would be re-parsed for frontmatter first, so a body that itself
  // opens with `---` lost its first section; a file object is taken as is.
  const out = matter.stringify({ content: body }, data, OPTIONS);
  // With no keys, no block is written; keep an empty one when the body would
  // otherwise read back as frontmatter.
  return Object.keys(data).length === 0 && frontmatterEnd(out) !== undefined
    ? `---\n---\n${out}`
    : out;
}

// YAML's own null spellings, plus nothing at all. `nUlL` is a string in YAML.
const NULL_TEXT = new Set(["", "~", "null", "Null", "NULL"]);

/**
 * Read one command-line frontmatter value the way the vault reads `key: value`
 * (same schema, so `2026-01-05` stays a string). `null`, `Null`, `NULL`, `~`,
 * or nothing means null, which deletes the key. Text that YAML would turn into
 * something the user didn't type as such stays plain text: `Note: see X` is
 * not a mapping, `- a` is not a list, and `#work` is not a comment.
 */
export function parseFrontmatterValue(text: string): unknown {
  const t = text.trim();
  if (NULL_TEXT.has(t)) return null;
  let value: unknown;
  try {
    value = yaml.load(t, { schema: SCHEMA });
  } catch {
    return t;
  }
  if (value === null || value === undefined) return t;
  if (Array.isArray(value)) return t.startsWith("[") ? value : t;
  if (typeof value === "object") return t.startsWith("{") ? value : t;
  return value;
}

/** Parse `key=value` arguments into frontmatter updates (split at the first `=`). */
export function parseFrontmatterAssignments(args: string[]): Record<string, unknown> {
  // No prototype, so `__proto__=…` is stored as a key instead of replacing the prototype.
  const updates: Record<string, unknown> = Object.create(null);
  for (const arg of args) {
    const eq = arg.indexOf("=");
    const key = eq === -1 ? "" : arg.slice(0, eq).trim();
    if (!key) throw new Error(`Invalid frontmatter assignment: ${arg} (want key=value)`);
    updates[key] = parseFrontmatterValue(arg.slice(eq + 1));
  }
  return updates;
}
