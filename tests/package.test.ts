import fs from "node:fs";
import { describe, expect, it } from "vitest";
import * as core from "../src/core/index.js";

interface PackageManifest {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

const manifest = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as PackageManifest;

describe("package manifest", () => {
  it("exports the push drain alongside autoCommit", async () => {
    expect(core).toHaveProperty("settlePushes", expect.any(Function));
    const { settlePushes } = core as typeof core & {
      settlePushes: (maxMs?: number) => Promise<boolean>;
    };
    await expect(settlePushes(100)).resolves.toBe(true);
  });

  it("keeps local embeddings out of the default install", () => {
    expect(manifest.dependencies?.["@huggingface/transformers"]).toBeUndefined();
    expect(manifest.optionalDependencies?.["@huggingface/transformers"]).toBeUndefined();
    expect(manifest.peerDependencies?.["@huggingface/transformers"]).toBeUndefined();
    expect(manifest.peerDependenciesMeta?.["@huggingface/transformers"]).toBeUndefined();
  });
});

describe("release metadata", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    name: string;
    version: string;
    mcpName: string;
  };
  const server = JSON.parse(
    fs.readFileSync(new URL("../server.json", import.meta.url), "utf8"),
  ) as {
    name: string;
    description: string;
    version: string;
    packages: Array<{ identifier: string; version: string }>;
  };

  it("reports the package version from the CLI and MCP server", () => {
    expect(core.VERSION).toBe(pkg.version);
  });

  it("keeps server.json in step with package.json", () => {
    expect(server.name).toBe(pkg.mcpName);
    expect(server.version).toBe(pkg.version);
    expect(server.packages).toEqual([
      expect.objectContaining({ identifier: pkg.name, version: pkg.version }),
    ]);
    // The MCP Registry rejects longer descriptions.
    expect(server.description.length).toBeLessThanOrEqual(100);
  });
});
