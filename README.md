# SoftwareTeam

A resident software engineering team for this repository, derived from
[OpenRig](https://github.com/mvschwarz/openrig).

| Expert | Responsibility |
| --- | --- |
| manage-agent | Your default contact; coordinates work, checks evidence and routes decisions |
| need-agent | Requirements, acceptance criteria and final acceptance |
| home-agent | Architecture, implementation conformance and technical debt |
| code-agent | Implementation, self-checks and defect correction |
| review-agent | Independent code review and correction verification |
| test-agent | Actual testing, regression and defect reproduction |
| run-agent | Resources, health, deployment, live retest and incident recovery |

## Install and Start

Linux or macOS, Node.js **22 or 24** with npm, Git, tmux, and the selected
Codex or Claude Code executable are required. Native SQLite compilation may
also need Python and a C/C++ toolchain if a prebuilt binary is unavailable.

From a source checkout:

```sh
./install.sh --runtime codex
./start.sh --runtime codex
```

Choose the actual team name with `./start.sh --name my-team --runtime codex`.
The two groups stay `product` and `dev`; addresses become
`product-manage-agent@my-team`, `dev-code-agent@my-team`, and so on.
Later launches reuse the saved name when `--name` is omitted. A different explicit
name on the same instance is refused; use a fresh `--state-dir` for another team.
Names preserve case and must match `^[A-Za-z0-9][A-Za-z0-9_-]*$`; `external` and
`kernel` are reserved. This restriction belongs to the root startup controller.

Use `--runtime claude-code` to select Claude Code. `./start.sh` also installs
a cold checkout automatically. Installation builds and packs **this checkout**
and installs it under `~/.softwareteam/install`; it does not require an upstream
command or a published npm package. It repairs missing workspace build-tool
entries automatically. No system package manager or global npm installation runs.

The exact main command is `SoftwareTeam`. After installation:

```sh
./SoftwareTeam --help
./SoftwareTeam --version
# Or add the printed instance-local bin directory to your shell PATH:
export PATH="$HOME/.softwareteam/bin:$PATH"
SoftwareTeam --help
```

The first start requires a separate native provider login in the new SoftwareTeam
account. When authentication is absent, startup prints the exact scoped login
command and exits with `authentication_required`. Run that command, then repeat
`./start.sh`. Existing provider credentials are never copied. Only the selected
provider is checked, and no permissions are broadened to bypass login.

Startup uses a fresh database, private tmux socket, loopback port and account
configuration under `~/.softwareteam`. Existing installations and data are not
migrated, discovered or adopted. A running instance is reused only when its
identity and artifact match; source changes require reinstalling after explicitly
stopping the owned instance. Startup never stops another instance automatically.
Custom state directories must be outside the source checkout. A leftover
`controller.lock` is never reclaimed automatically: inspect its PID and confirm
all controllers have stopped before manually removing that lock directory.

```sh
./start.sh --dry-run
./start.sh --check
./start.sh --runtime codex --headless
./start.sh --state-dir '/absolute/path with spaces/softwareteam' --port 7434
```

`--help`, `--dry-run` and `--check` work without project dependencies and make no
changes. `--check` does not authenticate or launch a provider. `--no-start` performs
installation only. `--json` reports final facts. A missing prerequisite or failed
phase exits nonzero; install-only success does not mean the experts are ready.

Normal startup opens the existing terminal experience and verifies all seven
experts. Terminal visibility is reported separately from readiness. On a headless
host use `--headless`; startup prints the precise private-socket attachment command
for manage-agent, to run in a new terminal. Repeat startup preserves existing
conversations, knowledge and records. Partial readiness is reported by expert name.

The Web UI remains off until explicitly requested:
`./SoftwareTeam config set ui.enabled true` enables it on the next explicit daemon
restart; `./SoftwareTeam ui open` prints its URL and requests a browser. Startup
does not enable it or open a browser.

## Team Work

The repository is the shared project; expert workspace directories isolate skill
projection, not code branches. The default conversation is
`product-manage-agent@software-team`; other experts are directly addressable, for
example `product-need-agent@software-team`.

- [Project responsibilities and paths](team/PROJECT.md)
- [Team template](team/software-team.template.yaml)
- [PR workflow](packages/daemon/src/builtins/workflow-specs/software-team-pr.yaml)
- [Product workflow](packages/daemon/src/builtins/workflow-specs/software-team-product.yaml)
- [Standards status](team/standards.yaml) and [tool status](team/tools.yaml)
- [Knowledge](team/knowledge/project-facts.md), [records](team/records/README.md),
  [handoff template](team/templates/handoff.yaml) and [method sources](team/SOURCES.md)

Experts return results to manage-agent. PR delivery requires independent review,
actual testing and need-agent acceptance; product delivery additionally requires
deployment and live retest. Candidate SOPs remain subject to human review.
Local implementation does not approve those standards. Version changes require
the affected experts to confirm their conclusions again.

## Development and Provenance

```sh
npm run build
npm run lint
npm test
npm run test:ui
```

Use the repository's isolated test harnesses. Never restart the daemon hosting your
own session to test checkout code. Current naming is intentionally incompatible
with the original product's database, API, environment and package identities.

SoftwareTeam retains the original authorship and [Apache-2.0 license](LICENSE).
Upstream issue/source links, legal notices and explicitly historical execution
records remain authentic. They do not describe a SoftwareTeam validation pass.
The original source release and its known limitations are recorded in
[CHANGELOG.md](CHANGELOG.md) and [release notes](docs/releases/v0.6.12.md).
No npm scope ownership or publication is claimed.
