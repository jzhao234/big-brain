---
name: brain
description: >
  Orient in the user's big-brain second brain and work brain-aware for the rest
  of the session. Use when the user types /brain, or asks "what am I working
  on", "what's on my plate", "catch me up", "what's overdue", or at the start of
  a session about ongoing work. Loads the vault overview, reports it in one
  screen, and keeps the vault updated as work happens.
argument-hint: "[blank = overview | a project/topic to zoom into]"
---

# brain

The big-brain vault is the user's external memory, shared by all their AI tools. This skill loads it and switches you into brain-aware mode. The vault is whichever one `big-brain` resolves — the `BIG_BRAIN_VAULT` env var, a `--vault` path, or the nearest `brain.config.json`. Use the `big-brain` CLI or the big-brain MCP tools; don't hardcode a vault path.

## With no argument

1. Run `big-brain status` (or call the `brain_overview` MCP tool).
2. Report in one screen, BLUF: active projects with their next task, anything overdue or due this week, inbox count if it's piling up. No filler; skip empty sections.
3. If the vault hasn't been linted recently, run `big-brain doctor` and surface only warnings.

## With an argument

Treat it as a project or topic: `big-brain show <arg>` (falling back to `big-brain search <arg>`), then summarize where it stands — goal, status, open tasks, last Log entries — and ask what to work on.

## Brain-aware mode (rest of the session)

From here on, keep the vault current as a side effect of the work:

- Decisions, progress, and problems → `big-brain daily --log "..."` and a Log line on the affected project.
- New commitments → project notes; new action items → `big-brain task add`.
- Completed work → `big-brain task done <id>`.
- Facts worth keeping with no obvious home → `big-brain capture "..."`.

Do routine captures/logs without asking (mention them in one line); ask before rewriting or archiving existing notes. If the vault has git auto-commit enabled, these saves also commit and push on their own. At the end of a work session, make sure what happened is reflected in the vault — the next session (or another LLM) starts from there.
