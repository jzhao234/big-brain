---
name: brain
description: >
  Orient in the user's big-brain second brain and work brain-aware for the rest
  of the session. Use when the user types $brain, or asks "what am I working
  on", "what's on my plate", "catch me up", "what's overdue", or at the start of
  a session about ongoing work. Loads the vault overview, reports it in one
  screen, and keeps the vault updated as work happens.
---

# brain

The big-brain vault is the user's external memory, shared by all their AI tools. This skill loads it and switches you into brain-aware mode. The vault is whichever one `big-brain` resolves using the `BIG_BRAIN_VAULT` env var, a `--vault` path, or the nearest `brain.config.json`. Use the `big-brain` CLI, or the big-brain MCP tools when this session has them; don't hardcode a vault path.

## With no argument

1. Run `big-brain status` (or call the `brain_overview` MCP tool).
2. Report in one screen, BLUF: active projects with their next task, anything overdue or due this week, inbox count if it's piling up. No filler; skip empty sections.
3. If the vault hasn't been linted recently, run `big-brain doctor` and surface only warnings.

## With an argument

Treat it as a project or topic: `big-brain show <arg>` (falling back to `big-brain search <arg>`), then summarize where it stands (goal, status, open tasks, last Log entries) and ask what to work on.

## Brain-aware mode (rest of the session)

From here on, keep the vault current as a side effect of the work:

- Decisions, progress, and problems → `big-brain daily --log "..."` and a Log line on the affected project. When that line changes what the project's Summary (or Goal) says, such as its state, version, or what's open or done, update the Summary too: the next session sees the Summary, not the Log.
- Fixing existing text → `big-brain edit <note> --old "<exact passage>" --new "<replacement>"` (`edit_note`), never retyping the whole note.
- New commitments → project notes; new action items → `big-brain task add`.
- Completed work → `big-brain task done <id>`.
- Facts worth keeping with no obvious home → `big-brain capture "..."`.

Do routine captures/logs without asking (mention them in one line); ask before rewriting or archiving existing notes, or changing a project's status, unless the user already asked for it. Keep each note's frontmatter, `area`, tags, tasks, and wikilinks intact, and never store credentials, tokens, private keys, or raw sensitive data. If the vault has git auto-commit enabled, these saves also commit and push on their own, so don't commit them again yourself. At the end of a work session, make sure what happened is reflected in the vault and say in one line what you recorded. The next session (or another LLM) starts from there.
