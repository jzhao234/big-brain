import type { Note } from "./types.js";
import { nowStamp, todayISO } from "./util.js";
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

/** Get (or create) the daily note for a date (default today). */
export function getDailyNote(vault: Vault, date?: string): Note {
  const day = date ?? todayISO();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error(`Invalid date (want YYYY-MM-DD): ${date}`);
  }
  const rel = `${vault.config.folders.daily}/${day}.md`;
  const existing = vault.get(rel);
  if (existing) return existing;
  const tpl = vault.template("daily");
  const body = tpl ? renderTemplate(tpl, { date: day, title: day }) : DAILY_TEMPLATE;
  return vault.createNote({
    title: day,
    type: "daily",
    folder: vault.config.folders.daily,
    body,
  });
}

/** Append a timestamped entry to today's Log section. */
export function logToDaily(vault: Vault, text: string, date?: string): Note {
  const note = getDailyNote(vault, date);
  return vault.appendToNote(note.path, `- ${nowStamp()} — ${text.trim()}`, "Log");
}
