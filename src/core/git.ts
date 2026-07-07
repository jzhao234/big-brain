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

function hasChanges(vaultDir: string): boolean {
  try {
    return git(vaultDir, ["status", "--porcelain"]).trim() !== "";
  } catch {
    return false;
  }
}

/**
 * Commit (and optionally push) the whole vault after a write.
 *
 * Best-effort by design: if the vault isn't a git repo, has nothing to commit,
 * or git errors for any reason, this returns quietly (logging a one-line warning
 * to stderr for real failures). A save has ALREADY happened on disk by the time
 * this runs — git is durability, never a gate. It must not throw.
 *
 * Uses `git add -A`, so any stragglers left uncommitted by an external editor
 * (Obsidian, vim) get swept into the next tool-triggered commit too.
 */
export function autoCommit(vaultDir: string, message: string, cfg: GitConfig): void {
  if (!cfg.autoCommit) return;
  try {
    if (!isGitRepo(vaultDir)) return;
    if (!hasChanges(vaultDir)) return;

    const identity: string[] = [];
    if (cfg.authorName && cfg.authorEmail) {
      identity.push("-c", `user.name=${cfg.authorName}`, "-c", `user.email=${cfg.authorEmail}`);
    }

    git(vaultDir, ["add", "-A"]);
    git(vaultDir, [...identity, "commit", "-q", "-m", message]);

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
