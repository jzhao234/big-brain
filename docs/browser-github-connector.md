# Using the brain in a browser (claude.ai / ChatGPT) via GitHub

The big-brain MCP server runs locally over stdio, so browser AIs — which run in the cloud — can't launch it. The zero-infrastructure way to reach your vault from a browser is to **connect the AI to your vault's GitHub repo** and let it read/write the markdown files directly. Nothing new is exposed: the repo already lives on GitHub, and its access controls apply.

**What you get:** the AI can browse, search, read, and (with write scope) edit + commit your notes. **What you give up vs. the MCP server:** the computed `brain_overview`, the fuzzy search index, and the task tools. It's raw file access — so paste [`prompts/browser-github-instructions.md`](../prompts/browser-github-instructions.md) into the tool so it knows the folder layout and conventions.

## Prerequisite

Your vault is a **private GitHub repo** (e.g. `jzhao234/brain`). If it isn't a repo yet, push it first.

## claude.ai

1. **Settings → Connectors.** Enable/add the **GitHub** connector and authorize it. Grant access to just your brain repo.
   - Reading works with the standard connector.
   - **Writing (commits) needs write scope.** The robust route is to add **GitHub's official MCP server** as a custom connector (`https://api.githubcopilot.com/mcp/`) and grant it **repo write** — it exposes file-create/update tools. The basic browse connector may be read-only.
2. Start a chat, enable the connector, and paste the browser instructions block (or put it in a Claude **Project**'s instructions so every chat in that project is brain-aware).
3. Test loading: *"Read BRAIN.md and my projects/ folder — what am I working on?"* Test saving: *"Append a line to the Auth project's Log noting I rotated the key, and commit it."*

## ChatGPT

1. **Settings → Connectors** (availability is plan-gated; may require developer mode). Add/authorize the **GitHub** connector for the brain repo.
   - ChatGPT's GitHub connector is primarily **read/search** — great for loading and asking questions over the brain.
   - For **writing** from ChatGPT, either grant a write-capable custom MCP connector, or have ChatGPT draft the note/edit and you commit it (from the terminal or GitHub's web editor).
2. Paste the browser instructions block into a **Custom GPT** or the chat's custom instructions.
3. Same load/save tests as above (expect saving to be the weaker side).

## Keeping it in sync with your terminal

The repo is the single source of truth. Your VPS has [git auto-commit](vault-spec.md#auto-commit) on, so terminal/MCP edits are pushed automatically; browser edits are commits by nature. Just `git pull` on the VPS before a terminal session if you've been editing from the browser, so the two don't diverge.

## Honest tradeoff

This is the low-effort, low-exposure option and it's genuinely useful for loading context and light edits from anywhere. If you want the *full* toolset (overview, search, task ops) in the browser, that requires running big-brain as a secured remote MCP server (a tunnel + auth) — more setup and your brain on a public endpoint. For most browser use, the GitHub connector is the right call; keep Claude Code in the terminal for the rich workflow.
