---
name: weekly
description: >
  Run a guided weekly review of the user's Big Brain: inbox triage,
  active-project review, task hygiene, vault health, and consolidation. Use for
  weekly reviews, brain cleanup, inbox triage, or explicit $weekly invocation.
---

# Big Brain weekly review

Resolve the vault through `big-brain`; do not hardcode its path. This is a
working meeting with the user. Gather and propose first, then apply the approved
batch. Aim for about ten minutes.

1. **Snapshot.** Run `big-brain status` and `big-brain doctor`. Lead with the
   two or three items needing attention: overdue tasks, stale projects, inbox
   pileup, or broken links.
2. **Inbox triage.** For each inbox item, propose one destination: merge into an
   existing note/project, create a linked note, create tasks, or archive. Batch
   the proposals and obtain confirmation before moving/archiving.
3. **Project walk.** For each active project, show latest log entries, open
   tasks, and blockers. Ask whether it remains active. For projects untouched
   for 2+ weeks, propose a concrete next task or status change.
4. **Task hygiene.** Resolve every overdue task as do-this-week with a real new
   date, someday with no date, or dead. Never roll a due date forward silently
   twice; flag that as a scoping/priority signal.
5. **Doctor fixes.** Fix obvious broken wikilinks/duplicate names only after the
   batch is confirmed. List ambiguous findings.
6. **Consolidate.** Use doctor findings and `big-brain related <note>` to propose
   splits for bloated notes, merges for near-duplicates, and removal/striking of
   stale facts. Never merge, archive, or rewrite notes without confirmation.
7. **Record.** Log projects reviewed, status/task changes, inbox work,
   consolidations, and the user's stated focus for next week in today's daily
   note.

Prefer Big Brain tools/CLI for mutations. Preserve `area`, tags, frontmatter,
tasks, and wikilinks. Never store secrets. Writes may auto-commit/push; avoid
duplicate manual commits. Keep each exchange short and concrete.
