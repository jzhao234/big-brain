import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Locate the packaged skills directory (big-brain/skills). */
export function skillsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url)); // dist/core
  const dir = path.resolve(here, "..", "..", "skills");
  if (!fs.existsSync(dir)) {
    throw new Error(`Bundled skills not found at ${dir} — is the package installed correctly?`);
  }
  return dir;
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
