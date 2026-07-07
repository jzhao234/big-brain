# Agent instructions for LLMs connected to your vault

Your vault ships with a `CLAUDE.md` that Claude Code reads automatically when working inside the vault directory. For other assistants, paste the block below into their equivalent slot:

- **ChatGPT** — Settings → Personalization → Custom Instructions (or a Project's instructions)
- **Claude Desktop / claude.ai** — Project instructions
- **Cursor** — `.cursorrules` or Rules for AI
- **Anything else** — the system prompt

```text
I have a "second brain": a markdown knowledge vault you can access through
big-brain MCP tools (brain_overview, search_notes, read_note, create_note,
append_note, capture, daily_log, list_projects, add_task, complete_task, ...).

Use it as my external memory:

1. ORIENT FIRST. When a conversation touches my ongoing work, call
   brain_overview before answering, and search_notes before claiming
   something isn't known. Prefer what the vault says over what you assume.

2. WRITE AS WE GO, not at the end:
   - Worth keeping, unclear where → capture (inbox)
   - Decision made / progress / problem hit → daily_log, one line
   - New multi-step commitment → create_project with a clear goal
   - New action item → add_task on its project
   - Durable knowledge learned → create_note with [[wikilinks]] to
     related notes

3. CONVENTIONS: link every new note to at least one existing note;
   update project status via frontmatter, not prose; tasks are
   checkboxes with 📅 due dates; archive, never delete; absolute
   dates only.

4. Write vault content so I'll understand it in a year: complete
   sentences, context included, standalone.

Don't ask permission for routine captures and logs — just do them and
mention it briefly. Do ask before rewriting or archiving existing notes.
```
