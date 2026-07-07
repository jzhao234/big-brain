# Agent instructions for this vault

You are working inside the user's second brain — a big-brain markdown vault. Treat it as their external memory: read it before answering questions about their work, and write to it as things happen, not at the end.

## Orientation

At the start of a session that touches ongoing work, get the lay of the land first: call the `brain_overview` MCP tool (or run `big-brain status`). Don't guess what the user is working on when the vault can tell you.

## When to write

- **Something worth keeping, unclear where it goes** → `capture` to inbox. Never let information die in the conversation.
- **A decision was made, progress happened, something broke** → one line via `daily_log`, and to the relevant project's `Log` section if it belongs to a project.
- **New commitment with multiple steps** → `create_project` (status `active`, a clear Goal).
- **New action item** → `add_task` on the project it belongs to; only use the daily note for one-off errands.
- **Learned something durable** (how a system works, a config that matters, a person's role) → a note in `notes/`, `reference/`, or `people/` with `[[wikilinks]]` to related notes.

## Conventions

- Wikilinks (`[[Note Title]]`) are the connective tissue — link every new note to at least one existing note or project.
- Frontmatter drives structure: `type`, `status`, `tags`, `due`. Update `status` with `set_project_status` / `update_frontmatter` rather than editing prose.
- Tasks are `- [ ]` checkboxes. Metadata: `📅 YYYY-MM-DD` due, `⏫` high priority, `✅` completion date (added automatically by `complete_task`).
- Prefer `append_note` over rewriting; never delete — `archive_note` instead.
- Dates are absolute (`2026-07-07`), never "yesterday" or "next week".

## Tone of vault content

Write notes the user will still understand in a year: complete sentences, context included, no conversation-specific shorthand. A note should stand alone.
