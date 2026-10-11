import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/core/config.js";
import { getDailyNote } from "../src/core/daily.js";
import { vaultOverview } from "../src/core/overview.js";
import { listProjects } from "../src/core/projects.js";
import { initVault } from "../src/core/scaffold.js";
import { Vault } from "../src/core/vault.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-config-init-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeConfig(config: unknown): void {
  fs.writeFileSync(path.join(dir, "brain.config.json"), JSON.stringify(config));
}

describe("brain.config.json folders", () => {
  it("treats `daily/`, `./archive`, and `inbox/` like the bare folder names", () => {
    writeConfig({ folders: { daily: "daily/", archive: "./archive", inbox: "inbox/" } });
    const vault = new Vault(dir);
    expect(getDailyNote(vault, "2026-10-10").path).toBe("daily/2026-10-10.md");
    expect(getDailyNote(vault, "2026-10-10").path).toBe("daily/2026-10-10.md");

    vault.createNote({ title: "Old" });
    const archived = vault.archiveNote("Old");
    expect(archived.path).toBe("archive/notes/Old.md");
    expect(archived.archived).toBe(true);

    vault.createNote({ title: "Thought", type: "inbox", folder: "inbox" });
    expect(vaultOverview(vault).stats.inboxItems).toBe(1);
  });

  it("infers note types from nested configured folders", () => {
    writeConfig({ folders: { projects: "work/projects", people: "work/people" } });
    fs.mkdirSync(path.join(dir, "work", "projects"), { recursive: true });
    fs.mkdirSync(path.join(dir, "work", "people"), { recursive: true });
    fs.writeFileSync(path.join(dir, "work", "projects", "Launch.md"), "# Launch\n");
    fs.writeFileSync(path.join(dir, "work", "people", "Ada.md"), "# Ada\n");
    fs.writeFileSync(path.join(dir, "work", "Misc.md"), "# Misc\n");
    const vault = new Vault(dir);
    expect(vault.get("Launch")?.type).toBe("project");
    expect(vault.get("Ada")?.type).toBe("person");
    expect(vault.get("Misc")?.type).toBe("note");
    expect(listProjects(vault).map((p) => p.title)).toEqual(["Launch"]);
  });
});

describe("brain.config.json validation", () => {
  it("rejects string booleans instead of treating them as on", () => {
    writeConfig({ git: { autoCommit: "false", autoPush: "false" } });
    expect(() => loadConfig(dir)).toThrow(/git\.autoCommit must be true or false/);
    writeConfig({ embeddings: { enabled: "false" } });
    expect(() => loadConfig(dir)).toThrow(/embeddings\.enabled must be true or false/);
  });

  it("names the file and field for other bad shapes", () => {
    writeConfig(null);
    expect(() => loadConfig(dir)).toThrow(
      /brain\.config\.json: the top level must be a JSON object/,
    );
    writeConfig({ folders: { daily: 7 } });
    expect(() => loadConfig(dir)).toThrow(/folders\.daily must be a string/);
    writeConfig({ ignore: "private/**" });
    expect(() => loadConfig(dir)).toThrow(/ignore must be a list of glob strings/);
    fs.writeFileSync(path.join(dir, "brain.config.json"), "{ nope");
    expect(() => loadConfig(dir)).toThrow(/brain\.config\.json: /);
  });

  it("keeps valid configs and unknown keys", () => {
    writeConfig({ name: "Mine", git: { autoCommit: true }, custom: 1 });
    const config = loadConfig(dir) as unknown as Record<string, unknown>;
    expect(config.name).toBe("Mine");
    expect((config.git as { autoCommit: boolean; autoPush: boolean }).autoPush).toBe(false);
    expect(config.custom).toBe(1);
  });
});

describe("init", () => {
  it("writes a loadable config for names with quotes and backslashes", () => {
    initVault(dir, { name: 'My "Brain" \\ 2' });
    expect(new Vault(dir).config.name).toBe('My "Brain" \\ 2');
    expect(fs.readFileSync(path.join(dir, "BRAIN.md"), "utf8")).toContain('My "Brain" \\ 2');
  });

  it("refuses to scaffold through a symlinked folder that leaves the vault", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "bb-outside-"));
    try {
      fs.writeFileSync(path.join(outside, "How this vault works.md"), "foreign content\n");
      fs.symlinkSync(outside, path.join(dir, "notes"));
      expect(() => initVault(dir, { force: true })).toThrow(/outside the vault/);
      expect(fs.readFileSync(path.join(outside, "How this vault works.md"), "utf8")).toBe(
        "foreign content\n",
      );
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses to write through a dangling symlink", () => {
    const target = path.join(os.tmpdir(), `bb-dangling-${path.basename(dir)}.md`);
    fs.symlinkSync(target, path.join(dir, "BRAIN.md"));
    expect(() => initVault(dir, { force: true })).toThrow(/broken symlink/);
    expect(fs.existsSync(target)).toBe(false);
  });
});
