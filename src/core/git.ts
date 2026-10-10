import { execFileSync, spawn } from "node:child_process";
import type { GitConfig } from "./types.js";

const LOCAL_GIT_TIMEOUT_MS = 10_000;
const PUSH_TIMEOUT_MS = 120_000;

function git(vaultDir: string, args: string[], timeout = LOCAL_GIT_TIMEOUT_MS): string {
  return execFileSync("git", args, {
    cwd: vaultDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
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

    if (cfg.autoPush) pushInBackground(vaultDir);
  } catch (err) {
    warn(`auto-commit skipped: ${errText(err)}`);
  }
}

/** Per vault: the push in flight, and whether another commit landed meanwhile. */
const pushes = new Map<string, { done: Promise<void>; again: boolean }>();

/**
 * Push without blocking the caller. A synchronous push held the event loop
 * for up to its timeout, which on the MCP servers stalled every other request
 * behind one slow or offline network. Pushes are coalesced per vault: while
 * one runs, later commits just mark that one more push is needed. The child
 * is detached, so a CLI process can exit and the push still completes.
 */
function pushInBackground(vaultDir: string): void {
  const running = pushes.get(vaultDir);
  if (running) {
    running.again = true;
    return;
  }
  const state = { done: Promise.resolve(), again: false };
  const once = (): Promise<void> =>
    new Promise((resolve) => {
      const child = spawn("git", ["push", "-q"], {
        cwd: vaultDir,
        detached: true,
        stdio: "ignore",
        timeout: PUSH_TIMEOUT_MS,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      child.unref();
      child.on("error", (err) => {
        warn(`auto-push failed (commit kept locally): ${errText(err)}`);
        resolve();
      });
      child.on("exit", (code, signal) => {
        // Offline / no upstream / rejected: the commit is safe locally; sync later.
        if (code !== 0) {
          warn(`auto-push failed (commit kept locally): git push exited ${signal ?? code}`);
        }
        resolve();
      });
    });
  const loop = async () => {
    do {
      state.again = false;
      await once();
    } while (state.again);
    pushes.delete(vaultDir);
  };
  state.done = loop();
  pushes.set(vaultDir, state);
}

/** Resolves once every background push started by this process has finished. */
export async function settlePushes(): Promise<void> {
  while (pushes.size > 0) await Promise.all([...pushes.values()].map((p) => p.done));
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
