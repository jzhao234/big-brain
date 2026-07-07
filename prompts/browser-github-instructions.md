# Browser instructions — accessing the brain over a GitHub connector

Use this when a browser AI (claude.ai, ChatGPT) reaches your vault through a **GitHub connector** rather than the big-brain MCP server. There are no big-brain tools in this mode — the AI reads and writes the raw markdown files in the repo directly. This block teaches it the layout and conventions so it behaves like a brain-aware assistant anyway.

Paste it into the tool's custom instructions / project instructions, or as the first message of a chat where the connector is enabled. Replace `<your-brain-repo>` with e.g. `jzhao234/brain`.

```text
The GitHub repo <your-brain-repo> is my "second brain" — a markdown knowledge
vault. You can access it through the GitHub connector. Treat it as my external
memory. There are no special tools here; you read and write the repo's markdown
files directly.

ORIENT FIRST (loading):
- Before answering anything about my work, read BRAIN.md (the index + ground
  rules) and CLAUDE.md (conventions). Then browse the relevant folder.
- Layout: projects/ = one file per project (Goal / Tasks / Log); notes/ and
  reference/ = knowledge; people/ = one file per person; daily/ = one note per
  day (YYYY-MM-DD.md) with a Log; inbox/ = unprocessed captures; areas/ =
  ongoing responsibilities; archive/ = retired notes (ignore unless asked).
- To find something, use the connector's repo search / file browse. Prefer
  reading the 1–2 relevant files over dumping everything.

WRITE AS WE GO (saving) — commit to the repo when things happen, not at the end:
- A decision / progress / problem  -> append one line to the relevant project's
  "## Log" section, and/or to today's daily note "## Log".
- A new multi-step commitment       -> a new file in projects/ (see frontmatter
  below), status: active, with a clear Goal.
- A new action item                 -> a "- [ ] ..." checkbox under the
  project's "## Tasks".
- Something durable I learned        -> a new file in notes/ or reference/ with
  [[wikilinks]] to related notes.
- A stray thought with no home       -> a new file in inbox/.
- Use a clear commit message, e.g. "brain: log key rotation on Auth project".

CONVENTIONS:
- Every note starts with YAML frontmatter:
    ---
    type: note | project | area | person | reference | daily | inbox
    created: 2026-07-07
    tags: [tag1, tag2]
    # projects also: status: active|paused|done, due: 2026-03-01
    ---
- Link generously with [[Note Title]]. Tasks are "- [ ] text" with optional
  "📅 2026-03-01" due dates; completed tasks are "- [x] ... ✅ <date>".
- ALWAYS APPEND, never silently rewrite a note. Never delete — if something is
  dead, move it to archive/. Use absolute dates (2026-07-07), never "today".
- Ask me before rewriting or archiving an existing note. Routine appends,
  captures, and log lines you can just do (and tell me in one line).
- Write notes so I'll understand them in a year: complete sentences, context
  included, standalone.

LIMITATION: unlike my terminal setup, you have no computed overview, search
index, or task tools here — you're working the files directly. That's fine;
just browse and read what's relevant, and keep edits small and well-committed.
```
