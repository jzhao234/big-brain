import { execFileSync } from "node:child_process";
import type { GitConfig } from "./types.js";

function git(vaultDir: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: vaultDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function isGitRepo(vaultDir: string): boolean {
  try {
    return git(vaultDir, ["rev-parse", "--is-inside-work-tree"]).trim() === "true";
  } catch {
    return false;
  }
}

function hasChanges(vaultDir: string, paths: string[]): boolean {
  try {
    return git(vaultDir, ["status", "--porcelain", "--", ...literalPathspecs(paths)]).trim() !== "";
  } catch {
    return false;
  }
}

function literalPathspecs(paths: string[]): string[] {
  return paths.map((p) => `:(literal)${p}`);
}

/**
 * Commit (and optionally push) only the paths touched by a vault write.
 *
 * Best-effort by design: if the vault isn't a git repo, has nothing to commit,
 * or git errors for any reason, this returns quietly (logging a one-line warning
 * to stderr for real failures). A save has ALREADY happened on disk by the time
 * this runs — git is durability, never a gate. It must not throw.
 *
 * `git commit --only` keeps unrelated staged, unstaged, and untracked work out
 * of the commit. Pre-existing edits within a touched file are necessarily
 * included because git commits files, not ownership of individual hunks.
 */
export function autoCommit(
  vaultDir: string,
  message: string,
  cfg: GitConfig,
  touchedPaths: string[] = [],
): void {
  if (!cfg.autoCommit) return;
  const paths = [...new Set(touchedPaths.filter((p) => p.trim() !== ""))];
  if (paths.length === 0) return;
  try {
    if (!isGitRepo(vaultDir)) return;
    if (!hasChanges(vaultDir, paths)) return;

    const identity: string[] = [];
    if (cfg.authorName && cfg.authorEmail) {
      identity.push("-c", `user.name=${cfg.authorName}`, "-c", `user.email=${cfg.authorEmail}`);
    }

    const pathspecs = literalPathspecs(paths);
    git(vaultDir, ["add", "-A", "--", ...pathspecs]);
    git(vaultDir, [...identity, "commit", "-q", "-m", message, "--only", "--", ...pathspecs]);

    if (cfg.autoPush) {
      try {
        git(vaultDir, ["push", "-q"]);
      } catch (err) {
        // Offline / no upstream / rejected: the commit is safe locally; sync later.
        warn(`auto-push failed (commit kept locally): ${errText(err)}`);
      }
    }
  } catch (err) {
    warn(`auto-commit skipped: ${errText(err)}`);
  }
}

function errText(err: unknown): string {
  if (err && typeof err === "object" && "stderr" in err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? "").trim();
    if (stderr) return stderr;
  }
  return err instanceof Error ? err.message : String(err);
}

function warn(message: string): void {
  // stderr only — never stdout, which is the MCP transport.
  console.error(`big-brain: ${message}`);
}
