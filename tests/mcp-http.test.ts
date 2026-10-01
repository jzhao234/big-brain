import { once } from "node:events";
import fs from "node:fs";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { initVault } from "../src/core/scaffold.js";
import { Vault } from "../src/core/vault.js";
import { createRemoteMcpApp } from "../src/mcp/http-server.js";

let dir: string | undefined;
let httpServer: Server | undefined;
let client: Client | undefined;
const testToken = "test-secret-token-with-at-least-32-characters";

async function startServer(
  token = testToken,
  options: { allowedHosts?: string[]; allowedOrigins?: string[]; maxBodyBytes?: number } = {},
): Promise<URL> {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-mcp-http-"));
  initVault(dir, { name: "Remote Test" });
  const app = createRemoteMcpApp(new Vault(dir), { token, ...options });
  httpServer = app.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
  return new URL(`http://127.0.0.1:${address.port}/mcp`);
}

/** POST a raw body to the MCP endpoint (ping by default). */
function post(
  endpoint: URL,
  opts: { token?: string; origin?: string; body?: string } = {},
): Promise<globalThis.Response> {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.origin) headers.origin = opts.origin;
  return fetch(endpoint, {
    method: "POST",
    headers,
    body: opts.body ?? JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  });
}

afterEach(async () => {
  await client?.close();
  client = undefined;
  if (httpServer) {
    httpServer.close();
    await once(httpServer, "close");
    httpServer = undefined;
  }
  if (dir) {
    fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

describe("remote MCP server", () => {
  it("refuses to start without an access token", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "bb-mcp-http-config-"));
    try {
      initVault(temp, { name: "Remote Test" });
      expect(() => createRemoteMcpApp(new Vault(temp), { token: "" })).toThrow(
        "BIG_BRAIN_MCP_TOKEN",
      );
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("rejects MCP requests without the bearer token", async () => {
    const endpoint = await startServer();
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("rejects an incorrect bearer token", async () => {
    const endpoint = await startServer();
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: "Bearer definitely-not-the-right-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });

    expect(response.status).toBe(401);
  });

  it("enforces the configured Host header allowlist", async () => {
    const endpoint = await startServer(testToken, { allowedHosts: ["brain.example.com"] });
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${testToken}`,
        "content-type": "application/json",
        host: "attacker.example.com",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });

    expect(response.status).toBe(403);
  });

  it("rejects an unauthenticated oversized body with 401 before parsing it", async () => {
    const endpoint = await startServer(testToken, { maxBodyBytes: 1024 });
    const response = await post(endpoint, { body: "x".repeat(4096) });

    expect(response.status).toBe(401);
  });

  it("caps authenticated request bodies with a JSON-RPC 413", async () => {
    const endpoint = await startServer(testToken, { maxBodyBytes: 1024 });
    const response = await post(endpoint, {
      token: testToken,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "ping",
        params: { pad: "x".repeat(4096) },
      }),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: -32600 } });
  });

  it("answers malformed JSON with a JSON-RPC parse error", async () => {
    const endpoint = await startServer();
    const response = await post(endpoint, { token: testToken, body: "{not json" });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: -32700 } });
  });

  it("refuses browser origins that are not allowlisted, even with a valid token", async () => {
    const endpoint = await startServer();
    const response = await post(endpoint, { token: testToken, origin: "https://evil.example" });

    expect(response.status).toBe(403);
  });

  it("accepts an allowlisted origin", async () => {
    const endpoint = await startServer(testToken, { allowedOrigins: ["https://Claude.ai/"] });
    const response = await post(endpoint, { token: testToken, origin: "https://claude.ai" });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://claude.ai");
  });

  it("answers CORS preflight for allowlisted origins only, without a token", async () => {
    const endpoint = await startServer(testToken, { allowedOrigins: ["https://claude.ai"] });
    const preflight = (origin: string) =>
      fetch(endpoint, {
        method: "OPTIONS",
        headers: {
          origin,
          "access-control-request-method": "POST",
          "access-control-request-headers": "authorization, content-type",
        },
      });

    const allowed = await preflight("https://claude.ai");
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://claude.ai");
    expect(allowed.headers.get("access-control-allow-headers")).toContain("Authorization");
    expect((await preflight("https://evil.example")).status).toBe(403);
  });

  it("rejects a malformed allowed origin at startup", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "bb-mcp-http-config-"));
    try {
      initVault(temp, { name: "Remote Test" });
      expect(() =>
        createRemoteMcpApp(new Vault(temp), { token: testToken, allowedOrigins: ["claude.ai"] }),
      ).toThrow("Invalid allowed origin");
      // file: URLs serialize to the opaque origin "null"; never allowlist that.
      expect(() =>
        createRemoteMcpApp(new Vault(temp), {
          token: testToken,
          allowedOrigins: ["file:///tmp/x.html"],
        }),
      ).toThrow("Invalid allowed origin");
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("lets an authenticated MCP client discover and call Big Brain tools", async () => {
    const endpoint = await startServer();
    client = new Client({ name: "remote-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { authorization: `Bearer ${testToken}` } },
    });

    await client.connect(transport);
    const result = await client.listTools();

    expect(result.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["brain_overview", "search_notes", "append_note", "list_tasks"]),
    );
    const overview = await client.callTool({ name: "brain_overview", arguments: {} });
    expect(JSON.stringify(overview.content)).toContain("Remote Test");
  });
});
