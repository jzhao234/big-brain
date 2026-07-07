---
name: weekly
description: >
  Run the weekly review of the big-brain second brain: triage the inbox, walk
  active projects, reschedule or drop overdue tasks, check vault health, and
  write a review summary. Use when the user types /weekly, or asks for a "weekly
  review", "review my projects", "clean up my brain", "triage my inbox".
---

# weekly

A guided review of the big-brain vault (whichever `big-brain` resolves — `BIG_BRAIN_VAULT`, `--vault`, or nearest `brain.config.json`). Work through it *with* the user — propose, confirm, act. The outcome: an empty inbox, honest project statuses, a task list that reflects reality, and a written record.

## Order of operations

1. **Snapshot.** `big-brain status` + `big-brain doctor`. Lead with the two or three things that most need attention (overdue tasks, stale projects, inbox pileup, broken links).
2. **Inbox triage.** For each note in the inbox, propose exactly one destination: merge into an existing note/project, become a new linked note, become tasks, or archive. Batch the proposals, get one confirmation, execute, archive the processed captures.
3. **Project walk.** For each `active` project: last Log entries, open tasks, blockers. Ask the one question that matters: *is this still active?* Update statuses (`big-brain project status <ref> paused|done|dropped`) — a shorter honest list beats an impressive stale one. For projects untouched for 2+ weeks, suggest a concrete next task or a status change.
4. **Task hygiene.** Overdue tasks get one of: do-this-week (new due date), someday (drop the date), or dead (remove). Never let a due date silently roll forward twice — that's a signal the task is mis-scoped or unwanted; say so.
5. **Doctor fixes.** Fix broken wikilinks and duplicate names found in step 1 where the fix is obvious; list the rest.
6. **Write the record.** Append a short summary to today's daily note Log: projects reviewed, status changes, inbox items processed, what the user said matters next week. If the vault has git auto-commit enabled, the review's edits commit and push on their own; otherwise commit at the end (`git -C <vault> add -A && git commit -m "weekly review <date>" && git push`).

## Tone

This is a working meeting, not a report. Short exchanges, concrete proposals, sensible defaults ("I'd archive these three — objections?"). The user's time budget is ~10 minutes; don't stretch it.
