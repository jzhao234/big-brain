# big-brain 🧠

**A second brain for you *and* your AI assistants.** Plain-markdown notes, projects, and tasks — Obsidian-compatible, owned by you, readable and writable by any LLM through the [Model Context Protocol](https://modelcontextprotocol.io).

Your AI tools each keep their own memory of you, siloed and invisible. big-brain inverts that: **one knowledge vault you own, that every assistant reads and writes.** Claude Code, Claude Desktop, ChatGPT, Cursor — they all see the same projects, the same tasks, the same notes. Switch models freely; your context comes with you.

- **Plain markdown files.** No database, no lock-in. Open the vault in Obsidian, grep it, put it in git.
- **MCP server** with 20 tools: search, capture, daily logs, project and task management, link graph, vault health.
- **CLI** for humans: `big-brain status`, `big-brain capture`, `big-brain tasks`.
- **Projects as the unit of work** — each is one file with a goal, checkbox tasks, and a running log.
- **Deterministic retrieval**: full-text search (fuzzy, title-boosted), `[[wikilink]]` graph with backlinks, tags, frontmatter queries. No embeddings, no API keys, works offline.
- **Optional git auto-commit**: flip `git.autoCommit` (and `autoPush`) in config and every write — from any tool, any LLM — is committed (and pushed) automatically, so saves never sit uncommitted and other devices stay in sync. Best-effort: a git failure never blocks a save. See [docs/vault-spec.md](docs/vault-spec.md#auto-commit).

## Quickstart

```bash
# 1. Create a vault
npx big-brain init ~/brain --name "My Brain"

# 2. Look around
cd ~/brain && npx big-brain status

# 3. Connect your AI tools (see below), then seed it
#    prompts/seed-interview.md — extract what your LLMs already know about you
```

Requires Node 20+.

## Connect your AI tools

The MCP server is the same everywhere: command `big-brain-mcp`, vault passed via `--vault` or the `BIG_BRAIN_VAULT` env var.

**Claude Code**

```bash
claude mcp add --scope user big-brain -- npx -y big-brain-mcp --vault ~/brain
```

**Claude Desktop / Cursor / other MCP clients** — add to the MCP config (e.g. `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "big-brain": {
      "command": "npx",
      "args": ["-y", "big-brain-mcp", "--vault", "/absolute/path/to/brain"]
    }
  }
}
```

**ChatGPT and others** — any client that speaks MCP over stdio works the same way. For clients without MCP, the CLI's `--json` output makes the vault scriptable.

Then teach the assistant how to use it: the vault's `CLAUDE.md` covers Claude Code automatically; paste [`prompts/agent-instructions.md`](prompts/agent-instructions.md) into other tools' custom instructions.

## Seed it from your existing AI history

Your LLMs already know a lot about you. [`prompts/seed-interview.md`](prompts/seed-interview.md) is a structured interview prompt — run it in ChatGPT, Claude, Gemini, wherever you have history; drop each output into `inbox/`; then ask a vault-connected assistant to run the `process-inbox` prompt to merge it all into real notes, projects, and tasks.

## The vault

```
brain/
├── BRAIN.md          # index & ground rules
├── CLAUDE.md         # agent instructions (picked up by Claude Code)
├── brain.config.json
├── inbox/            # capture now, organize later
├── daily/            # one note per day: focus, log, tasks
├── projects/         # one file per project: goal, tasks, log
├── areas/            # ongoing responsibilities
├── notes/            # evergreen knowledge, densely [[linked]]
├── people/           # one note per person
├── reference/        # external facts, docs, how-tos
├── archive/          # nothing is deleted, only archived
└── templates/        # daily/project/note/person templates
```

Notes are markdown + YAML frontmatter (`type`, `tags`, `status`, `due`…). Tasks are `- [ ]` checkboxes with [Obsidian Tasks](https://publish.obsidian.md/tasks/)-style metadata: `📅 2026-03-01` due, `⏫` priority, `✅` done-date. Full details in [docs/vault-spec.md](docs/vault-spec.md).

## MCP tools

| Tool | What it does |
| --- | --- |
| `brain_overview` | Orient: active projects, due/overdue tasks, inbox, recent notes |
| `search_notes` | Full-text search with type/tag/folder/status filters |
| `read_note` / `list_notes` | Read by path, title, or alias; browse by folder/type/tag |
| `create_note` / `append_note` / `replace_note_body` | Write notes (append is the safe default) |
| `update_frontmatter` / `archive_note` | Metadata changes; non-destructive delete |
| `capture` | Quick capture to inbox |
| `daily_note` / `daily_log` | Daily notes and timestamped work journal |
| `list_projects` / `create_project` / `set_project_status` | Project lifecycle |
| `list_tasks` / `add_task` / `complete_task` | Checkbox tasks across the vault |
| `note_links` | Outgoing links + backlinks for a note |
| `list_tags` / `vault_health` | Tag census; broken links, stale projects, overdue tasks |

Plus three MCP prompts: `orient`, `weekly-review`, `process-inbox`.

## CLI

```
big-brain init [dir]            scaffold a vault        big-brain tasks [--project X]
big-brain status                overview                big-brain task add|done ...
big-brain search <query>        full-text search        big-brain projects [--status active]
big-brain show <note>           print a note            big-brain project new|status ...
big-brain new <title>           create a note           big-brain links <note>
big-brain capture <text>        quick capture           big-brain tags
big-brain daily [--log "..."]   daily note / journal    big-brain doctor
big-brain mcp                   run the MCP server
```

Every list command takes `--json` for scripting.

## Design principles

1. **Files over databases.** Markdown you can read in 30 years beats any app.
2. **The human owns the vault; agents are guests.** Agents append and capture freely, but rewriting and archiving are deliberate acts.
3. **Deterministic beats clever.** Search + links + tags retrieves reliably and works offline; you can add embeddings on top, but you shouldn't need them to find your own notes.
4. **Model-agnostic by construction.** Everything goes through MCP or the filesystem — nothing assumes a particular AI vendor.

## Development

```bash
npm install
npm run typecheck && npm run lint && npm test
npm run build
```

MIT © Junhao Zhao
