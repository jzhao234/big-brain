import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderOverview, vaultOverview } from "../src/core/overview.js";
import { initVault } from "../src/core/scaffold.js";
import { Vault } from "../src/core/vault.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-overview-test-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("renderOverview", () => {
  it("uses the singular for a count of one", () => {
    fs.writeFileSync(path.join(dir, "brain.config.json"), "{}\n");
    fs.writeFileSync(path.join(dir, "Only.md"), "#solo\n\n- [ ] one task\n");
    const text = renderOverview(vaultOverview(new Vault(dir)));
    expect(text).toContain("1 note · 0 projects · 1 open task · 1 tag · 0 inbox items");
  });

  it("keeps the plural for the starter vault", () => {
    initVault(dir, { name: "Plural" });
    const text = renderOverview(vaultOverview(new Vault(dir)));
    expect(text).toMatch(/\d+ notes · 1 project · \d+ open tasks · \d+ tags? · 0 inbox items/);
  });
});
