import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENTS } from "../src/core/agents.js";
import { readTree } from "../src/core/skill-marker.js";
import { loadSkillSource, renderSkill } from "../src/core/skill-render.js";
import { installSkills, skillsDir } from "../src/core/skills.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-skills-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("installSkills", () => {
  it("bundles the three brain skills, each with SKILL.md", () => {
    for (const name of ["brain", "capture", "weekly"]) {
      expect(fs.existsSync(path.join(skillsDir(), name, "SKILL.md"))).toBe(true);
    }
  });

  it("installs skills into a target dir and is path-agnostic (no hardcoded vault)", () => {
    const result = installSkills(dir);
    expect(result.installed).toEqual(["brain", "capture", "weekly"]);
    const brain = fs.readFileSync(path.join(dir, "brain", "SKILL.md"), "utf8");
    expect(brain).toContain("big-brain status");
    expect(brain).not.toContain("/root/brain"); // must be portable across machines
  });

  it("skips existing skills unless forced", () => {
    installSkills(dir);
    fs.writeFileSync(path.join(dir, "brain", "SKILL.md"), "edited");
    const skip = installSkills(dir);
    expect(skip.skipped).toContain("brain");
    expect(fs.readFileSync(path.join(dir, "brain", "SKILL.md"), "utf8")).toBe("edited");

    const forced = installSkills(dir, { force: true });
    expect(forced.installed).toContain("brain");
    expect(fs.readFileSync(path.join(dir, "brain", "SKILL.md"), "utf8")).not.toBe("edited");
  });
});

describe("bundled skill sources", () => {
  const root = path.resolve(skillsDir(), "..");

  it("ship each agent's copy exactly as skills/source renders it (npm run skills)", () => {
    const names = fs.readdirSync(path.join(root, "source")).sort();
    expect(names).toEqual(["brain", "capture", "weekly"]);
    for (const name of names) {
      const source = loadSkillSource(path.join(root, "source", name), AGENTS);
      for (const agent of source.agents) {
        const shipped = readTree(path.join(root, agent.name, name));
        const rendered = renderSkill(source, agent);
        expect([...shipped.keys()].sort(), `${agent.name}/${name}`).toEqual(
          [...rendered.keys()].sort(),
        );
        for (const [rel, file] of rendered) {
          expect(shipped.get(rel)?.bytes.toString("utf8"), `${agent.name}/${name}/${rel}`).toBe(
            file.bytes.toString("utf8"),
          );
          expect(shipped.get(rel)?.exec, `${agent.name}/${name}/${rel} mode`).toBe(file.exec);
        }
      }
    }
  });

  it("write the invocation each agent uses", () => {
    expect(fs.readFileSync(path.join(root, "codex", "brain", "SKILL.md"), "utf8")).toContain(
      "types $brain",
    );
    expect(fs.readFileSync(path.join(root, "agy", "brain", "SKILL.md"), "utf8")).not.toContain(
      "argument-hint",
    );
  });
});
