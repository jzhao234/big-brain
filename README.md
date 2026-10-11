# big-brain 🧠

**A second brain for you *and* your AI assistants.** Plain-markdown notes, projects, and tasks — Obsidian-compatible, owned by you, readable and writable by any LLM through the [Model Context Protocol](https://modelcontextprotocol.io).

Your AI tools each keep their own memory of you, siloed and invisible. big-brain inverts that: **one knowledge vault you own, that every assistant reads and writes.** Claude Code, Claude Desktop, ChatGPT, Cursor — they all see the same projects, the same tasks, the same notes. Switch models freely; your context comes with you.

- **Plain markdown files.** No database, no lock-in. Open the vault in Obsidian, grep it, put it in git.
- **MCP server** with 23 tools: search, capture, daily logs, project and task management, link graph, related notes, vault health.
- **CLI** for humans: `big-brain status`, `big-brain capture`, `big-brain tasks`.
- **Claude Code skills** — `/brain`, `/capture`, `/weekly` — installed with one command.
- **Projects as the unit of work** — each is one file with a goal, checkbox tasks, and a running log.
- **Deterministic retrieval first**: full-text search (fuzzy, title-boosted), `[[wikilink]]` graph with backlinks, tags, frontmatter queries. No API keys, works offline.
- **Optional local hybrid search**: flip `embeddings.enabled` and a small on-device model (via `@huggingface/transformers`) adds semantic matching, fused with full-text by Reciprocal Rank Fusion — paraphrases match, exact identifiers still win, and nothing leaves your machine. Powers `related_notes` similarity too. See [docs/vault-spec.md](docs/vault-spec.md#search--embeddings-hybrid-retrieval).
- **Optional git auto-commit + push** — flip a config flag and every write, from any tool, commits only the note paths it touched and pushes automatically, so saves never sit uncommitted, unrelated work is not swept in, and your other machines stay in sync. Best-effort: a git failure never blocks a save, and pushes run in the background so a slow network never delays one.
- **Edits that don't damage notes.** Writes are atomic and locked per note, keep each note's line endings, never land inside code blocks or frontmatter, refuse to rewrite frontmatter they can't parse, and never write outside the vault (even through a symlink).

Requires Node 20+.

## Install

big-brain isn't on npm yet, so install from source (one-time):

```bash
git clone https://github.com/jzhao234/big-brain.git
cd big-brain
npm install
npm run build
npm link          # puts the CLI and both MCP server commands on your PATH
```

`npm link` skips `-g` install quirks and lets you `git pull && npm run build` to update later. (Once published, this becomes `npm i -g big-brain`.)

The default install keeps semantic-search native dependencies out of the base package. To enable local embeddings, install the opt-in runtime add-on alongside big-brain, then set `embeddings.enabled` to `true` in `brain.config.json`:

```bash
npm install --no-save --package-lock=false @huggingface/transformers@^3.8.1
```

For a future global npm install, install both packages into the same global prefix: `npm i -g big-brain @huggingface/transformers@^3.8.1`.

## Quickstart

```bash
big-brain init ~/brain --name "My Brain"   # scaffold a vault
cd ~/brain
big-brain status                           # look around
big-brain install-skills                   # add the /brain, /capture, /weekly skills
```

Then connect an AI tool (below) and, optionally, seed the vault from your existing AI history.

## Connect your AI tools

For local clients, run `big-brain-mcp`; the vault is chosen by `--vault <dir>` or the `BIG_BRAIN_VAULT` environment variable.

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

**Other local MCP clients** — any client that speaks MCP over stdio works the same way. For clients without MCP, the CLI's `--json` output makes the vault scriptable.

**Remote MCP preview** — Big Brain can expose the same 23 tools through an authenticated Streamable HTTP endpoint:

```bash
export BIG_BRAIN_MCP_TOKEN="$(openssl rand -hex 32)"
big-brain mcp-http --vault ~/brain
# endpoint: http://127.0.0.1:3333/mcp
```

It binds to localhost by default and checks `Authorization: Bearer <token>` before parsing JSON. Bodies are capped at 1 MB (larger requests get HTTP 413 with a JSON-RPC error). Requests without `Origin` are allowed; requests with one require an exact match in `--allowed-origins` / `BIG_BRAIN_MCP_ALLOWED_ORIGINS`, which defaults to empty and refuses browser origins. Keep it behind an HTTPS reverse proxy or secure tunnel; never expose the plain HTTP listener directly. The static token is the first self-hosted transport milestone, not an OAuth implementation—browser connectors that require OAuth still need an OAuth-capable gateway. See [docs/mcp-setup.md](docs/mcp-setup.md#remote-streamable-http-preview).

**Browser fallback (claude.ai / ChatGPT)** — the zero-infrastructure option is to connect the AI to your vault's **GitHub repo** and let it read/write the markdown directly (you lose the computed overview/search/task tools — it's raw file access). See [docs/browser-github-connector.md](docs/browser-github-connector.md) and paste [prompts/browser-github-instructions.md](prompts/browser-github-instructions.md).

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
| Add to a note | *"add that to the Auth note's Log"* | `big-brain append "Auth" --heading Log -- "- …"` |
| Change metadata | *"set Auth's due date to …"* | `big-brain frontmatter "Auth" due=2026-11-01` |
| Retire a note | *"archive that note"* | `big-brain archive "Auth"` |

**Review** — `/weekly` runs a guided pass: triage the inbox, prune projects, reschedule overdue tasks, fix broken links, and **consolidate** — `big-brain doctor` flags bloated notes and near-duplicates, and the review proposes splits/merges/stale-fact pruning for your approval. Capture and search keep a brain useful; consolidation keeps it trustworthy.

## Skills

Three skills wrap the tools into commands, for Claude Code (`/brain`) and Codex (`$brain`):

- **`brain`** — load the overview and switch into brain-aware mode for the session
- **`capture`** — zero-friction capture to the inbox
- **`weekly`** — a guided weekly review

`big-brain agents install claude codex` installs them for both agents (see below). `big-brain install-skills` still copies the Claude versions into `~/.claude/skills` (`--force` overwrites). They're path-agnostic — they call the `big-brain` CLI / MCP tools and resolve the vault from `BIG_BRAIN_VAULT` (or `--vault`), so the same skill works on every machine.

## Agent profiles: your agent setup in the vault

Your coding agents' personal setup — skills, global instructions, hooks, the status line, a few settings — can live in the vault too, so every machine gets the same setup from one command and a change made on one machine reaches the others through git.

```
agents/claude/instructions.md   -> ~/.claude/CLAUDE.md
agents/claude/skills/<name>/    -> ~/.claude/skills/<name>   (one link per skill)
agents/claude/files/**          -> ~/.claude/**              (one link per file: statusline.sh, hooks/…)
agents/claude/settings.json     -> merged into ~/.claude/settings.json
agents/codex/instructions.md    -> ~/.codex/AGENTS.md
agents/codex/skills/<name>/     -> ~/.codex/skills/<name>
agents/codex/config.toml        -> merged into ~/.codex/config.toml
```

```bash
big-brain agents status                    # linked, missing, edited here, or only on this machine
big-brain agents install --dry-run         # show the plan
big-brain agents install                   # link everything (agents with a profile; or name them)
big-brain agents save claude statusline.sh --setting statusLine    # capture a local change
big-brain agents save codex skills/my-skill --setting tui.status_line
```

How it stays safe:

- **Links, not copies.** Edit a skill or script in the vault (or through the link) and every machine has it after `git pull`. Everything else in `~/.claude` / `~/.codex` — other skills, history, credentials — is never touched.
- **Nothing unmanaged is replaced unless you say so.** A file in the way is reported; `--replace` moves it to a timestamped backup under `~/.local/state/big-brain/backups` (outside every agent folder, so a backed-up skill is never picked up) with a restore manifest, then links the vault's.
- **Settings merge three ways.** big-brain remembers what it applied on each machine: a value you edited locally is reported, not overwritten (`--replace` takes the vault's); a value you never touched follows the vault; a key dropped from the vault is removed only if it wasn't edited. Claude hooks are matched by event, matcher, and command, so changing a timeout updates the hook instead of registering it twice. TOML is edited line by line (comments, trust entries and hook hashes stay put), and any edit that would change more than the managed keys is refused.
- **Plan first, then write, and roll back on failure.** Every link and settings change is validated before the first write; a refusal leaves the machine untouched, and if a step still fails midway the steps already done are undone (if even that fails, nothing is deleted and the error says where the originals are). Nothing is written through a symlinked folder, and a settings file kept as a symlink (e.g. in a dotfiles repo) stays a symlink. `--prune` removes links whose vault file was deleted.
- **`save` never captures secrets or machine state.** Settings files, `.credentials.json`, `auth.json`, `.env` files, history, sessions, caches and databases are refused — save individual settings with `--setting`.
- **Codex hooks stay local.** Codex asks you to trust each hook on each machine, so hook registrations are not managed for Codex. Claude Code users: review new hooks with `/hooks`. Status warns when Codex's `AGENTS.override.md` overrides `AGENTS.md`.

`CLAUDE_CONFIG_DIR` and `CODEX_HOME` are honored. The folder name is `folders.agents` in `brain.config.json` (default `agents`), and it is never indexed as notes.

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

On a fresh machine: install big-brain (above), `git clone` your vault, `big-brain agents install`, register the MCP server. Four commands and your notes, skills, instructions, hooks, and status lines match your other machines.

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
| `list_tasks` / `add_task` / `complete_task` / `update_task` | Checkbox tasks across the vault; `update_task` reschedules, reprioritizes, rewords, reopens, or cancels one in place |
| `note_links` | Outgoing links + backlinks for a note |
| `related_notes` | Related notes with reasons: links, co-citations, rare shared tags, title mentions, semantic similarity |
| `list_tags` / `vault_health` | Tag census; broken links, stale projects, bloated/duplicate notes, overdue tasks |

Plus three MCP prompts: `orient`, `weekly-review`, `process-inbox`.

## CLI

```
big-brain init [dir]            scaffold a vault        big-brain tasks [-p X] [-t tag] [--due-by D]
big-brain status                overview                big-brain task add|done ...
big-brain search <query>        search (hybrid if on)   big-brain projects [--status active]
big-brain show <note>           print a note            big-brain project new|status ...
big-brain new <title>           create a note           big-brain links <note>
big-brain related <note>        related notes + why     big-brain tags
big-brain capture <text>        quick capture           big-brain doctor
big-brain daily [--log "..."]   daily note / journal    big-brain index [--status|--rebuild]
big-brain append <note> <text>  append [--heading H]    big-brain frontmatter <note> k=v ...
big-brain archive <note>        archive (non-destructive delete)
big-brain agents status|install|save   agent setup from the vault (see Agent profiles)
big-brain install-skills        add Claude Code skills  big-brain mcp   run the MCP server
```

Every list command takes `--json` for scripting. `task done` and `task update` take a task id or its text: a task's whole text wins over longer tasks that contain it, and an ambiguous fragment lists the candidates. Put `--` before `append` text that starts with `-` (a list item), or it is read as an option. `frontmatter` reads each value as YAML, like `key: value` in the file: `'tags=[work, llm]'` is a list, `due=2026-11-01` stays a date string, and `key=null` (or `key=`) removes the key. Quote any assignment that contains spaces, or the shell splits it into separate arguments.

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
