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
  "staleProjectDays": 21
}
```

All keys optional. `folders` only needs the entries you rename. `ignore` takes extra glob patterns to exclude from scanning. `node_modules`, `.git`, `.obsidian`, `.trash`, and the templates folder are always excluded.

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
