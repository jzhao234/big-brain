# Changelog

All notable changes to big-brain. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/) (below 1.0, a minor version may change behavior).

## Unreleased

### Added

- `create_project` (MCP) and `big-brain project new` accept a `folder` (`--folder`), so a vault that keeps projects in more than one place (say `work/projects` and `life/projects`) can file each where it belongs. Without it, projects still go to `folders.projects`.

## 0.4.0 (2026-11-20)

### Changed

- big-brain now requires Node 22.12 or newer. Node 20 reached end of life in April 2026, and current releases of `commander` and `vitest` no longer support it. CI tests Node 22 and 24.

### Security

- Dependencies updated so `npm audit` is clean again: zod 4.6 (memory exhaustion validating oversized collections), body-parser 2.4 (denial of service), hono, @hono/node-server, qs, fast-uri, ip-address and the MCP SDK; dev tooling moves to vitest 5 and Biome 2.

### Added

- Antigravity (`agy`) support. `big-brain setup` registers the MCP server with `agy mcp add` and installs `/brain`, `/capture`, and `/weekly` into `~/.gemini/config/skills` when `agy` is on PATH (`--no-agy` skips it). It checks `agy mcp list` first and never registers when that fails, since `agy mcp add` overwrites a server of the same name.
- `big-brain agents` manages an `agents/agy/` profile: `instructions.md` links to `~/.gemini/config/AGENTS.md`, skills and files link under `~/.gemini/config/`, and `settings.json` merges three ways into `~/.gemini/antigravity-cli/settings.json`.
- `create_note` (MCP) accepts any note type and an optional `folder`, and `big-brain new` takes `--folder`. Built-in types still pick their folder; a custom type such as `brag` or `client` defaults to `notes/` unless a folder is given. Before, the MCP tool rejected every type outside six built-ins and had no way to choose a folder.
- `big-brain context` prints what an agent should know about a directory, for session-start hooks: the one note whose `repos:` frontmatter owns the directory's git repository (summary, status, open tasks, and the names of notes listing it under `related_repos:`), else the longest matching `context.paths` rule in `brain.config.json`, else the active projects. `--format claude|codex|agy` emits each agent's hook output; hook formats read the working directory from the hook's stdin and never fail the session. Output is capped by `context.maxChars` (default 4000). `doctor` adds `shared-repo` for a repository claimed by two notes, which loads neither.
- `big-brain doctor` checks three more things: `ambiguous-link` (a wikilink that only matches the filenames of several notes, such as two `fleet.md` in different folders), `duplicate-heading` (two sibling sections with the same heading, where appends only ever reach the first), and `uncommitted-changes` (files left uncommitted in an auto-commit vault).

### Fixed

- A wikilink now resolves to the note whose title or alias matches before a note that only shares its filename: `[[Fleet]]` reaches `projects/Fleet.md` (title "Fleet") rather than a shorter `brag/fleet.md` titled "Fleet brag sheet". After that, non-archived notes win, then shorter paths, then path order, so exact ties no longer depend on scan order.
- Auto-commit retries for up to about two seconds while another git process holds the index lock. Before, the second of two simultaneous writes left its note saved but uncommitted.

## 0.3.2 (2026-10-14)

### Fixed

- `npm audit` reports no vulnerabilities in the installed package. `fast-glob` (which pulled in `micromatch` and `braces`) is replaced by `tinyglobby`, and `gray-matter` (which pulled in an old `js-yaml`, `argparse`, and `sprintf-js`) is no longer used; notes are written byte for byte as before.
- A vault containing a symlink back to one of its own folders no longer runs out of memory while scanning.

### Changed

- An `ignore` pattern ending in a slash (`"private/"`) now hides that folder; before, it matched nothing.

## 0.3.1 (2026-10-13)

### Added

- `big-brain setup [dir]`: one command (`npx @jzhao234/big-brain setup`) installs big-brain globally, creates or adopts a vault, registers the MCP server and skills with Claude Code and Codex when they're installed, and prints config for Claude Desktop and Cursor. Rerunning it changes nothing; `--dry-run` shows the plan.

## 0.3.0 (2026-10-12)

First release on npm: `npm install -g @jzhao234/big-brain`.

### Added

- Authenticated Streamable HTTP MCP server (`big-brain-mcp-http`), a preview for remote clients.
- `update_task` tool and `big-brain task update` to reschedule, reword, reopen, or cancel a task in place.
- CLI commands `archive`, `append`, and `frontmatter`, and `tasks --tag`.
- Agent profiles: keep Claude Code and Codex skills, instructions, hooks, and settings in the vault and install them on any machine (`big-brain agents`).
- `vault_health` / `big-brain doctor` reports notes whose frontmatter doesn't parse.
- Registry metadata (`server.json`) for the official MCP Registry.

### Changed

- `brain.config.json` is validated when the vault opens; a wrong type or an absolute folder path stops with an error naming the field.
- Git auto-commit only commits the notes a write touched, and pushes run in the background.
- Semantic search re-embeds the vault once after upgrading (oversized paragraphs are now split into chunks).

### Fixed

- Note writes are atomic, locked per note, keep line endings, and refuse to land outside the vault, inside code blocks, or inside frontmatter.
- Frontmatter is split on whole-line `---` delimiters, so a body that starts with `---` is no longer lost.
- Obsidian's table-escaped link alias (`[[target\|alias]]`) resolves to its target.
- Dozens of smaller fixes to dates, tasks, templates, related notes, and shutdown behavior; see the commit history.

## 0.2.0 (2026-07-08)

- Optional local hybrid search (full-text plus on-device embeddings), `related_notes`, and the consolidation checks in `doctor`.

## 0.1.0 (2026-07-07)

- First version: markdown vault, MCP server, CLI, git auto-commit, and the `/brain`, `/capture`, and `/weekly` skills.
