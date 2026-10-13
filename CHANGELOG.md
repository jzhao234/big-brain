# Changelog

All notable changes to big-brain. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/) (below 1.0, a minor version may change behavior).

## Unreleased

## 0.3.0 (2026-10-12)

First release on npm: `npm install -g big-brain`.

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
