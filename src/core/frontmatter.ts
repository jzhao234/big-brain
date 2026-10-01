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
    return data !== null && typeof data === "object" ? data : {};
  },
  stringify: (data: object): string => yaml.dump(data, { schema: SCHEMA }),
};

const OPTIONS = { engines: { yaml: yamlEngine } };

export interface ParsedFrontmatter {
  data: Record<string, unknown>;
  content: string;
}

/** Split a markdown file into frontmatter data and body. Throws on malformed YAML. */
export function parseFrontmatter(raw: string): ParsedFrontmatter {
  // Passing options also bypasses gray-matter's shared parse cache, whose
  // cached `data` objects would otherwise be aliased across callers.
  const parsed = matter(raw, OPTIONS);
  return { data: (parsed.data ?? {}) as Record<string, unknown>, content: parsed.content };
}

/** Serialize a body and frontmatter data back into a markdown file. */
export function stringifyNote(body: string, data: Record<string, unknown>): string {
  return matter.stringify(body, data, OPTIONS);
}
