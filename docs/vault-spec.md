# Vault specification

A big-brain vault is a directory of markdown files plus one config file. The markdown conventions below are what the tools understand — none of them is enforced, and a vault remains a valid vault (and a valid Obsidian vault) if you break them. `brain.config.json` is the exception: it is checked when the vault opens, and a malformed one stops the tools with an error naming the field.

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
| `agents/` | — | Coding-agent profiles (skills, instructions, settings) for `big-brain agents`. Never indexed. |

A note's `type` comes from frontmatter when present, otherwise from the deepest configured folder that contains it.

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

All keys optional. `folders` only needs the entries you rename; a folder may be nested (`work/projects`), and `daily/` or `./daily` mean the same as `daily` (`.` is the vault root). Absolute paths and `..` are refused. A note without a frontmatter `type` takes the type of the deepest configured folder that contains it. Each known key's type is checked when the vault opens: `"autoPush": "false"` (a string) is refused with an error naming the file and field rather than read as on. `ignore` takes extra glob patterns to exclude from scanning. Dot-files and dot-folders (`.git`, `.obsidian`, `.trash`, …), `node_modules`, the templates folder, and the agents folder are always excluded. The tools refuse to create or archive a note anywhere the scan would skip; for a path skipped only by an `ignore` pattern, the write is detected and undone (see [Known limits](#known-limits)).

### Search & embeddings (hybrid retrieval)

Search is lexical by default (MiniSearch full-text: fuzzy, prefix, title-boosted) and needs no setup. Setting `embeddings.enabled: true` adds a **fully local semantic layer**: a small embedding model runs on-device via the opt-in `@huggingface/transformers` runtime add-on (the model — default `Xenova/all-MiniLM-L6-v2`, ~23MB — downloads once to `~/.cache/big-brain/models`). Install the add-on alongside big-brain first; from a source checkout run `npm install --no-save --package-lock=false @huggingface/transformers@^3.8.1`, or for a global npm install use `npm i -g big-brain @huggingface/transformers@^3.8.1`. Queries then fuse the lexical and semantic rankings with Reciprocal Rank Fusion, so paraphrases match ("buying property" finds the house-hacking note) while exact identifiers keep working. No API keys; no note content leaves the machine.

The index lives at `.bigbrain/embeddings.json` inside the vault — **derived and rebuildable**, so it's gitignored (each machine builds its own; the starter `.gitignore` covers it). An index file that is unreadable or the wrong shape is discarded and rebuilt. Notes are chunked on `##` boundaries (~1200 chars; oversized paragraphs split at word boundaries, so no text is dropped) and re-embedded incrementally when their content hash changes; this happens automatically during search, or explicitly. Search filters (type, tag, folder, archived) apply before semantic candidates are ranked, so excluded notes never crowd out matches.

```
big-brain index             # embed new/changed notes
big-brain index --status    # model, note/chunk counts, staleness (no model load)
big-brain index --rebuild   # discard and re-embed everything
big-brain search "..." --lexical   # bypass the semantic layer for one query
```

Semantic similarity also powers part of `related_notes` / `big-brain related` — the rest of that tool (links, co-citations, rarity-weighted shared tags, unlinked title mentions) is fully deterministic and works with embeddings off.

### Auto-commit

With `git.autoCommit: true`, every note write through the tool (any MCP tool, the CLI, from any LLM; not `init`, skill installs, or the derived search index) stages and commits only the note paths touched by that operation, without sweeping in unrelated staged, unstaged, or untracked work. Existing edits within a touched note are included because git cannot separate ownership at the hunk level. Set `git.autoPush: true` to also push after each commit and keep other devices in sync.

Pushes run **in the background**, so a save never waits on the network: a CLI command returns (and exits) as soon as the commit is made, while a detached `git push` finishes on its own. A long-running MCP server coalesces pushes, so commits made while a push is running are covered by one follow-up push, and on shutdown it waits up to 10 seconds for a queued push before exiting: the stdio server on Ctrl-C, SIGTERM, or the client closing the connection, and the HTTP server once open requests have finished. Send the signal to the server process itself; the `big-brain mcp` / `mcp-http` wrappers don't forward signals. A server killed outright, or a push still queued after that wait, leaves those commits local until the next successful push. `authorName`/`authorEmail` set the commit identity — set both on shared boxes to avoid commits attributed to a system user; leave them empty to use the repo/global git identity.

It is **best-effort**: the file is written first, so if the vault isn't a git repo, has nothing to stage, or git errors (offline, no upstream, rejected push), the save still succeeds and nothing is lost. Real git failures print a warning to stderr (for a background push, only while the process is still running); a vault that isn't a repo, or a write with nothing to commit, is skipped silently. Commits are per write, giving a fine-grained history (every capture, log line, and status change is its own commit); a push that fails stays committed locally and syncs on the next successful push. Requires `git` on `PATH`.

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

The block must start on the first line (a leading UTF-8 BOM is fine) and both delimiters must be lines of exactly `---` (trailing spaces allowed). A note that opens with `---` but never closes it has no frontmatter: the line is read as a horizontal rule and everything stays body. Frontmatter is always YAML and must be a mapping of `key: value` lines; dates such as `2026-01-05` stay strings.

If the block exists but isn't valid YAML, the note still loads (its metadata reads as empty) and appends and task edits still work, but `update_frontmatter`, `replace_note_body`, and `set_project_status` refuse with the parse error instead of rewriting the note and losing the block. Fix the YAML, then retry. `vault_health` / `big-brain doctor` lists non-archived notes whose frontmatter didn't parse, and `read_note` shows the error and the raw block.

## Links, tags, titles

- **Wikilinks**: `[[Note Title]]`, `[[Note Title|shown text]]`, `[[Note Title#Heading]]`. Targets resolve against titles, aliases, and filename stems, case-insensitively. Ambiguity prefers non-archived notes, then shorter paths — but keep names unique (the doctor flags duplicates).
- **Tags**: inline `#tag` (letters, digits, `/`, `-`, `_`; must start with a letter) or frontmatter `tags:`. Compared lowercase.
- **Code is ignored**: links, tags, and headings inside fenced code blocks (fences of three or more backticks or tildes, closed only by a fence of the same character at least as long) or inline code don't count, and neither do task lines inside fences, so a `# comment` in a shell snippet is never mistaken for a section. A fence left open runs to the end of the note; appends close it first. (Task metadata is read from the whole task line, including any inline code on it.)
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
| `✅ YYYY-MM-DD` | completion date (stamped by `complete_task`; removed when `update_task` reopens) |
| `⏫` / `🔽` | high / low priority |

`- [-]` marks a task cancelled (Obsidian Tasks convention): it's excluded from open, overdue, and next-task views but still listed with `status: all`.

Checkboxes in fenced code blocks and in the frontmatter block aren't tasks.

Task IDs (shown by `list_tasks` / `big-brain tasks`) are derived from file path + task text, so they're stable until the task is reworded (completing, rescheduling, or reprioritizing keeps the id). `update_task` reports the new id when it rewords one. Tasks with identical text in the same file are numbered in order, so if one copy is deleted the next takes its id; re-list before acting on an id you saved earlier.

`complete_task` and `update_task` accept an id or text, matched in that order: id (exact), then a task's whole text, then a unique fragment (text matches are case-insensitive). So `Call Bob` completes that task even when `Call Bob about invoice` also exists; a fragment that matches several tasks is refused with the candidates listed. A task is only rewritten if its line still reads as it did when it was matched, so an edit landing between the match and the write makes the call fail instead of changing the wrong line.

By convention tasks live in a project's `## Tasks` section or a daily note; `add_task` defaults accordingly.

## Daily notes

`daily/YYYY-MM-DD.md`, created on demand from `templates/daily.md`. The `## Log` section is the work journal: `daily_log` appends `- YYYY-MM-DD HH:mm — entry` lines. Agents are encouraged to log decisions and progress as they happen.

## Templates

`templates/daily.md` and `templates/project.md` shape new daily notes and projects. Placeholders: `{{date}}` and `{{title}}` in both, plus `{{goal}}` in the project template; unknown placeholders are left as written.

A template can carry its own frontmatter (as Obsidian templates often do). Its keys are merged into the new note's frontmatter instead of being pasted into the body; the note's own fields win (`type`, `created`, and for projects the project's name, `status`, `started`, `area`, and `due`), and template `tags` are combined with the note's. A blank `due:` in a project template is a placeholder; an impossible one (`2026-02-30`) is refused. A template whose frontmatter doesn't parse is used whole as the body.

## Git

Vaults are designed to live in a (private) git repo. Note writes use a same-directory temporary file and atomic rename; local CLI/MCP processes serialize mutations to the same note with a per-note lock under `.bigbrain/locks/`. Each writer reloads the note after acquiring the lock, so one big-brain process can't overwrite another's newer append or metadata update. (An editor or sync client doesn't take these locks.) A lock older than 30 seconds is taken over only if the process that holds it has exited (or after 10 minutes, in case it is hung). Archive moves are renames. These locks coordinate processes sharing one filesystem, not separate git clones; cross-machine conflicts still use normal git conflict handling. Nothing in the tooling requires git, but history + sync + merge is why files beat databases.

A few more write rules:

- **Writes stay in the vault.** Reads follow symlinks inside the vault, but a write whose real location (through a symlinked folder or note) is outside it is refused. So is a `folders.archive` that points outside the vault.
- **Line endings are kept.** Edits write a note back with the line ending most of it already uses, so a CRLF note stays CRLF.
- **Filenames** come from the title, minus characters that are unsafe in filenames or wikilinks (`\ / : * ? " < > | # ^ [ ]`). The name before `.md` is capped at 120 UTF-16 code units and 200 bytes, so titles in non-Latin scripts are cut sooner, and never mid-character.

## Known limits

These are deliberate tradeoffs or open problems, not bugs to work around silently:

- **Duplicate task ids.** Tasks with identical text in one file are numbered by position, so after one copy is deleted an id saved from an earlier listing names the other. Re-list before acting on an old id.
- **Advisory locks.** Lock takeover checks that the owner has exited, but two processes reclaiming the same stale lock at once, an owner suspended for over 10 minutes, or processes in different PID namespaces can still overlap. Editors and sync clients don't take the locks at all.
- **Path races.** The outside-the-vault check runs under the lock just before each write; a symlink swapped in after that check isn't caught.
- **Ignore-pattern undo.** A note created or archived into a folder hidden only by an `ignore` pattern is undone after the write. A file another program saves there in the instant between the check and the undo can be removed or overwritten.
- **Unpushed commits on hard exit.** See [Auto-commit](#auto-commit): a killed server leaves queued commits local until the next successful push.
