import fs from "node:fs";

const manifest = JSON.parse(
  fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { name: string; version: string };

/** The package version, read from package.json so the CLI, MCP server, and npm agree. */
export const VERSION: string = manifest.version;

/** The npm package name (scoped), for install and npx commands. */
export const PACKAGE_NAME: string = manifest.name;
