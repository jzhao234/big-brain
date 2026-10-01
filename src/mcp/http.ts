#!/usr/bin/env node
import { Command } from "commander";
import { resolveVault } from "../core/config.js";
import { Vault } from "../core/vault.js";
import { createRemoteMcpApp } from "./http-server.js";

interface HttpCliOptions {
  vault?: string;
  host: string;
  port: string;
  allowedHosts?: string;
  allowedOrigins?: string;
}

const program = new Command()
  .name("big-brain-mcp-http")
  .description("Run Big Brain as an authenticated Streamable HTTP MCP server")
  .option("--vault <dir>", "vault directory (default: BIG_BRAIN_VAULT or nearest config)")
  .option("--host <host>", "listen address", process.env.BIG_BRAIN_MCP_HOST ?? "127.0.0.1")
  .option("--port <port>", "listen port", process.env.BIG_BRAIN_MCP_PORT ?? "3333")
  .option(
    "--allowed-hosts <hosts>",
    "comma-separated Host header allowlist",
    process.env.BIG_BRAIN_MCP_ALLOWED_HOSTS,
  )
  .option(
    "--allowed-origins <origins>",
    "comma-separated browser Origin allowlist (requests without Origin are always allowed)",
    process.env.BIG_BRAIN_MCP_ALLOWED_ORIGINS,
  )
  .parse();

const options = program.opts<HttpCliOptions>();
const port = Number(options.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`Invalid --port: ${options.port}`);
  process.exit(1);
}

const token = process.env.BIG_BRAIN_MCP_TOKEN ?? "";
const splitList = (value?: string) =>
  value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
const allowedHosts = splitList(options.allowedHosts);
const allowedOrigins = splitList(options.allowedOrigins);

try {
  const dir = resolveVault(options.vault);
  const vault = new Vault(dir);
  const app = createRemoteMcpApp(vault, {
    token,
    host: options.host,
    allowedHosts,
    allowedOrigins,
  });
  const listener = app.listen(port, options.host, () => {
    console.error(`big-brain remote MCP: http://${options.host}:${port}/mcp`);
    console.error(`vault at ${dir} (${vault.notes().length} notes)`);
  });

  const shutdown = () => listener.close(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
