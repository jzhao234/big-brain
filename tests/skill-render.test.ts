import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENTS, agentPaths, getAgent, installAgent, saveToProfile } from "../src/core/agents.js";
import { parseFrontmatter } from "../src/core/frontmatter.js";
import { generatedUnedited, readMarker, readTree } from "../src/core/skill-marker.js";
import {
  applyRender,
  loadSkillSource,
  planRender,
  renderSkill,
  selectLines,
} from "../src/core/skill-render.js";

let root: string;
let vaultDir: string;
let userHome: string;

const sys = () => ({ userHome, env: { XDG_STATE_HOME: path.join(root, "state") } });

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** A source skill in the vault's agents/skills. */
function source(name: string, text: string, extra: Record<string, string> = {}): string {
  const dir = path.join(vaultDir, "agents", "skills", name);
  write(path.join(dir, "SKILL.md"), text);
  for (const [rel, body] of Object.entries(extra)) write(path.join(dir, rel), body);
  return dir;
}

function out(agent: string, name: string, rel = "SKILL.md"): string {
  return path.join(vaultDir, "agents", agent, "skills", name, rel);
}

function read(agent: string, name: string, rel = "SKILL.md"): string {
  return fs.readFileSync(out(agent, name, rel), "utf8");
}

function render(opts = {}) {
  return applyRender(vaultDir, "agents", planRender(vaultDir, "agents", opts), sys());
}

const TEST_SKILL = `---
name: test
description: >
  Add tests. Use when the user types {{/test}} or asks for tests.
claude:
  argument-hint: "[file]"
codex:
  openai:
    interface:
      display_name: "Test"
      short_description: "Write behavior-focused tests for a change"
      default_prompt: "Use {{/test}} to cover this change."
---

# test

{{agent}} runs this as {{/test}}; its id is {{agent.name}}.

<!-- only: codex -->
Codex-only line.
<!-- /only -->

Shared tail.
`;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bb-render-")));
  vaultDir = path.join(root, "vault");
  userHome = path.join(root, "home");
  fs.mkdirSync(userHome);
  for (const a of ["claude", "codex", "agy"]) {
    fs.mkdirSync(path.join(vaultDir, "agents", a), { recursive: true });
  }
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("renderSkill", () => {
  it("writes each agent's frontmatter, invocation and prose", () => {
    source("test", TEST_SKILL);
    render();

    const claude = parseFrontmatter(read("claude", "test"));
    expect(claude.data).toEqual({
      name: "test",
      description: "Add tests. Use when the user types /test or asks for tests.\n",
      "argument-hint": "[file]",
    });
    expect(claude.content).toContain("Claude runs this as /test; its id is claude.");
    expect(claude.content).not.toContain("Codex-only");
    expect(claude.content).toContain("\n\nShared tail.");
    expect(claude.content).not.toContain("\n\n\n");

    const agy = parseFrontmatter(read("agy", "test"));
    expect(Object.keys(agy.data)).toEqual(["name", "description"]);
    expect(agy.content).toContain("agy runs this as /test; its id is agy.");

    const codex = parseFrontmatter(read("codex", "test"));
    expect(codex.data.description).toContain("types $test");
    expect(codex.content).toContain("Codex runs this as $test");
    expect(codex.content).toContain("\nCodex-only line.\n\nShared tail.");
    expect(read("codex", "test", "agents/openai.yaml")).toBe(
      [
        "interface:",
        '  display_name: "Test"',
        '  short_description: "Write behavior-focused tests for a change"',
        '  default_prompt: "Use $test to cover this change."',
        "",
      ].join("\n"),
    );
    expect(fs.existsSync(out("claude", "test", "agents/openai.yaml"))).toBe(false);
  });

  it("maps invocation: explicit to each agent's own mechanism", () => {
    source(
      "duty",
      "---\nname: duty\ndescription: Run the patrol.\ninvocation: explicit\n---\n\nBody\n",
    );
    render();
    expect(parseFrontmatter(read("claude", "duty")).data["disable-model-invocation"]).toBe(true);
    expect(yaml.load(read("codex", "duty", "agents/openai.yaml"))).toEqual({
      policy: { allow_implicit_invocation: false },
    });
    const agy = parseFrontmatter(read("agy", "duty")).data;
    expect(Object.keys(agy)).toEqual(["name", "description"]);
    expect(agy.description).toBe(
      "Run the patrol. Use it only when the user types /duty; never start it on your own.",
    );
  });

  it("lets an agent override the shared description", () => {
    source(
      "x",
      "---\nname: x\ndescription: Shared.\ncodex:\n  description: For Codex, {{/x}}.\n---\n",
    );
    render();
    expect(parseFrontmatter(read("codex", "x")).data.description).toBe("For Codex, $x.");
    expect(parseFrontmatter(read("claude", "x")).data.description).toBe("Shared.");
  });

  it("renders for the listed agents only", () => {
    source("jun", "---\nname: jun\ndescription: Patrol.\nagents: [claude]\n---\n");
    render();
    expect(fs.existsSync(out("claude", "jun"))).toBe(true);
    expect(fs.existsSync(out("codex", "jun"))).toBe(false);
    expect(fs.existsSync(out("agy", "jun"))).toBe(false);
  });

  it("templates every Markdown file and copies other files byte for byte", () => {
    const bin = Buffer.from([0, 255, 123, 123, 47, 120, 125, 125]);
    const dir = source("x", "---\nname: x\ndescription: X.\n---\n", {
      "references/notes.md": "See {{/x}}.\n<!-- only: agy -->\nagy only\n<!-- /only -->\n",
      "scripts/run.sh": "echo '{{/x}}'\n",
    });
    fs.writeFileSync(path.join(dir, "data.bin"), bin);
    render();
    expect(read("codex", "x", "references/notes.md")).toBe("See $x.\n");
    expect(read("agy", "x", "references/notes.md")).toBe("See /x.\nagy only\n");
    expect(read("codex", "x", "scripts/run.sh")).toBe("echo '{{/x}}'\n");
    expect(fs.readFileSync(out("claude", "x", "data.bin")).equals(bin)).toBe(true);
  });

  it("leaves unknown braces alone", () => {
    // GitHub Actions syntax, spelled out so it is not read as a template literal.
    const line = `run: $${"{{ secrets.TOKEN }}"} and {{agnet}}`;
    source("x", `---\nname: x\ndescription: X.\n---\n\n${line}\n`);
    render();
    expect(read("claude", "x")).toContain(line);
  });

  it("refuses sources it cannot render faithfully", () => {
    const cases: [string, RegExp][] = [
      ["---\nname: y\ndescription: X.\n---\n", /name is y/],
      ["---\nname: x\n---\n", /description is missing/],
      ["---\nname: x\ndescription: X.\nagents: [claude, gemini]\n---\n", /unknown agent/],
      ["---\nname: x\ndescription: X.\nagents: [claude]\ncodex:\n  a: 1\n---\n", /not in agents/],
      ["---\nname: x\ndescription: X.\nlicense: MIT\n---\n", /Antigravity reads only/],
      ["---\nname: x\ndescription: X.\nagy:\n  argument-hint: a\n---\n", /Antigravity reads only/],
      ["---\nname: x\ndescription: X.\nclaude:\n  openai: {}\n---\n", /only Codex/],
      ["---\nname: x\ndescription: X.\ninvocation: sometimes\n---\n", /auto or explicit/],
      [
        "---\nname: x\ndescription: X.\ncodex:\n  openai:\n    interface:\n      short_description: Short\n---\n",
        /25 to 64/,
      ],
      [
        "---\nname: x\ndescription: X.\ncodex:\n  openai:\n    interface:\n      default_prompt: Do it\n---\n",
        /must mention \$x/,
      ],
      [
        "---\nname: x\ndescription: X.\ninvocation: explicit\nclaude:\n  disable-model-invocation: false\n---\n",
        /explicit/,
      ],
      ["---\nname: x\ndescription: X.\n---\n<!-- only: codex -->\nopen\n", /never closed/],
      ["---\nname: x\ndescription: X.\n---\n<!-- /only -->\n", /without an opening/],
      [
        "---\nname: x\ndescription: X.\n---\n<!-- only: bard -->\n<!-- /only -->\n",
        /unknown agent/,
      ],
      [
        "---\nname: x\ndescription: X.\n---\n<!-- only: agy -->\n<!-- only: codex -->\n<!-- /only -->\n",
        /inside another/,
      ],
    ];
    for (const [text, error] of cases) {
      fs.rmSync(path.join(vaultDir, "agents", "skills"), { recursive: true, force: true });
      source("x", text);
      expect(() => planRender(vaultDir, "agents"), text).toThrow(error);
    }
  });

  it("refuses an openai.yaml file in the source", () => {
    source("x", "---\nname: x\ndescription: X.\n---\n", { "agents/openai.yaml": "a: 1\n" });
    expect(() => planRender(vaultDir, "agents")).toThrow(/codex: openai:/);
  });

  it("treats only markers inside fenced code as text", () => {
    const text = [
      "```md",
      "<!-- only: codex -->",
      "<!-- /only -->",
      "```",
      "<!-- only: codex -->",
      "~~~",
      "```",
      "~~~",
      "<!-- /only -->",
      "end",
    ].join("\n");
    expect(selectLines(text, getAgent("claude"), AGENTS, "t")).toBe(
      ["```md", "<!-- only: codex -->", "<!-- /only -->", "```", "end"].join("\n"),
    );
    expect(selectLines(text, getAgent("codex"), AGENTS, "t")).toBe(
      ["```md", "<!-- only: codex -->", "<!-- /only -->", "```", "~~~", "```", "~~~", "end"].join(
        "\n",
      ),
    );
  });

  it("renders the same bytes every time", () => {
    const dir = source("test", TEST_SKILL);
    const s = loadSkillSource(dir, AGENTS);
    const a = renderSkill(s, getAgent("codex"), { marker: "agents/skills/test/SKILL.md" });
    const b = renderSkill(s, getAgent("codex"), { marker: "agents/skills/test/SKILL.md" });
    expect([...a.keys()]).toEqual([...b.keys()]);
    for (const [rel, bytes] of a) expect(bytes.equals(b.get(rel) as Buffer)).toBe(true);
  });
});

describe("planRender and applyRender", () => {
  it("marks each copy with its source and a hash of what it wrote", () => {
    source("test", TEST_SKILL);
    render();
    const text = read("claude", "test");
    const end = text.indexOf("\n---\n") + 5;
    expect(text.slice(end).split("\n")[0]).toMatch(
      /^<!-- Generated by big-brain from agents\/skills\/test\/SKILL\.md: edit that file, then run `big-brain agents render`\. render:[0-9a-f]{12} -->$/,
    );
    expect(readMarker(path.dirname(out("claude", "test")))?.source).toBe(
      "agents/skills/test/SKILL.md",
    );
    expect(generatedUnedited(readTree(path.dirname(out("codex", "test"))))).toBe(true);
    expect(planRender(vaultDir, "agents").items.map((i) => i.state)).toEqual([
      "current",
      "current",
      "current",
    ]);
  });

  it("updates a copy left as rendered when its source changes", () => {
    source("test", TEST_SKILL);
    render();
    source("test", TEST_SKILL.replace("Shared tail.", "New tail."));
    const plan = planRender(vaultDir, "agents");
    expect(plan.items.map((i) => [i.agent, i.state, i.action])).toEqual([
      ["claude", "stale", "update"],
      ["codex", "stale", "update"],
      ["agy", "stale", "update"],
    ]);
    applyRender(vaultDir, "agents", plan, sys());
    expect(read("agy", "test")).toContain("New tail.");
    expect(planRender(vaultDir, "agents").items.every((i) => i.state === "current")).toBe(true);
  });

  it("never overwrites a copy edited by hand without --replace, and backs it up", () => {
    source("test", TEST_SKILL);
    render();
    fs.appendFileSync(out("claude", "test"), "A lesson learned.\n");
    source("test", TEST_SKILL.replace("Shared tail.", "New tail."));
    const plan = planRender(vaultDir, "agents");
    expect(plan.items.find((i) => i.agent === "claude")).toMatchObject({
      state: "edited",
      action: "conflict",
    });
    applyRender(vaultDir, "agents", plan, sys());
    expect(read("claude", "test")).toContain("A lesson learned.");
    expect(read("codex", "test")).toContain("New tail.");

    const result = render({ replace: true });
    expect(read("claude", "test")).not.toContain("A lesson learned.");
    const saved = path.join(result.backupDir as string, "claude", "test", "SKILL.md");
    expect(fs.readFileSync(saved, "utf8")).toContain("A lesson learned.");
  });

  it("counts an added file as a hand edit", () => {
    source("test", TEST_SKILL);
    render();
    write(out("codex", "test", "notes.md"), "extra\n");
    expect(planRender(vaultDir, "agents").items.find((i) => i.agent === "codex")?.state).toBe(
      "edited",
    );
  });

  it("refuses a hand-written folder in the way unless --replace", () => {
    write(out("agy", "test"), "---\nname: test\ndescription: Old.\n---\nmine\n");
    source("test", TEST_SKILL);
    const plan = planRender(vaultDir, "agents");
    expect(plan.items.find((i) => i.agent === "agy")).toMatchObject({
      state: "hand-written",
      action: "conflict",
    });
    applyRender(vaultDir, "agents", plan, sys());
    expect(read("agy", "test")).toContain("mine");
    const result = render({ replace: true });
    expect(read("agy", "test")).toContain("agy runs this");
    expect(fs.existsSync(path.join(result.backupDir as string, "agy", "test", "SKILL.md"))).toBe(
      true,
    );
  });

  it("leaves hand-written skills without a source alone", () => {
    write(out("claude", "duty"), "---\nname: duty\ndescription: Mine.\n---\n");
    source("test", TEST_SKILL);
    const plan = planRender(vaultDir, "agents", { prune: true, replace: true });
    expect(plan.items.some((i) => i.skill === "duty")).toBe(false);
  });

  it("removes orphans only with --prune, and edited ones only with --replace too", () => {
    const plain = "---\nname: test\ndescription: T.\n---\n\nBody\n";
    source("test", plain);
    render();
    source("test", plain.replace("---\n\nBody", "agents: [claude, agy]\n---\n\nBody"));
    let plan = planRender(vaultDir, "agents");
    expect(plan.items.find((i) => i.agent === "codex")).toMatchObject({
      state: "orphan",
      action: "keep",
    });
    fs.appendFileSync(out("codex", "test"), "edit\n");
    plan = planRender(vaultDir, "agents", { prune: true });
    expect(plan.items.find((i) => i.agent === "codex")).toMatchObject({
      state: "orphan-edited",
      action: "conflict",
    });
    applyRender(vaultDir, "agents", plan, sys());
    expect(fs.existsSync(out("codex", "test"))).toBe(true);

    const result = render({ prune: true, replace: true });
    expect(fs.existsSync(out("codex", "test"))).toBe(false);
    expect(fs.existsSync(path.join(result.backupDir as string, "codex", "test", "SKILL.md"))).toBe(
      true,
    );

    fs.rmSync(path.join(vaultDir, "agents", "skills", "test"), { recursive: true });
    render({ prune: true });
    expect(fs.existsSync(out("claude", "test"))).toBe(false);
  });

  it("keeps the folder agents link to, so installed links stay valid", () => {
    source("test", TEST_SKILL);
    render();
    const p = agentPaths(vaultDir, "agents", getAgent("claude"), sys());
    installAgent(p);
    const link = path.join(p.home, "skills", "test");
    expect(fs.readlinkSync(link)).toBe(path.dirname(out("claude", "test")));
    source("test", TEST_SKILL.replace("Shared tail.", "New tail."));
    render();
    expect(fs.readFileSync(path.join(link, "SKILL.md"), "utf8")).toContain("New tail.");
  });

  it("leaves no temporary folders behind", () => {
    source("test", TEST_SKILL);
    render();
    source("test", TEST_SKILL.replace("Shared tail.", "New tail."));
    render();
    expect(fs.readdirSync(path.join(vaultDir, "agents")).sort()).toEqual([
      "agy",
      "claude",
      "codex",
      "skills",
    ]);
  });
});

describe("agents save", () => {
  it("refuses to save over a skill the vault renders", () => {
    source("test", TEST_SKILL);
    render();
    const p = agentPaths(vaultDir, "agents", getAgent("claude"), sys());
    write(path.join(p.home, "skills", "test", "SKILL.md"), "---\nname: test\n---\nlocal\n");
    expect(() => saveToProfile(p, vaultDir, ["skills/test"], [], { force: true })).toThrow(
      /renders this skill from agents\/skills\/test/,
    );
  });
});
