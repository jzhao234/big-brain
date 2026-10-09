import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseFrontmatterAssignments, parseFrontmatterValue } from "../src/core/frontmatter.js";
import { initVault } from "../src/core/scaffold.js";
import { Vault } from "../src/core/vault.js";

describe("parseFrontmatterValue", () => {
  it("reads scalars the way the vault reads frontmatter", () => {
    expect(parseFrontmatterValue("dropped")).toBe("dropped");
    expect(parseFrontmatterValue("5")).toBe(5);
    expect(parseFrontmatterValue("true")).toBe(true);
    expect(parseFrontmatterValue("yes")).toBe("yes");
    expect(parseFrontmatterValue('"123"')).toBe("123");
  });

  it("keeps dates as the strings the user typed", () => {
    expect(parseFrontmatterValue("2026-11-01")).toBe("2026-11-01");
  });

  it("reads flow lists and maps", () => {
    expect(parseFrontmatterValue("[work, llm]")).toEqual(["work", "llm"]);
    expect(parseFrontmatterValue("{owner: me, n: 2}")).toEqual({ owner: "me", n: 2 });
  });

  it("treats YAML's null spellings and nothing as null (which deletes the key)", () => {
    expect(parseFrontmatterValue("null")).toBeNull();
    expect(parseFrontmatterValue("Null")).toBeNull();
    expect(parseFrontmatterValue("NULL")).toBeNull();
    expect(parseFrontmatterValue("~")).toBeNull();
    expect(parseFrontmatterValue("")).toBeNull();
  });

  it("keeps other casings of null as text, as YAML does", () => {
    expect(parseFrontmatterValue("nUlL")).toBe("nUlL");
  });

  it("keeps text that YAML would silently reinterpret", () => {
    expect(parseFrontmatterValue("Note: see X")).toBe("Note: see X");
    expect(parseFrontmatterValue("- a")).toBe("- a");
    expect(parseFrontmatterValue("#work")).toBe("#work");
    expect(parseFrontmatterValue("[unclosed")).toBe("[unclosed");
    expect(parseFrontmatterValue("a: b: c")).toBe("a: b: c");
  });
});

describe("parseFrontmatterAssignments", () => {
  it("splits at the first = so values may contain =", () => {
    expect(
      parseFrontmatterAssignments(["status=paused", "url=https://x.test/?a=b", "due="]),
    ).toEqual({ status: "paused", url: "https://x.test/?a=b", due: null });
  });

  it("rejects arguments without a key", () => {
    expect(() => parseFrontmatterAssignments(["status"])).toThrow(/want key=value/);
    expect(() => parseFrontmatterAssignments(["=paused"])).toThrow(/want key=value/);
  });

  it("stores __proto__ as a key instead of replacing the prototype", () => {
    expect(Object.entries(parseFrontmatterAssignments(["__proto__=null"]))).toEqual([
      ["__proto__", null],
    ]);
  });
});

describe("frontmatter assignments applied to a note", () => {
  let dir: string;
  let vault: Vault;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-fm-args-"));
    initVault(dir, { name: "Test Brain" });
    vault = new Vault(dir);
    vault.createNote({ title: "Doc", type: "project", body: "Body." });
    vault.updateFrontmatter("Doc", { area: "work", status: "active" });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("sets, types, and removes keys, and survives a re-read", () => {
    vault.updateFrontmatter(
      "Doc",
      parseFrontmatterAssignments([
        "status=dropped",
        "tags=[work, llm]",
        "due=2026-11-01",
        "owner=nUlL",
        "area=null",
      ]),
    );
    const fm = new Vault(dir).get("Doc")?.frontmatter ?? {};
    expect(fm.status).toBe("dropped");
    expect(fm.tags).toEqual(["work", "llm"]);
    expect(fm.due).toBe("2026-11-01");
    expect(fm.owner).toBe("nUlL");
    expect(fm).not.toHaveProperty("area");
  });
});
