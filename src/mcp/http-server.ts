import { timingSafeEqual } from "node:crypto";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  hostHeaderValidation,
  localhostHostValidation,
} from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type NextFunction, type Request, type Response } from "express";
import type { Vault } from "../core/vault.js";
import { buildServer } from "./server.js";

/** Largest JSON-RPC request body accepted; generous for whole-note rewrites. */
export const MAX_BODY_BYTES = 1024 * 1024;

const LOCALHOST_BINDS = ["127.0.0.1", "localhost", "::1"];

export interface RemoteMcpOptions {
  token: string;
  host?: string;
  allowedHosts?: string[];
  /**
   * Exact browser origins (e.g. `https://claude.ai`) allowed to call /mcp.
   * Requests without an Origin header (native MCP clients) are always allowed;
   * any other Origin is refused, which blocks DNS-rebinding and CSRF.
   */
  allowedOrigins?: string[];
  /** Override the request body cap (bytes); mainly for tests. */
  maxBodyBytes?: number;
}

function tokensMatch(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

class StaticTokenVerifier implements OAuthTokenVerifier {
  constructor(private readonly expectedToken: string) {}

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (!tokensMatch(this.expectedToken, token))
      throw new InvalidTokenError("Invalid access token");
    return {
      token,
      clientId: "big-brain-static-token",
      scopes: ["brain:read", "brain:write"],
      // The static token remains valid until the operator rotates the environment variable.
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
  }
}

function jsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

/** Normalize configured origins so `https://Brain.example.com:443/` matches the browser's form. */
function normalizeOrigins(origins: string[]): Set<string> {
  return new Set(
    origins.map((origin) => {
      let url: URL | undefined;
      try {
        url = new URL(origin);
      } catch {
        // reported below
      }
      // Only http(s) has a real origin; file: and friends serialize to "null",
      // which would admit every sandboxed iframe and opaque browser origin.
      if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
        throw new Error(`Invalid allowed origin (want http(s)://host[:port]): ${origin}`);
      }
      return url.origin;
    }),
  );
}

/**
 * Refuse foreign browser origins, and give allowlisted ones the CORS headers
 * they need. Preflights carry no Authorization header, so they're answered
 * here, before bearer auth would reject them.
 */
function originValidation(allowed: Set<string>) {
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin === undefined) {
      next();
      return;
    }
    if (!allowed.has(origin)) {
      jsonRpcError(res, 403, -32000, `Origin not allowed: ${origin}`);
      return;
    }
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, WWW-Authenticate");
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID",
      );
      res.setHeader("Access-Control-Max-Age", "600");
      res.status(204).end();
      return;
    }
    next();
  };
}

/** Map body-parser failures to JSON-RPC errors instead of Express's HTML page. */
function bodyErrorHandler(limit: number) {
  return (err: unknown, _req: Request, res: Response, next: NextFunction): void => {
    const type = err && typeof err === "object" && "type" in err ? String(err.type) : undefined;
    if (res.headersSent) {
      next(err);
    } else if (type === "entity.too.large") {
      jsonRpcError(res, 413, -32600, `Request body exceeds ${limit} bytes`);
    } else if (type === "entity.parse.failed") {
      jsonRpcError(res, 400, -32700, "Parse error");
    } else {
      next(err);
    }
  };
}

/** Build an authenticated, stateless Streamable HTTP MCP application. */
export function createRemoteMcpApp(vault: Vault, options: RemoteMcpOptions) {
  if (options.token.length < 32) {
    throw new Error("BIG_BRAIN_MCP_TOKEN must be at least 32 characters for the remote MCP server");
  }
  const host = options.host ?? "127.0.0.1";
  const allowedOrigins = normalizeOrigins(options.allowedOrigins ?? []);
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;

  const app = express();
  // Host validation (DNS-rebinding protection) mirrors the SDK's createMcpExpressApp.
  if (options.allowedHosts) {
    app.use(hostHeaderValidation(options.allowedHosts));
  } else if (LOCALHOST_BINDS.includes(host)) {
    app.use(localhostHostValidation());
  } else {
    console.error(
      `Warning: binding to ${host} without a Host allowlist; set --allowed-hosts to the public hostname.`,
    );
  }

  app.get("/health", (_req: Request, res: Response) => res.json({ status: "ok" }));

  // Order matters: reject foreign origins and missing/invalid tokens before
  // spending any work parsing an attacker-supplied body.
  app.use("/mcp", originValidation(allowedOrigins));
  app.use("/mcp", requireBearerAuth({ verifier: new StaticTokenVerifier(options.token) }));
  app.use("/mcp", express.json({ limit: maxBodyBytes }));

  app.post("/mcp", async (req: Request, res: Response) => {
    const server = buildServer(vault);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("Remote MCP request failed:", error);
      if (!res.headersSent) jsonRpcError(res, 500, -32603, "Internal server error");
    }
  });

  const methodNotAllowed = (_req: Request, res: Response) =>
    jsonRpcError(res, 405, -32000, "Method not allowed");
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  app.use(bodyErrorHandler(maxBodyBytes));

  return app;
}
