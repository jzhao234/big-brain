# Security policy

big-brain reads and writes private notes, so problems that leak, corrupt, or expose a vault are taken seriously.

## Reporting a vulnerability

Please report it privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Don't open a public issue.

Include what an attacker can do, the steps to reproduce it, and the version (`big-brain --version`). You should hear back within a week. Fixes are released as soon as they're ready, and reporters are credited unless they ask not to be.

## What counts

- Writing outside the vault folder, for example through symlinks or crafted note titles.
- Getting around the bearer token, origin, or host checks of the HTTP server (`big-brain-mcp-http`).
- Losing or corrupting note content through a normal tool call.
- Secret or credential files being copied by `big-brain agents save`.

Not covered: anything that needs an attacker to already control your machine or your vault's git remote, and exposing the plain HTTP listener to the internet without TLS against the [setup guide](docs/mcp-setup.md).

## Supported versions

Only the latest release gets security fixes while big-brain is below 1.0.
