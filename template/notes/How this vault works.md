---
type: note
created: {{date}}
tags: [meta]
---

# How this vault works

Everything here is a plain markdown file. Obsidian, big-brain (CLI + MCP server), your editor, and any LLM all read and write the same files — no database, no lock-in. `git` gives you history and sync.

## The lifecycle of information

1. **Capture** — anything worth keeping lands in `inbox/` the moment you encounter it (`big-brain capture "..."` or the `capture` tool). Zero friction, zero organizing.
2. **Triage** — during a review, each inbox item becomes a task on a project, a note in `notes/`/`reference/`, or gets archived.
3. **Connect** — every note links to related notes with `[[wikilinks]]`. Links are what make retrieval work later; backlinks are computed for free.
4. **Use** — LLMs search the vault (`search_notes`), orient themselves (`brain_overview`), and update it as you work.
5. **Review** — weekly: prune projects, reschedule overdue tasks, empty the inbox. `big-brain doctor` flags broken links, stale projects, and pileups.

## Frontmatter cheatsheet

```yaml
---
type: note | project | area | person | reference | daily | inbox
created: 2026-01-15
tags: [adtech, infra]
aliases: [alternate name]
# projects also use:
status: idea | active | paused | done | dropped
area: work
due: 2026-03-01
---
```

## Tasks

Tasks are checkbox lines, usually under a project's `## Tasks` heading:

```markdown
- [ ] Ship the report ⏫ 📅 2026-01-20
- [x] Draft the outline ✅ 2026-01-12
```

`⏫`/`🔽` priority, `📅` due date, `✅` completion date — the same syntax the Obsidian Tasks plugin uses.

## Related

- [[Set up my second brain]] — the starter project with your first tasks
