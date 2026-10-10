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
