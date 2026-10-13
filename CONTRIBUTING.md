# Contributing to big-brain

Thanks for helping. big-brain is maintained in spare time, so a small, focused change with a test is the fastest way to get something merged. Expect a reply within about a week.

## What's in scope

big-brain is a plain-markdown vault plus the tools that let people and AI assistants work in it. Good fits:

- Bugs, especially anything that loses or corrupts note content.
- Compatibility with how Obsidian and the Tasks plugin read the same files.
- MCP tools and CLI commands that follow the vault rules in [docs/vault-spec.md](docs/vault-spec.md).
- Docs that are wrong, unclear, or missing.

Usually out of scope: a database or hosted service, features that need a paid API key to work, and changes that make the vault depend on big-brain to stay readable. If you're unsure, open an issue describing the idea before writing code.

## Development setup

Node 20 or newer.

```bash
git clone https://github.com/jzhao234/big-brain.git
cd big-brain
npm install
npm run build
npm link        # optional: puts your local build on PATH as big-brain / big-brain-mcp
```

Before opening a pull request, run the same checks CI runs:

```bash
npm run typecheck && npm run lint && npm test && npm run build
```

`npm run lint:fix` applies the formatter (Biome).

## Pull requests

- One change per pull request, with a test that fails without it.
- Keep the vault format backward compatible. A note that worked before must still parse the same way.
- Write user-facing text (docs, errors, CLI output) in plain language.
- Update the README or the docs when behavior changes, and add a line under "Unreleased" in [CHANGELOG.md](CHANGELOG.md).

## Reporting bugs

Use the bug report template. The most useful reports include the command or MCP tool call, the smallest note that reproduces the problem, and what you expected. Remove anything private from notes before you paste them.

Security problems go through [SECURITY.md](SECURITY.md), not public issues.
