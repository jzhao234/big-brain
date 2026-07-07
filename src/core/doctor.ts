import { projectStatus } from "./projects.js";
import type { DoctorFinding } from "./types.js";
import { nameKey, todayISO } from "./util.js";
import type { Vault } from "./vault.js";

/** Lint the vault: broken links, duplicate names, stale projects, overdue tasks, hygiene. */
export function runDoctor(vault: Vault): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  const notes = vault.notes(true);
  const active = notes.filter((n) => !n.archived);

  // Broken wikilinks.
  for (const note of active) {
    for (const link of note.links) {
      if (!vault.resolveLink(link)) {
        findings.push({
          severity: "warning",
          rule: "broken-link",
          message: `[[${link.target}]] does not resolve to any note`,
          path: note.path,
        });
      }
    }
  }

  // Duplicate titles/aliases (ambiguous wikilink targets).
  const byName = new Map<string, string[]>();
  for (const note of active) {
    const names = [note.title, ...note.aliases];
    for (const name of names) {
      const key = nameKey(name);
      byName.set(key, [...(byName.get(key) ?? []), note.path]);
    }
  }
  for (const [name, paths] of byName) {
    const unique = [...new Set(paths)];
    if (unique.length > 1) {
      findings.push({
        severity: "warning",
        rule: "duplicate-name",
        message: `"${name}" is the title/alias of ${unique.length} notes: ${unique.join(", ")}`,
      });
    }
  }

  // Stale active projects.
  const staleMs = vault.config.staleProjectDays * 24 * 60 * 60 * 1000;
  const now = Date.now();
  for (const note of active.filter((n) => n.type === "project")) {
    if (projectStatus(note) === "active" && now - note.mtimeMs > staleMs) {
      const days = Math.floor((now - note.mtimeMs) / (24 * 60 * 60 * 1000));
      findings.push({
        severity: "info",
        rule: "stale-project",
        message: `Active project untouched for ${days} days — still active, or should it be paused/done?`,
        path: note.path,
      });
    }
  }

  // Overdue tasks.
  const today = todayISO();
  for (const note of active) {
    for (const t of note.tasks) {
      if (!t.done && t.due !== undefined && t.due < today) {
        findings.push({
          severity: "warning",
          rule: "overdue-task",
          message: `Overdue task (due ${t.due}): ${t.text}`,
          path: note.path,
        });
      }
    }
  }

  // Inbox pileup.
  const inboxCount = active.filter((n) =>
    n.path.startsWith(`${vault.config.folders.inbox}/`),
  ).length;
  if (inboxCount >= 10) {
    findings.push({
      severity: "info",
      rule: "inbox-pileup",
      message: `${inboxCount} unprocessed inbox notes — worth a triage pass`,
    });
  }

  // Notes with no frontmatter type and no links either way (likely dumped, never wired in).
  for (const note of active) {
    if (note.type === "daily" || note.type === "inbox") continue;
    if (!note.path.includes("/")) continue; // root-level meta files (BRAIN.md, CLAUDE.md)
    const hasOutgoing = note.links.length > 0;
    const hasIncoming = vault.backlinks(note.path).length > 0;
    if (!hasOutgoing && !hasIncoming) {
      findings.push({
        severity: "info",
        rule: "orphan-note",
        message: "No links in or out — connect it to a project, area, or related note",
        path: note.path,
      });
    }
  }

  const order = { error: 0, warning: 1, info: 2 };
  return findings.sort((a, b) => order[a.severity] - order[b.severity]);
}
