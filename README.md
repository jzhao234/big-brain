# big-brain 🧠

**A second brain for you *and* your AI assistants.** Plain-markdown notes, projects, and tasks — Obsidian-compatible, owned by you, readable and writable by any LLM through the [Model Context Protocol](https://modelcontextprotocol.io).

Your AI tools each keep their own memory of you, siloed and invisible. big-brain inverts that: **one knowledge vault you own, that every assistant reads and writes.** Claude Code, Claude Desktop, ChatGPT, Cursor — they all see the same projects, the same tasks, the same notes. Switch models freely; your context comes with you.

- **Plain markdown files.** No database, no lock-in. Open the vault in Obsidian, grep it, put it in git.
- **MCP server** with 22 tools: search, capture, daily logs, project and task management, link graph, related notes, vault health.
- **CLI** for humans: `big-brain status`, `big-brain capture`, `big-brain tasks`.
- **Claude Code skills** — `/brain`, `/capture`, `/weekly` — installed with one command.
- **Projects as the unit of work** — each is one file with a goal, checkbox tasks, and a running log.
- **Deterministic retrieval first**: full-text search (fuzzy, title-boosted), `[[wikilink]]` graph with backlinks, tags, frontmatter queries. No API keys, works offline.
- **Optional local hybrid search**: flip `embeddings.enabled` and a small on-device model (via `@huggingface/transformers`) adds semantic matching, fused with full-text by Reciprocal Rank Fusion — paraphrases match, exact identifiers still win, and nothing leaves your machine. Powers `related_notes` similarity too. See [docs/vault-spec.md](docs/vault-spec.md#search--embeddings-hybrid-retrieval).
- **Optional git auto-commit + push** — flip a config flag and every write, from any tool, is committed and pushed automatically, so saves never sit uncommitted and your other machines stay in sync. Best-effort: a git failure never blocks a save.

Requires Node 20+.

## Install

big-brain isn't on npm yet, so install from source (one-time):

```bash
git clone https://github.com/jzhao234/big-brain.git
cd big-brain
npm install
npm run build
npm link          # puts `big-brain` and `big-brain-mcp` on your PATH
```

`npm link` skips `-g` install quirks and lets you `git pull && npm run build` to update later. (Once published, this becomes `npm i -g big-brain`.)

## Quickstart

```bash
big-brain init ~/brain --name "My Brain"   # scaffold a vault
cd ~/brain
big-brain status                           # look around
big-brain install-skills                   # add the /brain, /capture, /weekly skills
```

Then connect an AI tool (below) and, optionally, seed the vault from your existing AI history.

## Connect your AI tools

The MCP server is the same everywhere: command `big-brain-mcp`, vault chosen by `--vault <dir>` or the `BIG_BRAIN_VAULT` env var.

**Claude Code**

```bash
claude mcp add --scope user big-brain -- big-brain-mcp --vault ~/brain
claude mcp list        # expect: big-brain ... ✔ Connected
```

**Claude Desktop / Cursor / other MCP clients** — add to the MCP config (e.g. `claude_desktop_config.json`). Use an **absolute** command path: GUI apps are launched without your shell's `PATH`, so a bare `big-brain-mcp` may not resolve (run `which big-brain-mcp` to get it).

```json
{
  "mcpServers": {
    "big-brain": {
      "command": "/absolute/path/to/big-brain-mcp",
      "args": ["--vault", "/absolute/path/to/brain"]
    }
  }
}
```

**ChatGPT and other MCP clients** — any client that speaks MCP over stdio works the same way. For clients without MCP, the CLI's `--json` output makes the vault scriptable.

**Browser (claude.ai / ChatGPT)** — cloud AIs can't launch a local stdio server. The zero-infra option is to connect them to your vault's **GitHub repo** and let them read/write the markdown directly (you lose the computed overview/search/task tools — it's raw file access). See [docs/browser-github-connector.md](docs/browser-github-connector.md) and paste [prompts/browser-github-instructions.md](prompts/browser-github-instructions.md).

Then teach the assistant how to use the vault: Claude Code reads the vault's `CLAUDE.md` automatically; for other tools, paste [`prompts/agent-instructions.md`](prompts/agent-instructions.md) into their custom instructions.

## Using it: load and save

The whole point is that you never re-feed context. The assistant **loads** a small, relevant slice on demand and **saves** small pieces as you work — you just talk to it.

**Load** — orient at the start, pull details as needed:

| You want to… | In Claude Code | CLI |
| --- | --- | --- |
| "What am I working on?" | `/brain` | `big-brain status` |
| Find notes about X | *"search my brain for X"* | `big-brain search X` |
| Read one note | *"read the Auth project"* | `big-brain show "Auth"` |
| See tasks / projects | *"what's due?"* | `big-brain tasks`, `big-brain projects` |
| Pull surrounding context | *"what's related to X?"* | `big-brain related X` |

**Save** — as decisions, progress, and ideas happen (append-first; never destructive):

| You want to… | In Claude Code | CLI |
| --- | --- | --- |
| Stash a stray thought | `/capture <text>` | `big-brain capture "…"` |
| Log a decision / progress | *"log that I shipped X"* | `big-brain daily --log "…"` |
| Add a task | *"add a task to project Y"* | `big-brain task add "…" --note Y` |
| Finish a task | *"mark that done"* | `big-brain task done <id>` |
| Start a project | *"new project: …"* | `big-brain project new "…"` |

**Review** — `/weekly` runs a guided pass: triage the inbox, prune projects, reschedule overdue tasks, fix broken links, and **consolidate** — `big-brain doctor` flags bloated notes and near-duplicates, and the review proposes splits/merges/stale-fact pruning for your approval. Capture and search keep a brain useful; consolidation keeps it trustworthy.

## Skills (Claude Code)

Three [Claude Code skills](https://docs.claude.com/en/docs/claude-code) wrap the tools into slash-commands:

- **`/brain`** — load the overview and switch into brain-aware mode for the session
- **`/capture`** — zero-friction capture to the inbox
- **`/weekly`** — a guided weekly review

```bash
big-brain install-skills          # add them to ~/.claude/skills (skips existing)
big-brain install-skills --force  # overwrite existing versions
```

They're path-agnostic — they call the `big-brain` CLI / MCP tools and resolve the vault from `BIG_BRAIN_VAULT` (or `--vault`), so the same skill works on every machine. Restart Claude Code to pick them up.

## Use it on multiple machines

The vault is a git repo, so this is just git: **clone it on each machine, and each machine runs its own `big-brain-mcp` against its own clone.** Git keeps them in sync.

- **Write side — automatic.** Set `git.autoCommit` (and `git.autoPush`) in `brain.config.json` and every write — from any tool, any machine — is committed and pushed. See [docs/vault-spec.md](docs/vault-spec.md#auto-commit).
- **Read side — pull before you start.** Add a `SessionStart` hook so a session always opens on the latest:

  ```json
  // ~/.claude/settings.json
  "hooks": { "SessionStart": [ { "hooks": [ { "type": "command",
    "command": "git -C \"$HOME/brain\" pull --ff-only --quiet 2>/dev/null || true" } ] } ] }
  ```

  `--ff-only` means a pull never clobbers local work. (Or just `git -C ~/brain pull` by hand.)

On a fresh machine: install big-brain (above), `git clone` your vault, `big-brain install-skills`, register the MCP server. Four commands and you're identical to your other machines.

## Seed it from your existing AI history

An empty brain is useless; the fastest way to a useful one is extracting what your LLMs **already know about you**. Every assistant you've used heavily — ChatGPT, Claude, Gemini — has months of context about your projects, preferences, and goals sitting in its memory and chat history. Seeding pulls that out, once, into files you own.

**1. Run the seed interview in each LLM you use.** Copy the prompt from [`prompts/seed-interview.md`](prompts/seed-interview.md) into each assistant — ideally the account with the most history, with memory/personalization enabled. It's a structured export interview: profile, current projects, stack, how you like to work with AI, goals, people, routines, standing constraints, open loops, and blind spots. It instructs the model to be concrete, mark inferences `(inferred)`, and write "No data" instead of inventing — so the output is honest enough to build on.

**2. Save each output into the vault's `inbox/`** as one file per model (`inbox/seed-chatgpt.md`, `inbox/seed-claude.md`, …). Don't organize anything yet — capture first is the whole inbox philosophy.

**3. Triage.** Ask a vault-connected assistant to run the **`process-inbox`** MCP prompt (or just say *"triage my inbox"* / run `/weekly` in Claude Code). It merges duplicates across models — different LLMs know different slices of you, and they mostly complement rather than conflict — then turns the material into real structure: projects with tasks for everything in flight, `people/` notes, a preferences note your agent instructions can point at, reference notes for your stack/setup, and open loops as tasks. You confirm per item; raw exports can be kept in `archive/` for provenance.

**4. Repeat occasionally.** Models keep accumulating context about you — re-running the interview every few months and triaging the diff keeps the vault ahead of any one provider's memory.

Two more seeding paths worth knowing: if you already keep an **Obsidian vault**, big-brain can adopt it in place (add a `brain.config.json`, map your folder names via the `folders` config — see [docs/vault-spec.md](docs/vault-spec.md)); and a **work session with a vault-connected agent seeds as a side effect** — the agent instructions tell it to create projects and capture facts as you work, so the brain fills in from real activity even if you skip the interview.

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
| `related_notes` | Related notes with reasons: links, co-citations, rare shared tags, title mentions, semantic similarity |
| `list_tags` / `vault_health` | Tag census; broken links, stale projects, bloated/duplicate notes, overdue tasks |

Plus three MCP prompts: `orient`, `weekly-review`, `process-inbox`.

## CLI

```
big-brain init [dir]            scaffold a vault        big-brain tasks [--project X]
big-brain status                overview                big-brain task add|done ...
big-brain search <query>        search (hybrid if on)   big-brain projects [--status active]
big-brain show <note>           print a note            big-brain project new|status ...
big-brain new <title>           create a note           big-brain links <note>
big-brain related <note>        related notes + why     big-brain tags
big-brain capture <text>        quick capture           big-brain doctor
big-brain daily [--log "..."]   daily note / journal    big-brain index [--status|--rebuild]
big-brain install-skills        add Claude Code skills  big-brain mcp   run the MCP server
```

Every list command takes `--json` for scripting.

## Design principles

1. **Files over databases.** Markdown you can read in 30 years beats any app.
2. **The human owns the vault; agents are guests.** Agents append and capture freely, but rewriting and archiving are deliberate acts.
3. **Deterministic beats clever.** Search + links + tags retrieves reliably and works offline; the semantic layer is opt-in, fully local, and *fused with* — never a replacement for — exact search.
4. **Model-agnostic by construction.** Everything goes through MCP or the filesystem — nothing assumes a particular AI vendor.

## Development

```bash
npm install
npm run typecheck && npm run lint && npm test
npm run build
```

MIT © Junhao Zhao
