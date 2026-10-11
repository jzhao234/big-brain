import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Vault } from "../src/core/vault.js";
import { buildServer } from "../src/mcp/server.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));

let dir: string;
let signalListeners: Map<NodeJS.Signals, NodeJS.SignalsListener[]>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-round2-"));
  signalListeners = new Map(
    (["SIGINT", "SIGTERM"] as const).map((signal) => [signal, process.listeners(signal)]),
  );
});

afterEach(() => {
  for (const [signal, previous] of signalListeners) {
    for (const listener of process.listeners(signal)) {
      if (!previous.includes(listener)) process.removeListener(signal, listener);
    }
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("HTTP startup", () => {
  it.each(["EADDRINUSE", "EACCES"])("reports %s as a failed startup", async (code) => {
    const { Command } = await import("commander");
    vi.spyOn(Command.prototype, "parse").mockImplementation(function (
      this: InstanceType<typeof Command>,
    ) {
      return this.setOptionValue("vault", dir);
    });
    vi.stubEnv("BIG_BRAIN_MCP_TOKEN", "a".repeat(32));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    let listener: http.Server;
    vi.spyOn(http.Server.prototype, "listen").mockImplementation(function (this: http.Server) {
      listener = this;
      return this;
    });
    await import("../src/mcp/http.js");

    // Express routes asynchronous listen errors to its listen callback.
    listener!.emit("error", Object.assign(new Error(`listen ${code}`), { code }));

    expect(exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledWith(`listen ${code}`);
    expect(error.mock.calls.flat().join("\n")).not.toContain("big-brain remote MCP:");
  });
});

describe("MCP launcher exit status", () => {
  async function launch(command: string) {
    const { Command } = await import("commander");
    const parse = vi.spyOn(Command.prototype, "parseAsync").mockImplementation(async function (
      this: InstanceType<typeof Command>,
    ) {
      return this;
    });
    const child = new EventEmitter();
    vi.mocked(spawn).mockReturnValue(child as ReturnType<typeof spawn>);
    await import("../src/cli/index.js");
    const program = parse.mock.instances[0] as unknown as InstanceType<typeof Command>;
    parse.mockRestore();
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    await program.parseAsync(["node", "big-brain", command]);
    return { child, exit };
  }

  it.each(["mcp", "mcp-http"])("%s reports signal termination as failure", async (command) => {
    const { child, exit } = await launch(command);
    child.emit("exit", null, "SIGTERM");
    expect(exit).toHaveBeenCalledWith(128 + os.constants.signals.SIGTERM);
  });

  it.each(["mcp", "mcp-http"])("%s preserves a normal child exit code", async (command) => {
    const { child, exit } = await launch(command);
    child.emit("exit", 7, null);
    expect(exit).toHaveBeenCalledWith(7);
  });
});

describe("inbox prompt", () => {
  it("directs the client to the configured inbox folder", async () => {
    fs.writeFileSync(
      path.join(dir, "brain.config.json"),
      JSON.stringify({ folders: { inbox: "work/captures" } }),
    );
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = buildServer(new Vault(dir));
    const client = new Client({ name: "test", version: "1.0.0" });
    await server.connect(serverSide);
    await client.connect(clientSide);
    try {
      const result = await client.getPrompt({ name: "process-inbox" });
      const content = result.messages[0]!.content;
      expect(content.type).toBe("text");
      expect(content.text).toContain('list_notes folder="work/captures"');
    } finally {
      await client.close();
      await server.close();
    }
  });
});
