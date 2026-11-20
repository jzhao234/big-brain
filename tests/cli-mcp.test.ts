import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProject } from "../src/core/projects.js";
import { initVault } from "../src/core/scaffold.js";
import { addTask } from "../src/core/tasks.js";
import { Vault } from "../src/core/vault.js";
import { buildServer } from "../src/mcp/server.js";

let dir: string;
let vault: Vault;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-cli-mcp-"));
  initVault(dir, { name: "CLI and MCP" });
  vault = new Vault(dir);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("MCP lookups", () => {
  async function connect() {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await buildServer(vault).connect(serverSide);
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientSide);
    return client;
  }

  it("flags a missing note as a tool error", async () => {
    const client = await connect();
    for (const name of ["read_note", "note_links"]) {
      const result = await client.callTool({ name, arguments: { ref: "missing" } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("Note not found: missing");
    }
    const found = await client.callTool({ name: "read_note", arguments: { ref: "BRAIN" } });
    expect(found.isError).toBeFalsy();
    await client.close();
  });

  it("shows unparsed frontmatter and the error instead of hiding them", async () => {
    fs.writeFileSync(
      path.join(dir, "notes", "Broken.md"),
      "---\nprivate: [unclosed\n---\n# Home\n",
    );
    vault.refresh();
    const client = await connect();
    const result = await client.callTool({
      name: "read_note",
      arguments: { ref: "notes/Broken.md" },
    });
    const text = JSON.stringify(result.content);
    expect(text).toContain("frontmatter error");
    expect(text).toContain("private: [unclosed");
    const health = await client.callTool({ name: "vault_health", arguments: {} });
    expect(JSON.stringify(health.content)).toContain("bad-frontmatter");
    await client.close();
  });
});

describe("edit_note", () => {
  it("edits through MCP and reports a failed match as a tool error", async () => {
    fs.writeFileSync(path.join(dir, "notes", "E.md"), "# E\n\nStatus: draft\n");
    vault.refresh();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await buildServer(vault).connect(serverSide);
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientSide);
    const ok = await client.callTool({
      name: "edit_note",
      arguments: { ref: "E", old_text: "Status: draft", new_text: "Status: sent" },
    });
    expect(JSON.stringify(ok.content)).toContain("Edited notes/E.md (1 replacement)");
    const miss = await client.callTool({
      name: "edit_note",
      arguments: { ref: "E", old_text: "Status: draft", new_text: "x" },
    });
    expect(miss.isError).toBe(true);
    expect(fs.readFileSync(path.join(dir, "notes", "E.md"), "utf8")).toBe("# E\n\nStatus: sent\n");
    await client.close();
  });

  it("edits through the CLI", async () => {
    fs.writeFileSync(path.join(dir, "notes", "E.md"), "# E\n\na b a\n");
    vi.resetModules();
    const { Command } = await import("commander");
    const parse = vi.spyOn(Command.prototype, "parseAsync").mockImplementation(async function (
      this: InstanceType<typeof Command>,
    ) {
      return this;
    });
    await import("../src/cli/index.js");
    const program = parse.mock.instances[0] as unknown as InstanceType<typeof Command>;
    parse.mockRestore();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await program.parseAsync([
      "node",
      "big-brain",
      "--vault",
      dir,
      "edit",
      "E",
      "--old",
      "a",
      "--new",
      "c",
      "--all",
    ]);
    expect(log.mock.calls.flat().join("\n")).toContain("Edited notes/E.md (2 replacements)");
    expect(fs.readFileSync(path.join(dir, "notes", "E.md"), "utf8")).toBe("# E\n\nc b c\n");
  });
});

describe("CLI tasks", () => {
  async function run(args: string[]) {
    vi.resetModules();
    const { Command } = await import("commander");
    // Capture the program instead of letting the module parse vitest's argv.
    const parse = vi.spyOn(Command.prototype, "parseAsync").mockImplementation(async function (
      this: InstanceType<typeof Command>,
    ) {
      return this;
    });
    await import("../src/cli/index.js");
    const program = parse.mock.instances[0] as unknown as InstanceType<typeof Command>;
    parse.mockRestore();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("CLI exited");
    });
    await program.parseAsync(["node", "big-brain", "--vault", dir, "tasks", ...args]);
    return { log: log.mock.calls.flat().join("\n"), error: error.mock.calls.flat().join("\n") };
  }

  it("filters by --tag", async () => {
    createProject(vault, { title: "Tagged" });
    addTask(vault, { text: "deploy #work", note: "Tagged" });
    addTask(vault, { text: "groceries #home", note: "Tagged" });
    const { log } = await run(["--tag", "work", "--json"]);
    expect(JSON.parse(log).map((t: { text: string }) => t.text)).toEqual(["deploy #work"]);
  });

  it("rejects a malformed --due-by instead of comparing it as text", async () => {
    await expect(run(["--due-by", "2026-1-5"])).rejects.toThrow("CLI exited");
  });
});

describe("MCP create_note", () => {
  it("accepts a custom type and an explicit folder", async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await buildServer(vault).connect(serverSide);
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientSide);

    const result = await client.callTool({
      name: "create_note",
      arguments: { title: "Infra wins", type: "brag", folder: "brag", body: "[[BRAIN]]" },
    });

    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toContain("Created brag/Infra wins.md");
    vault.refresh();
    expect(vault.get("Infra wins")?.type).toBe("brag");
    await client.close();
  });
});
