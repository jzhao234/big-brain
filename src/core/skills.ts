import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Locate the packaged skills for one agent (big-brain/skills/<agent>). Each
 * agent gets its own copy because skill wording and metadata differ (Claude
 * uses /name, Codex uses $name plus agents/openai.yaml).
 */
export function skillsDir(agent = "claude"): string {
  const here = path.dirname(fileURLToPath(import.meta.url)); // dist/core
  const dir = path.resolve(here, "..", "..", "skills", agent);
  if (!fs.existsSync(dir)) {
    throw new Error(`Bundled skills not found at ${dir} — is the package installed correctly?`);
  }
  return dir;
}

/** Packaged skills for an agent, or null when big-brain ships none for it. */
export function bundledSkillsDir(agent: string): string | null {
  try {
    return skillsDir(agent);
  } catch {
    return null;
  }
}

/** Default Claude Code skills directory (~/.claude/skills). */
export function defaultClaudeSkillsDir(): string {
  return path.join(os.homedir(), ".claude", "skills");
}

export interface InstallSkillsResult {
  targetDir: string;
  installed: string[];
  skipped: string[];
}

/**
 * Copy the bundled brain skills (brain, capture, weekly) into a Claude Code
 * skills directory. Skips skills that already exist unless `force` is set, so
 * re-running is safe and won't clobber a user's edits by default.
 */
export function installSkills(
  targetDir: string = defaultClaudeSkillsDir(),
  opts: { force?: boolean } = {},
): InstallSkillsResult {
  const src = skillsDir();
  fs.mkdirSync(targetDir, { recursive: true });
  const installed: string[] = [];
  const skipped: string[] = [];

  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const destSkill = path.join(targetDir, entry.name);
    if (fs.existsSync(destSkill) && !opts.force) {
      skipped.push(entry.name);
      continue;
    }
    fs.cpSync(path.join(src, entry.name), destSkill, { recursive: true, force: true });
    installed.push(entry.name);
  }
  return { targetDir, installed: installed.sort(), skipped: skipped.sort() };
}
