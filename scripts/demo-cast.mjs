#!/usr/bin/env node
// Records the README demo: runs real CLI commands against a throwaway vault and
// writes an asciicast v2 file. Render it with:
//   npm run build && node scripts/demo-cast.mjs docs/demo.cast
//   npx svg-term-cli@2.1.1 --in docs/demo.cast --out docs/demo.svg --window --no-cursor --width 100 --height 36
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const out = process.argv[2] ?? "docs/demo.cast";
const cli = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "cli",
  "index.js",
);
const home = fs.mkdtempSync(path.join(os.tmpdir(), "big-brain-demo-"));
const vault = path.join(home, "brain");

const { BIG_BRAIN_VAULT: _ignored, ...env } = process.env;

const steps = [
  ["init", "~/brain", "--name", "My Brain"],
  ["capture", "Ask Sam about the conference talk slot"],
  ["project", "new", "Launch the newsletter", "--goal", "Issue #1 sent to 50 readers"],
  ["task", "add", "Draft issue #1", "-n", "Launch the newsletter", "--due", "2026-10-16"],
  ["task", "add", "Pick a sending platform", "-n", "Launch the newsletter"],
  ["status"],
  ["search", "newsletter"],
];

const quote = (a) => (/[\s#]/.test(a) ? `"${a}"` : a);
const events = [];
let t = 0.5;
const emit = (text) => events.push([Number(t.toFixed(3)), "o", text]);

for (const args of steps) {
  emit("\x1b[32m$\x1b[0m ");
  for (const ch of `big-brain ${args.map(quote).join(" ")}`) {
    t += 0.035;
    emit(ch);
  }
  t += 0.4;
  emit("\r\n");
  const real = args.map((a) => (a === "~/brain" ? vault : a));
  const output = execFileSync(process.execPath, [cli, ...real], {
    cwd: args[0] === "init" ? home : vault,
    env: { ...env, FORCE_COLOR: "1" },
    encoding: "utf8",
  });
  emit(output.replaceAll(vault, "~/brain").replaceAll(home, "~").replace(/\n/g, "\r\n"));
  t += args[0] === "status" ? 3.5 : 1.6;
}
emit("");

const header = { version: 2, width: 100, height: 36, env: { TERM: "xterm-256color" } };
fs.writeFileSync(out, `${[header, ...events].map((e) => JSON.stringify(e)).join("\n")}\n`);
fs.rmSync(home, { recursive: true, force: true });
console.log(`wrote ${out} (${t.toFixed(1)}s)`);
