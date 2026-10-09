---
name: capture
description: Quickly capture a thought, fact, idea, or link into the user's Big Brain. Use when the user asks to remember, note down, add to the brain/inbox, or explicitly invokes $capture.
---

# Capture to Big Brain

Resolve the vault through `big-brain`; do not hardcode its location. Capture
first and organize later.

1. If the user supplies content, lightly clean it without changing meaning and
   run `big-brain capture "<text>"`.
2. If the user supplies no content, capture the most recent clearly noteworthy
   decision, fact, or idea from the conversation. State exactly what you chose.
3. If it clearly belongs to an existing active project, prefer appending it to
   that project's Notes/Log through an available Big Brain tool. If only the CLI
   is available and cannot append arbitrary sections, capture it to the inbox
   rather than performing a risky rewrite.
4. If it is actionable, suggest converting it into a project task; do not add
   the task unless requested or the user already asked to record the action.

Never capture secrets, access keys, passwords, tokens, private keys, or raw
sensitive data. Big Brain writes may auto-commit and auto-push, so do not make a
second manual commit for the same write.

Confirm in one line what was captured and where. Do not add a report around it.
