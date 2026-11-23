---
name: capture
description: >
  Quick-capture a thought, idea, link, or fact into the big-brain second brain's
  inbox. Use when the user types {{/capture}} <text>, or says "note this down",
  "remember this in my brain", "add to my inbox", "capture this idea".
  Zero-friction: file it now, organize later.
claude:
  argument-hint: "<the thing to capture>"
codex:
  openai:
    interface:
      display_name: "Capture"
      short_description: "Capture a thought into the Big Brain vault"
      default_prompt: "Use {{/capture}} to save this thought into my Big Brain."
---

# capture

Get it into the vault before it's lost. Don't organize, don't ask clarifying questions; that's what triage is for. The target vault is whatever `big-brain` resolves (`BIG_BRAIN_VAULT` env, `--vault`, or nearest `brain.config.json`); don't hardcode a path.

1. If there's an argument, capture it verbatim (lightly cleaned): `big-brain capture "<text>"`. If the note obviously belongs to an active project instead (it names one), append it to that project's `## Notes` and say so.
2. If there's no argument, capture the most recent noteworthy thing from the conversation (the idea/decision/fact just discussed). State in one line what you captured.
3. If the capture contains something actionable ("need to", "don't forget to"), also offer: "want this as a task on <project>?" Add the task only if the user says yes.

Never capture secrets: passwords, tokens, access or private keys, or raw sensitive data.

Confirm with one line: where it went. Nothing else. (If the vault has git auto-commit on, the capture is committed and pushed automatically; don't commit it again yourself.)
