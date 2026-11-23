#!/usr/bin/env node
// Render big-brain's bundled skills: skills/source/<name> -> skills/<agent>/<name>.
// Run with `npm run skills` (it builds first); tests/skills.test.ts fails when
// the committed copies differ from what this writes. Everything is rendered
// before anything is written, so a broken source changes nothing.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENTS } from "../dist/core/agents.js";
import { loadSkillSource, renderSkill } from "../dist/core/skill-render.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "skills");
const sources = path.join(root, "source");
const copies = [];
for (const name of fs.readdirSync(sources).sort()) {
  const source = loadSkillSource(path.join(sources, name), AGENTS);
  for (const agent of source.agents) {
    copies.push({ out: path.join(root, agent.name, name), files: renderSkill(source, agent) });
  }
}
for (const { out, files } of copies) {
  fs.rmSync(out, { recursive: true, force: true });
  for (const [rel, { bytes, exec }] of files) {
    const file = path.join(out, ...rel.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    fs.chmodSync(file, exec ? 0o755 : 0o644);
  }
  console.log(path.relative(path.dirname(root), out));
}
