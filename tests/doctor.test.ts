import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDoctor } from "../src/core/doctor.js";
import { initVault } from "../src/core/scaffold.js";
import { Vault } from "../src/core/vault.js";

let dir: string;
let vault: Vault;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-doctor-test-"));
  initVault(dir, { name: "Doctor Test" });
  vault = new Vault(dir);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("runDoctor", () => {
  it("ignores unresolved attachment links but still reports broken note links", () => {
    vault.createNote({
      title: "Links",
      body: "![[diagram.png]]\n![[folder/photo.jpg|Photo]]\n[[missing-note]]\n[[Release 1.2]]\n[[Meeting w. Bob]]",
    });

    const broken = runDoctor(vault).filter((finding) => finding.rule === "broken-link");

    expect(broken.map((finding) => finding.message)).toEqual([
      "[[missing-note]] does not resolve to any note",
      "[[Release 1.2]] does not resolve to any note",
      "[[Meeting w. Bob]] does not resolve to any note",
    ]);
  });

  it("builds inbound links in one pass instead of calling backlinks per note", () => {
    vault.createNote({ title: "Target", body: "No outgoing links." });
    vault.createNote({ title: "Source", body: "See [[Target]]." });
    const backlinks = vi.spyOn(vault, "backlinks");

    const findings = runDoctor(vault);

    expect(backlinks).not.toHaveBeenCalled();
    expect(
      findings.some(
        (finding) => finding.rule === "orphan-note" && finding.path === "notes/Target.md",
      ),
    ).toBe(false);
  });

  it("reports frontmatter that doesn't parse", () => {
    fs.writeFileSync(
      path.join(dir, "notes", "Broken.md"),
      "---\nprivate: [unclosed\n---\n# Home\n",
    );
    vault.refresh();
    const found = runDoctor(vault).filter((f) => f.rule === "bad-frontmatter");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ path: "notes/Broken.md", severity: "warning" });
  });
});
