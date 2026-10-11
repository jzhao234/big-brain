import { parseFrontmatter } from "./frontmatter.js";
import type { Note } from "./types.js";
import { isCalendarDate, nowStamp, todayISO } from "./util.js";
import type { Vault } from "./vault.js";

const DAILY_TEMPLATE = `## Focus

## Log

## Tasks

## Notes
`;

/** Render {{date}} / {{title}} placeholders in a template body. */
export function renderTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key: string) => vars[key] ?? m);
}

/**
 * Split a rendered template into its own frontmatter and body, so an
 * Obsidian-style template's `---` block becomes note metadata instead of a
 * second YAML block in the body. The note's own fields (type, created) win;
 * template tags are merged with the note's. A template whose frontmatter
 * doesn't parse is used whole as the body, as before.
 */
export function templateParts(rendered: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  try {
    const { data, content } = parseFrontmatter(rendered);
    const { type: _type, created: _created, ...frontmatter } = data;
    return { frontmatter, body: content };
  } catch {
    return { frontmatter: {}, body: rendered };
  }
}

/** Get (or create) the daily note for a date (default today). */
export function getDailyNote(vault: Vault, date?: string): Note {
  const day = date ?? todayISO();
  if (!isCalendarDate(day)) {
    throw new Error(`Invalid date (want YYYY-MM-DD): ${date}`);
  }
  const folder = vault.config.folders.daily;
  const rel = folder === "" ? `${day}.md` : `${folder}/${day}.md`;
  const existing = vault.get(rel);
  if (existing) return existing;
  const tpl = vault.template("daily");
  const { frontmatter, body } = tpl
    ? templateParts(renderTemplate(tpl, { date: day, title: day }))
    : { frontmatter: {}, body: DAILY_TEMPLATE };
  try {
    return vault.createNote({
      title: day,
      type: "daily",
      folder: vault.config.folders.daily,
      frontmatter,
      body,
    });
  } catch (error) {
    // Another process may have created this day's note after our initial read.
    vault.refresh();
    const raced = vault.get(rel);
    if (raced) return raced;
    throw error;
  }
}

/** Append a timestamped entry to today's Log section. */
export function logToDaily(vault: Vault, text: string, date?: string): Note {
  const note = getDailyNote(vault, date);
  return vault.appendToNote(note.path, `- ${nowStamp()} — ${text.trim()}`, "Log");
}
