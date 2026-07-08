# Vault specification

A big-brain vault is a directory of markdown files plus one config file. Everything below is convention the tools understand — none of it is enforced by a schema, and a vault remains a valid vault (and a valid Obsidian vault) if you break the rules.

## Layout

The folder names are defaults; override them in `brain.config.json` if you're adapting an existing vault.

| Folder | Note type | Purpose |
| --- | --- | --- |
| `inbox/` | `inbox` | Unprocessed captures. The only folder where mess is fine. |
| `daily/` | `daily` | One note per day, named `YYYY-MM-DD.md`. |
| `projects/` | `project` | One note per project with outcome-shaped goal, tasks, log. |
| `areas/` | `area` | Ongoing responsibilities without an end date. |
| `notes/` | `note` | Evergreen knowledge notes. |
| `people/` | `person` | One note per person. |
| `reference/` | `reference` | External facts: docs, credentials-adjacent info, how-tos. |
| `archive/` | — | Retired notes of any type, moved here instead of deleted. Excluded from search/listing by default; original subfolder is preserved (`archive/projects/Old.md`). |
| `templates/` | — | Note templates. Never indexed. |

A note's `type` comes from frontmatter when present, otherwise from its top-level folder.

## brain.config.json

```json
{
  "name": "My Brain",
  "folders": { "inbox": "inbox", "daily": "daily", "projects": "projects" },
  "ignore": ["private/**"],
  "staleProjectDays": 21,
  "git": {
    "autoCommit": false,
    "autoPush": false,
    "authorName": "Your Name",
    "authorEmail": "you@example.com"
  }
}
```

All keys optional. `folders` only needs the entries you rename. `ignore` takes extra glob patterns to exclude from scanning. `node_modules`, `.git`, `.obsidian`, `.trash`, and the templates folder are always excluded.

### Search & embeddings (hybrid retrieval)

Search is lexical by default (MiniSearch full-text: fuzzy, prefix, title-boosted) and needs no setup. Setting `embeddings.enabled: true` adds a **fully local semantic layer**: a small embedding model runs on-device via `@huggingface/transformers` (an optional dependency; the model — default `Xenova/all-MiniLM-L6-v2`, ~23MB — downloads once to `~/.cache/big-brain/models`). Queries then fuse the lexical and semantic rankings with Reciprocal Rank Fusion, so paraphrases match ("buying property" finds the house-hacking note) while exact identifiers keep working. No API keys; no note content leaves the machine.

The index lives at `.bigbrain/embeddings.json` inside the vault — **derived and rebuildable**, so it's gitignored (each machine builds its own; the starter `.gitignore` covers it). Notes are chunked on `##` boundaries (~1200 chars) and re-embedded incrementally when their content hash changes; this happens automatically during search, or explicitly:

```
big-brain index             # embed new/changed notes
big-brain index --status    # model, note/chunk counts, staleness
big-brain index --rebuild   # discard and re-embed everything
big-brain search "..." --lexical   # bypass the semantic layer for one query
```

Semantic similarity also powers part of `related_notes` / `big-brain related` — the rest of that tool (links, co-citations, rarity-weighted shared tags, unlinked title mentions) is fully deterministic and works with embeddings off.

### Auto-commit

With `git.autoCommit: true`, every write through the tool (any MCP tool, the CLI, from any LLM) runs `git add -A` + `git commit` afterward, so saves never sit uncommitted. Set `git.autoPush: true` to also `git push` after each commit and keep other devices in sync. `authorName`/`authorEmail` set the commit identity — set both on shared boxes to avoid commits attributed to a system user; leave them empty to use the repo/global git identity.

It is **best-effort**: the file is written first, so if the vault isn't a git repo, has nothing to stage, or git errors (offline, no upstream, rejected push), the save still succeeds — a one-line warning goes to stderr and nothing is lost. Commits are per write, giving a fine-grained history (every capture, log line, and status change is its own commit); a push that fails stays committed locally and syncs on the next successful push. Requires `git` on `PATH`.

## Frontmatter

```yaml
---
type: project          # note | project | area | person | reference | daily | inbox
created: 2026-01-15    # set automatically on creation
tags: [adtech, infra]  # merged with inline #tags
aliases: [ClearLine]   # alternate names for wikilink resolution
# project-specific:
status: active         # idea | active | paused | done | dropped (default: active)
area: work
started: 2026-01-15
due: 2026-03-01
completed: 2026-02-20  # stamped by set_project_status done
priority: high
---
```

Unknown keys are preserved and shown; you can add your own.

## Links, tags, titles

- **Wikilinks**: `[[Note Title]]`, `[[Note Title|shown text]]`, `[[Note Title#Heading]]`. Targets resolve against titles, aliases, and filename stems, case-insensitively. Ambiguity prefers non-archived notes, then shorter paths — but keep names unique (the doctor flags duplicates).
- **Tags**: inline `#tag` (letters, digits, `/`, `-`, `_`; must start with a letter) or frontmatter `tags:`. Compared lowercase. Code blocks are ignored.
- **A note's title** is frontmatter `title` if set, else the first `# H1`, else the filename stem.

## Tasks

Any `- [ ]` / `- [x]` checkbox line in any note is a task. Metadata uses [Obsidian Tasks](https://publish.obsidian.md/tasks/) emoji conventions:

```markdown
- [ ] Renew the certificate ⏫ 📅 2026-02-01
- [ ] Read the RTB spec 🔽
- [x] Send the report ✅ 2026-01-20
```

| Marker | Meaning |
| --- | --- |
| `📅 YYYY-MM-DD` | due date |
| `⏳ YYYY-MM-DD` | scheduled date |
| `✅ YYYY-MM-DD` | completion date (stamped by `complete_task`) |
| `⏫` / `🔽` | high / low priority |

Task IDs (shown by `list_tasks` / `big-brain tasks`) are derived from file path + task text, so they're stable until the task is reworded.

By convention tasks live in a project's `## Tasks` section or a daily note; `add_task` defaults accordingly.

## Daily notes

`daily/YYYY-MM-DD.md`, created on demand from `templates/daily.md` (placeholders: `{{date}}`, `{{title}}`). The `## Log` section is the work journal: `daily_log` appends `- YYYY-MM-DD HH:mm — entry` lines. Agents are encouraged to log decisions and progress as they happen.

## Git

Vaults are designed to live in a (private) git repo: files change atomically, tasks complete in-place, archive moves are renames. Nothing in the tooling requires git, but history + sync + merge is why files beat databases.
