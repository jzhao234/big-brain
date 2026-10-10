import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const LOCK_DIR = path.join(".bigbrain", "locks");
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;
/** A lock this old is reclaimed even if its owner pid is alive (hung, or a reused pid). */
const ABANDONED_LOCK_MS = 10 * 60_000;
const RETRY_MS = 10;
const sleeper = new Int32Array(new SharedArrayBuffer(4));

export function errorCode(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err
    ? String((err as { code?: unknown }).code)
    : undefined;
}

function lockPath(vaultDir: string, notePath: string): string {
  const key = createHash("sha256").update(notePath).digest("hex");
  return path.join(vaultDir, LOCK_DIR, `${key}.lock`);
}

/** Whether the process that wrote a lock token (`pid:uuid`) still exists on this machine. */
function ownerAlive(token: string): boolean {
  const pid = Number(token.split(":")[0]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errorCode(err) === "EPERM"; // exists, owned by another user
  }
}

function removeStaleLock(file: string): boolean {
  try {
    const age = Date.now() - fs.statSync(file).mtimeMs;
    if (age <= STALE_LOCK_MS) return false;
    // Age alone doesn't prove the owner stopped writing (a long refresh, a
    // suspended process): reclaiming its lock would let two writers interleave.
    if (age <= ABANDONED_LOCK_MS && ownerAlive(fs.readFileSync(file, "utf8"))) return false;
    fs.unlinkSync(file);
    return true;
  } catch (err) {
    return errorCode(err) === "ENOENT";
  }
}

/** Serialize local processes that mutate the same vault-relative note path. */
export function withNoteLock<T>(vaultDir: string, notePath: string, fn: () => T): T {
  const file = lockPath(vaultDir, notePath);
  const token = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  fs.mkdirSync(path.dirname(file), { recursive: true });

  for (;;) {
    try {
      fs.writeFileSync(file, token, { encoding: "utf8", flag: "wx", mode: 0o600 });
      break;
    } catch (err) {
      if (errorCode(err) !== "EEXIST") throw err;
      if (removeStaleLock(file)) continue;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting to write note: ${notePath} (lock file ${file})`);
      }
      Atomics.wait(sleeper, 0, 0, RETRY_MS);
    }
  }

  try {
    return fn();
  } finally {
    // A stale-lock recovery may have replaced this file. Never remove a lock
    // unless it is still the one acquired by this process.
    try {
      if (fs.readFileSync(file, "utf8") === token) fs.unlinkSync(file);
    } catch {
      // The mutation result is authoritative. A failed cleanup becomes a stale
      // lock and is recovered on the next write rather than masking the result.
    }
  }
}

/** Replace a file atomically using a same-directory temporary file. */
export function atomicWriteFile(file: string, content: string): void {
  const dir = path.dirname(file);
  // Short, fixed-length name: a long target filename plus a suffix could pass
  // the filesystem's 255-byte name limit.
  const temp = path.join(dir, `.${randomUUID()}.tmp`);
  const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o666;
  let fd: number | undefined;
  fs.mkdirSync(dir, { recursive: true });

  try {
    fd = fs.openSync(temp, "wx", mode);
    fs.writeFileSync(fd, content, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      fs.unlinkSync(temp);
    } catch {
      // Preserve the original write/rename result; abandoned temp files are
      // ignored by vault scans and can be removed independently.
    }
  }
}
