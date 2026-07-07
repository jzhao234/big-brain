import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
