---
name: brain
description: Orient from the user's Big Brain vault and stay brain-aware during ongoing work. Use when the user asks what they are working on, what is overdue, to catch them up, to zoom into a project, or explicitly invokes $brain.
---

# Brain-aware work

Big Brain is the user's shared external memory. Resolve the vault through the
`big-brain` CLI (`BIG_BRAIN_VAULT`, an explicit `--vault`, or the nearest
`brain.config.json`); do not hardcode a path. Use Big Brain MCP tools when they
are actually available, otherwise use the CLI and ordinary filesystem reads.

## Orient

With no named topic:

1. Run `big-brain status`.
2. Report one-screen BLUF: active projects and next tasks, overdue/due-soon
   work, and inbox count when nonzero. Skip empty sections.
3. Run `big-brain doctor` only when health has not been checked recently or the
   user asks; surface warnings, not routine clean output.

With a named project/topic, run `big-brain show <topic>`, falling back to
`big-brain search <topic>`. Summarize the goal, status, open tasks, blockers,
and latest log entries, then continue with the user's requested work.

## Stay brain-aware

For the rest of the session, keep durable state current as work produces it:

- decisions, progress, or failures → daily log and the relevant project log;
- new multi-step commitment → project;
- new action → task on the matching project;
- completed action → mark its existing task done;
- durable fact with no obvious home → capture or linked reference/note.

Routine append-only logs and captures are authorized when the user invoked this
skill. Ask before rewriting, consolidating, archiving, or changing project
status unless the user already requested that operation. Preserve vault
frontmatter, `area`, work tags, tasks, and wikilinks. Never store credentials,
tokens, private keys, or unredacted sensitive datasets.

Big Brain may auto-commit and auto-push writes. Treat a CLI write as an external
mutation: describe it briefly in commentary and do not issue duplicate git
commits afterward. If editing files directly because the CLI lacks the needed
operation, inspect the vault's git config and leave a clean, synced repository
only when the user authorized saving/syncing.

Before ending, verify that meaningful work from the session is reflected in the
vault. Tell the user in one line what was recorded.
