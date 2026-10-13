#!/usr/bin/env node
// Records the README's AI demo: real Claude Code turns (claude -p, resumed into
// one conversation) against a throwaway vault, with no built-in tools and only
// the big-brain MCP server. Writes the transcript (<out>.json) and an
// asciicast; typing and pauses in the cast are illustrative. Needs a
// logged-in `claude` CLI and `npm run build`. Then render:
//   node scripts/demo-ai.mjs docs/demo-ai.cast
//   npx svg-term-cli@2.1.1 --in docs/demo-ai.cast --out docs/demo-ai.svg --window --no-cursor --width 100 --height 34
// Re-render a saved transcript without new Claude turns:
//   DEMO_TRANSCRIPT=docs/demo-ai.cast.json node scripts/demo-ai.mjs docs/demo-ai.cast
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const out = process.argv[2] ?? "docs/demo-ai.cast";
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const WIDTH = 100;

const prompts = [
  "what am I working on?",
  "capture: ask the contractor whether the old sink can be reused",
  "I got the second cabinet quote, mark that done",
];

// --- recording ---------------------------------------------------------------

function day(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

/** Instruction files Claude Code would pick up from the working directory's ancestors. */
function ancestorInstructions(dir) {
  const found = [];
  for (let d = dir; ; d = path.dirname(d)) {
    for (const name of ["CLAUDE.md", "CLAUDE.local.md", path.join(".claude", "CLAUDE.md")]) {
      if (fs.existsSync(path.join(d, name))) found.push(path.join(d, name));
    }
    if (path.dirname(d) === d) return found;
  }
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Weekday/date pairs like "Thursday (Oct 16)" that name the wrong weekday. */
function wrongWeekdays(text) {
  const year = new Date().getFullYear();
  const re = new RegExp(`(${DAYS.join("|")}),? \\(?(${MONTHS.join("|")})[a-z]* (\\d{1,2})`, "g");
  return [...text.matchAll(re)]
    .filter((m) => DAYS[new Date(year, MONTHS.indexOf(m[2]), Number(m[3])).getDay()] !== m[1])
    .map((m) => m[0]);
}

/** Strings that identify the person recording, which must not reach a public artifact. */
function personalStrings() {
  const git = (key) => {
    try {
      return execFileSync("git", ["config", key], { encoding: "utf8" }).trim();
    } catch {
      return "";
    }
  };
  return [git("user.email"), git("user.name"), os.userInfo().username, os.homedir()].filter(
    (s) => s.length > 2,
  );
}

function record() {
  const cli = path.join(root, "dist", "cli", "index.js");
  const server = path.join(root, "dist", "mcp", "index.js");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "big-brain-ai-demo-"));
  const vault = path.join(work, "brain");
  const { BIG_BRAIN_VAULT: _ignored, ...env } = process.env;
  const turns = [];
  try {
    const stray = ancestorInstructions(work);
    if (stray.length > 0) {
      throw new Error(`instruction files would leak into the demo: ${stray.join(", ")}`);
    }

    // A small, realistic vault.
    const bb = (...args) =>
      execFileSync(process.execPath, [cli, "--vault", vault, ...args], { env, encoding: "utf8" });
    execFileSync(process.execPath, [cli, "init", vault, "--name", "My Brain"], { env });
    bb("project", "new", "Launch the newsletter", "--goal", "Issue #1 sent to 50 readers");
    bb(
      "task",
      "add",
      "Draft issue #1",
      "-n",
      "Launch the newsletter",
      "--due",
      day(3),
      "-p",
      "high",
    );
    bb("task", "add", "Pick a sending platform", "-n", "Launch the newsletter");
    bb("project", "new", "Kitchen renovation", "--goal", "Cabinets installed before Thanksgiving");
    bb(
      "task",
      "add",
      "Get a second quote from the cabinet shop",
      "-n",
      "Kitchen renovation",
      "--due",
      day(1),
    );
    bb("capture", "Ask Sam about the conference talk slot");

    const mcpConfig = path.join(work, "mcp.json");
    fs.writeFileSync(
      mcpConfig,
      JSON.stringify({
        mcpServers: {
          "big-brain": { command: process.execPath, args: [server, "--vault", vault] },
        },
      }),
    );

    const personal = personalStrings();
    let session = null;
    for (const prompt of prompts) {
      const r = spawnSync(
        "claude",
        [
          "-p",
          prompt,
          "--output-format",
          "stream-json",
          "--verbose",
          "--mcp-config",
          mcpConfig,
          "--strict-mcp-config",
          // No built-in tools at all; big-brain's MCP tools are the only ones.
          "--tools",
          "",
          "--allowedTools",
          "mcp__big-brain__*",
          "--setting-sources",
          "project",
          ...(session ? ["--resume", session] : []),
        ],
        {
          cwd: work,
          encoding: "utf8",
          env: { ...env, ENABLE_TOOL_SEARCH: "false" },
          timeout: 300_000,
        },
      );
      if (r.status !== 0) throw new Error(`claude failed: ${r.stderr}`);
      const tools = [];
      let answer = "";
      for (const line of r.stdout.split("\n")) {
        if (!line.trim()) continue;
        const e = JSON.parse(line);
        if (e.type === "assistant") {
          for (const c of e.message.content) {
            if (c.type === "tool_use") tools.push({ name: c.name, input: c.input });
          }
        } else if (e.type === "result") {
          answer = (e.result ?? "").replaceAll(vault, "~/brain");
          session = e.session_id ?? session;
        }
      }
      const foreign = tools.filter((t) => !t.name.startsWith("mcp__big-brain__"));
      if (foreign.length > 0) {
        throw new Error(`demo used non-big-brain tools: ${foreign.map((t) => t.name).join(", ")}`);
      }
      const leaked = personal.filter((s) => JSON.stringify({ tools, answer }).includes(s));
      if (leaked.length > 0) throw new Error(`a turn mentions personal details (${leaked.length})`);
      // Models sometimes misname weekdays; a public demo shouldn't show that.
      const wrong = wrongWeekdays(answer);
      if (wrong.length > 0)
        throw new Error(`wrong weekday in answer (${wrong.join(", ")}); run again`);
      turns.push({ prompt, tools, answer });
      // Checkpoint each finished turn so a later failure doesn't lose it.
      fs.writeFileSync(`${out}.json`, `${JSON.stringify(turns, null, 2)}\n`);
    }
    return turns;
  } finally {
    // Claude Code keeps its own session history; this only removes the vault.
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// --- rendering ---------------------------------------------------------------

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";
const TABLE = "\u0001"; // marks pre-aligned table lines, which are not re-wrapped

/** Markdown tables become aligned columns, as Claude Code renders them. */
function alignTables(text, width) {
  const out = [];
  const lines = text.split("\n");
  const isRow = (l) => l.trim().startsWith("|");
  for (let i = 0; i < lines.length; i++) {
    if (!isRow(lines[i])) {
      out.push(lines[i]);
      continue;
    }
    const rows = [];
    for (; i < lines.length && isRow(lines[i]); i++) {
      const cells = lines[i]
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((c) => c.trim());
      if (!cells.every((c) => /^:?-+:?$/.test(c))) rows.push(cells);
    }
    i--;
    const cols = Math.max(...rows.map((r) => r.length));
    const widths = Array.from({ length: cols }, (_, c) =>
      Math.max(...rows.map((r) => (r[c] ?? "").replace(/\*\*/g, "").length)),
    );
    rows.forEach((r, n) => {
      const cells = widths.map((w, c) => {
        const cell = r[c] ?? "";
        return cell + " ".repeat(w - cell.replace(/\*\*/g, "").length);
      });
      let line = cells.join("   ").trimEnd();
      // Shorten an overflowing last column rather than letting the terminal wrap it.
      const over = line.replace(/\*\*/g, "").length - width;
      if (over > 0) line = `${line.slice(0, line.length - over - 3).trimEnd()}...`;
      out.push(TABLE + (n === 0 ? `**${line}**` : line));
    });
  }
  return out.join("\n");
}

/** Wrap prose to `width`, hard-splitting words longer than a line. */
function wrapLine(para, width) {
  const hang = para.match(/^(\s*(?:\d+\.|[-*])\s+)/)?.[1].length ?? 0;
  const visible = (s) => s.replace(/\*\*/g, "").length;
  const words = para.split(/\s+/).flatMap((w) => {
    const parts = [];
    for (let rest = w; rest.length > 0; rest = rest.slice(width - hang)) {
      parts.push(rest.slice(0, width - hang));
    }
    return parts;
  });
  const lines = [];
  let line = "";
  for (const word of words) {
    if (line && visible(line) + 1 + visible(word) > width) {
      lines.push(line);
      line = " ".repeat(hang) + word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  lines.push(line);
  return lines;
}

function wrap(text, width, indent) {
  const lines = [];
  for (const para of alignTables(text, width - indent).split("\n")) {
    if (para.startsWith(TABLE)) lines.push(para.slice(1));
    else if (para.trim() === "") lines.push("");
    else lines.push(...wrapLine(para, width - indent));
  }
  // Markdown bold becomes terminal bold; a span that wraps stays bold.
  let bold = false;
  return lines.map((l) => {
    let line = bold ? BOLD : "";
    l.split("**").forEach((part, n) => {
      if (n > 0) {
        bold = !bold;
        line += bold ? BOLD : RESET;
      }
      line += part;
    });
    return " ".repeat(indent) + line + (bold ? RESET : "");
  });
}

const summarize = (input) => {
  const s = JSON.stringify(input);
  return s === "{}" ? "" : s.length > 60 ? `${s.slice(0, 57)}...` : s;
};

function render(turns) {
  const events = [];
  let t = 0.5;
  const emit = (text) => events.push([Number(t.toFixed(3)), "o", text]);
  for (const { prompt, tools, answer } of turns) {
    emit(`${BOLD}>${RESET} `);
    for (const ch of prompt) {
      t += 0.04;
      emit(ch);
    }
    t += 0.5;
    emit("\r\n\r\n");
    for (const tool of tools) {
      t += 0.8;
      const name = tool.name.replace("mcp__big-brain__", "");
      emit(
        `${GREEN}●${RESET} ${CYAN}big-brain${RESET} ${DIM}·${RESET} ${name} ${DIM}${summarize(tool.input)}${RESET}\r\n`,
      );
    }
    t += 1.2;
    emit("\r\n");
    for (const line of wrap(answer, WIDTH - 2, 2)) {
      t += 0.06;
      emit(`${line}\r\n`);
    }
    t += 4;
    emit("\r\n");
  }
  emit("");
  const header = { version: 2, width: WIDTH, height: 34, env: { TERM: "xterm-256color" } };
  fs.writeFileSync(out, `${[header, ...events].map((e) => JSON.stringify(e)).join("\n")}\n`);
  return t;
}

const cached = process.env.DEMO_TRANSCRIPT;
const turns = cached ? JSON.parse(fs.readFileSync(cached, "utf8")) : record();
console.log(`wrote ${out} (${render(turns).toFixed(1)}s)`);
