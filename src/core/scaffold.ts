import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_FILENAME } from "./config.js";
import { renderTemplate } from "./daily.js";
import { todayISO } from "./util.js";

/** Locate the packaged starter vault (big-brain/template). */
export function templateDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url)); // dist/core
  const dir = path.resolve(here, "..", "..", "template");
  if (!fs.existsSync(dir)) {
    throw new Error(`Starter template not found at ${dir} — is the package installed correctly?`);
  }
  return dir;
}

export interface InitOptions {
  /** Vault display name written into brain.config.json and BRAIN.md. */
  name?: string;
  /** Overwrite files that already exist (default: skip them). */
  force?: boolean;
}

export interface InitResult {
  dir: string;
  written: string[];
  skipped: string[];
}

/** Scaffold a new vault into `target` from the packaged starter template. */
export function initVault(target: string, opts: InitOptions = {}): InitResult {
  const src = templateDir();
  const dest = path.resolve(target);
  fs.mkdirSync(dest, { recursive: true });
  const name = opts.name ?? path.basename(dest);
  const vars = { name, date: todayISO() };
  const written: string[] = [];
  const skipped: string[] = [];

  const walk = (rel: string): void => {
    const abs = path.join(src, rel);
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        fs.mkdirSync(path.join(dest, childRel), { recursive: true });
        walk(childRel);
      } else {
        // npm strips .gitignore from published packages, so the template ships `_gitignore`.
        const outRel = childRel.replace(/(^|\/)_gitignore$/, "$1.gitignore");
        const outAbs = path.join(dest, outRel);
        if (fs.existsSync(outAbs) && !opts.force) {
          skipped.push(outRel);
          continue;
        }
        const content = fs.readFileSync(path.join(src, childRel), "utf8");
        fs.writeFileSync(outAbs, renderTemplate(content, vars), "utf8");
        written.push(outRel);
      }
    }
  };
  walk("");

  // Ensure a config exists even if the template ever drops it.
  const configPath = path.join(dest, CONFIG_FILENAME);
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, `${JSON.stringify({ name }, null, 2)}\n`, "utf8");
    written.push(CONFIG_FILENAME);
  }
  return { dir: dest, written: written.sort(), skipped: skipped.sort() };
}
