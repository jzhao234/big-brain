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

const DELIMITER_RE = /^---[ \t]*\r?$/;

/**
 * Locate a frontmatter block: the YAML between a first line of `---` (after
 * an optional BOM) and the next line that is exactly `---`, and the offset
 * where the body starts. Undefined when the file has none. Unlike
 * gray-matter, which this replaces for parsing, a delimiter must be a whole
 * line (`----`, `---yaml`, and `--- text` are not delimiters, so a closing
 * line with text after it can't start the body mid-line), and an opener with
 * no closing line is not frontmatter: a note that merely begins with a `---`
 * rule keeps its text as body instead of having all of it read as YAML.
 */
function frontmatterBlock(raw: string): { yaml: string; end: number } | undefined {
  const start = raw.charCodeAt(0) === 0xfeff ? 1 : 0;
  let lineStart = start;
  let yamlStart: number | undefined;
  for (;;) {
    const newline = raw.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? raw.length : newline;
    const isDelimiter = DELIMITER_RE.test(raw.slice(lineStart, lineEnd));
    if (yamlStart === undefined) {
      if (!isDelimiter || newline === -1) return undefined;
      yamlStart = newline + 1;
    } else if (isDelimiter) {
      // A closing line at the very end of the file has no newline to skip.
      return {
        yaml: raw.slice(yamlStart, lineStart),
        end: newline === -1 ? raw.length : newline + 1,
      };
    } else if (newline === -1) {
      return undefined;
    }
    lineStart = newline + 1;
  }
}

/** Offset in `raw` where the body starts after a frontmatter block, or undefined when it has none. */
export function frontmatterEnd(raw: string): number | undefined {
  return frontmatterBlock(raw)?.end;
}

/** Split a markdown file into frontmatter data and body. Throws on malformed YAML. */
export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const block = frontmatterBlock(raw);
  if (block === undefined) {
    return { data: {}, content: raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw };
  }
  const data = yamlEngine.parse(block.yaml) as Record<string, unknown>;
  return { data, content: raw.slice(block.end) };
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
