# Connecting big-brain to your AI tools

The MCP server runs over stdio: command `big-brain-mcp` (or `big-brain mcp`), vault selected by `--vault <dir>` or the `BIG_BRAIN_VAULT` environment variable.

If you've installed globally (`npm i -g big-brain`) use `big-brain-mcp` directly; otherwise `npx -y big-brain-mcp` works everywhere.

## Claude Code

```bash
claude mcp add --scope user big-brain -- npx -y big-brain-mcp --vault ~/brain
```

`--scope user` makes the brain available in every project. Working *inside* the vault directory, Claude Code also picks up the vault's `CLAUDE.md` automatically, which tells it when to capture, log, and update tasks.

## Claude Desktop

`claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "big-brain": {
      "command": "npx",
      "args": ["-y", "big-brain-mcp", "--vault", "/Users/you/brain"]
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
      "command": "npx",
      "args": ["-y", "big-brain-mcp", "--vault", "/Users/you/brain"]
    }
  }
}
```

## ChatGPT / OpenAI

ChatGPT's connector system and the OpenAI Agents SDK both speak MCP. For stdio servers you currently need a local bridge or to run big-brain behind an HTTP MCP gateway (e.g. `mcp-proxy`). Once connected, paste `prompts/agent-instructions.md` into Custom Instructions.

## Anything else

- Any MCP-over-stdio client: point it at `npx -y big-brain-mcp --vault <dir>`.
- No MCP support at all? The CLI is scriptable (`big-brain search --json`, `big-brain tasks --json`) and the vault is just markdown — even a plain shell tool loop can use it.

## Multiple vaults

Register the server twice with different names and `--vault` paths (e.g. `brain-personal`, `brain-work`).

## Sanity check

```bash
npx -y big-brain-mcp --vault ~/brain
# then paste: {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}
```

You should get an `initialize` result naming the server `big-brain`. Ctrl-C to exit.
