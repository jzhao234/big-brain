# Connecting big-brain to your AI tools

Big Brain exposes the same tools over two transports:

- Local stdio: `big-brain-mcp` or `big-brain mcp`.
- Remote Streamable HTTP preview: `big-brain-mcp-http` or `big-brain mcp-http`.

The vault is selected by `--vault <dir>` or the `BIG_BRAIN_VAULT` environment variable. The commands below assume the package is installed from source with `npm link` or globally after publication.

## Claude Code

```bash
claude mcp add --scope user big-brain -- big-brain-mcp --vault ~/brain
```

`--scope user` makes the brain available in every project. Working *inside* the vault directory, Claude Code also picks up the vault's `CLAUDE.md` automatically, which tells it when to capture, log, and update tasks.

## Claude Desktop

`claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "big-brain": {
      "command": "/absolute/path/to/big-brain-mcp",
      "args": ["--vault", "/Users/you/brain"]
    }
  }
}
```

Add the instructions from `prompts/agent-instructions.md` to your Claude project so it uses the tools proactively.

## Cursor

`.cursor/mcp.json` in your project (or `~/.cursor/mcp.json` globally):

```json
{
  "mcpServers": {
    "big-brain": {
      "command": "/absolute/path/to/big-brain-mcp",
      "args": ["--vault", "/Users/you/brain"]
    }
  }
}
```

## Remote Streamable HTTP preview

Generate a strong token and start the server:

```bash
export BIG_BRAIN_MCP_TOKEN="$(openssl rand -hex 32)"
big-brain-mcp-http --vault ~/brain
```

Defaults:

- Endpoint: `http://127.0.0.1:3333/mcp`
- Health check: `http://127.0.0.1:3333/health`
- Authentication: `Authorization: Bearer <BIG_BRAIN_MCP_TOKEN>`
- The bearer token is checked before parsing the JSON body. Request bodies are limited to 1 MB; larger requests receive HTTP 413 with a JSON-RPC error.
- Requests without an `Origin` header (native MCP clients and curl) are allowed. Requests with an `Origin` must match an allowed origin exactly; the default list is empty, so browser-originated requests are refused until you configure it. This protects against DNS rebinding and cross-site requests as required by the MCP spec.

Configuration:

| Environment variable | CLI option | Default |
| --- | --- | --- |
| `BIG_BRAIN_MCP_HOST` | `--host` | `127.0.0.1` |
| `BIG_BRAIN_MCP_PORT` | `--port` | `3333` |
| `BIG_BRAIN_MCP_ALLOWED_HOSTS` | `--allowed-hosts` | Localhost protection |
| `BIG_BRAIN_MCP_ALLOWED_ORIGINS` | `--allowed-origins` | Empty (browser origins refused) |

The allowed-host value is a comma-separated list, such as `brain.example.com,localhost,127.0.0.1`. Set it to the hostname clients send through your reverse proxy.
The allowed-origins value is a comma-separated list of origins, such as `https://claude.ai`. Each entry is normalized to `scheme://host[:port]` at startup (an invalid entry stops the server), then compared exactly with the browser's `Origin` header. Only `http(s)` origins are accepted. Allowlisted origins get CORS headers, and their preflight `OPTIONS` requests are answered without a token.

This server deliberately does not accept a token on the command line, where it would be visible in process listings. The static token grants both read and write access and remains valid until you rotate the environment variable and restart the process.

For anything beyond local testing:

1. Keep Big Brain bound to `127.0.0.1`.
2. Terminate HTTPS at a trusted reverse proxy or secure tunnel on the same machine.
3. Forward only the MCP endpoint and preserve the `Authorization` header.
4. Configure the external hostname with `--allowed-hosts`.
5. Add an OAuth-capable gateway before connecting a browser product that requires MCP OAuth.

Do not expose the listener directly to the public internet. The bearer-token transport is a secure foundation for self-hosting and automated clients, but it is not yet the complete OAuth 2.1 flow expected by every hosted LLM connector.

## ChatGPT / OpenAI

ChatGPT's connector system and the OpenAI Agents SDK both speak MCP. Local stdio needs a bridge; the built-in HTTP endpoint can supply the transport, but hosted connectors that require OAuth still need an OAuth-capable gateway. Once connected, paste `prompts/agent-instructions.md` into Custom Instructions.

## Anything else

- Any MCP-over-stdio client: point it at `big-brain-mcp --vault <dir>`.
- No MCP support at all? The CLI is scriptable (`big-brain search --json`, `big-brain tasks --json`) and the vault is just markdown — even a plain shell tool loop can use it.

## Errors and shutdown

A tool that can't do what was asked returns an MCP tool error (`isError: true`) with a one-line reason, including `read_note` and `note_links` for a note that doesn't exist, so clients don't have to parse prose to spot a failure.

With [auto-push](vault-spec.md#auto-commit) on, both servers push in the background. On Ctrl-C or SIGTERM (and, for stdio, when the client closes the connection) they wait up to 10 seconds for a queued push before exiting; anything still unpushed goes out with the next write.

## Multiple vaults

Register the server twice with different names and `--vault` paths (e.g. `brain-personal`, `brain-work`).

## Sanity check

```bash
big-brain-mcp --vault ~/brain
# then paste: {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}
```

You should get an `initialize` result naming the server `big-brain`. Ctrl-C to exit.
