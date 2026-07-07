#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveVault } from "../core/config.js";
import { Vault } from "../core/vault.js";
import { buildServer } from "./server.js";

function parseArgs(argv: string[]): { vault?: string } {
  const out: { vault?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--vault" || a === "-v") out.vault = argv[++i];
    else if (a?.startsWith("--vault=")) out.vault = a.slice("--vault=".length);
    else if (a === "--help" || a === "-h") {
      console.error("Usage: big-brain-mcp [--vault <dir>]  (or set BIG_BRAIN_VAULT)");
      process.exit(0);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const { vault: vaultArg } = parseArgs(process.argv.slice(2));
  const dir = resolveVault(vaultArg);
  const vault = new Vault(dir);
  const server = buildServer(vault);
  // stdout is the MCP transport; all human output must go to stderr.
  console.error(`big-brain MCP server: vault at ${dir} (${vault.notes().length} notes)`);
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
