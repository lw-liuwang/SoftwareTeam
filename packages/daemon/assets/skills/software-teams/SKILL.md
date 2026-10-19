---
name: software-teams
description: Install or start the repository-backed SoftwareTeam professional software team, recover its management conversation, or select its runtime and team name.
---

# SoftwareTeam

Seven permanent experts work in two groups: product contains manage-agent and
need-agent; dev contains home-agent, code-agent, review-agent, test-agent and
run-agent. Management is the default human contact.

## Install and Start

Use the source checkout, Linux/macOS, Node.js 22 or 24 with npm, Git, tmux,
and the selected Codex or Claude Code executable. From the checkout root:

```sh
./install.sh --runtime codex
./start.sh --name my-team --runtime codex
```

Use `--runtime claude-code` for Claude Code. Startup bootstraps a cold checkout;
installation builds and installs that checkout locally. No globally published
SoftwareTeam package, upstream installer or owner credential import is required.

The selected provider authenticates separately inside the new instance account.
When login is missing, startup prints the exact scoped login command and exits
with `authentication_required`. Complete that login and repeat startup. Do not
copy owner credentials, switch providers or broaden permissions to bypass it.

`--name` selects the real team identifier. Omitted names reuse the saved choice;
a fresh instance defaults to `software-team`. A different explicit name is refused
on the same instance. Use a fresh absolute `--state-dir` for another team. Names
match `^[A-Za-z0-9][A-Za-z0-9_-]*$`, excluding `external` and `kernel`.

Help, `--dry-run` and `--check` work without dependencies and write nothing.
`--check` does not authenticate or start agents. Report daemon health, exact
seven-seat readiness, terminal result and visual confirmation separately.

## Reach Management

Startup verifies all seven selected runtime seats and requests the team terminal
view. Management for the example is `product-manage-agent@my-team`; development
is `dev-code-agent@my-team`. Recover actual identity with
`SoftwareTeam whoami --json` inside a seat, or query
`SoftwareTeam ps --nodes --software-team my-team --json` through the instance
command printed by the installer.

For headless use, pass `--headless`. Give the exact private-socket attachment
command printed by startup for a new terminal on the daemon host. A successful
window request does not prove visible content. Preserve conversations; stopped
seats without resume data require a deliberate decision, not automatic fresh
launch. Never restart the old resident team to test a new checkout.

Web stays off by default. Explicitly enabling `ui.enabled` requires an owned
daemon restart; `SoftwareTeam ui open` prints its URL and requests a browser.
Do not enable or open it without the person's request.

Use the root README and `docs/reference/help.md` for current recovery instructions.
OpenRig is the upstream source provenance. Prepare sanitized issue reports for
the repository maintainers and send them only with authorization.
