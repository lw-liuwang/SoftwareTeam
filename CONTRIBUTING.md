# Contributing to SoftwareTeam

SoftwareTeam is developed in this repository. Contributions should explain the user-visible
change, the exact revision checked, and the verification performed.

## Before you start

- **Bugs:** open an issue with the bug template. Include your SoftwareTeam version (`SoftwareTeam --version`),
  OS, Node and tmux versions, which harnesses are involved (or none), and the relevant command and output.
  Reports are public: remove credentials, private prompts, personal details and private paths
  before posting. Share a small reproduction rather than a full transcript or instance dump.
- **Features and behaviour changes:** open a [repository issue](https://github.com/lw-liuwang/SoftwareTeam/issues) first. Search issues
  and check ROADMAP.md before proposing a feature. A short "what I am trying to do
  and what stops me" saves both of us a rewrite. Small, obvious fixes do not need an issue.
- **Questions:** use the [repository issues](https://github.com/lw-liuwang/SoftwareTeam/issues), with the relevant command and context.

## Before a security or integration PR

SoftwareTeam connects your coding agents to each other: shared context, messaging, coordination and long-running seats.
It's designed for your own machine or a trusted private network, for you and people you trust, not for the open
internet. It doesn't try to act for you in the outside world; your agents already have tools for that.

**Security-related PRs.** If you've found something exploitable, report it privately first (see
[SECURITY.md](SECURITY.md)) rather than in a public PR. For hardening changes, tell us in the PR description:

- the scenario: how this goes wrong for someone using SoftwareTeam as it's designed to be used, and the evidence you have
- who or what causes it, and how they reach the install
- what the change costs everyone else: a refusal, an extra step, a new setting

We look at the finding and the fix separately. We may agree with a finding and fix it differently, or decide the fix
costs more than it protects. If the answers are missing we'll ask once, and close the PR with thanks if they don't
come.

**Integrations with other tools or projects.** Open a repository issue and agree with a maintainer on
scope before you build it; an issue on its own isn't a yes. Often the best home for an integration is your own
repository, and we're happy to link to it.

## Setting up

Node `^22 || ^24` and a working `tmux` are required. Then:

```bash
git clone https://github.com/lw-liuwang/SoftwareTeam.git
cd SoftwareTeam
./install.sh --runtime codex  # local install; repairs workspace binary links after npm ci
npm run build          # all workspaces
npm test               # repo checks + daemon, cli, tui test suites
npm run lint           # typecheck every package
```

The installer uses the locked dependencies and builds a local package without global installation.
Use `npm install <package>` only when you're adding or changing a dependency, and commit
the lockfile change with it.

`npm test` builds the daemon and runs repository checks before the package suites. Read the
specific failure. For mirrored skills, edit the source under `skills/_canonical/`, run
`npm run mirror-skills`, then `npm run mirror-skills:check` and commit the generated copies and
digest changes. See [ARCHITECTURE.md](ARCHITECTURE.md#a-shipped-skill). The repository checks include a docs guard: a
tracked file under `docs/` must be in `docs/as-built/`, `docs/reference/` or `docs/releases/`
(`docs/DESIGN.md` is the one exception). They check that shipped first-run text names only teams, skills and
commands that exist, and they validate the context-pack sources;
`npm run generate-context-packs` rebuilds the generated packs locally, which aren't committed.
The UI unit-test suite is separate from `npm test`: run `npm run test:ui`.
[docs/as-built/test-layers.md](docs/as-built/test-layers.md) lists every test layer, what CI runs,
and what each layer can and cannot prove.

For hands-on development, read the [check requirements](docs/reference/developing.md),
[worktree setup](docs/reference/worktree-builds.md), and
[local installation](README.md#install-and-start). Use an isolated environment
for changes that start daemons or agents; `SOFTWARETEAM_HOME` alone does not isolate provider settings.
Permission configuration is an [explicit choice](docs/reference/getting-started.md#have-your-agent-configure-permissions).
A checked-out tree is not the installed daemon; restarting an installed daemon does not adopt
your working copy.

## Making the change

- One concern per pull request. Keep unrelated refactors separate; explain any refactor needed
  for the fix.
- Keep the diff small enough to review in one sitting. If it is not, say why in the description.
- Add or update a test where the change is testable. Use focused deterministic tests where
  possible. For terminal or provider behaviour, state what was exercised with the actual runtime
  and what was simulated; a stub alone does not prove the native interaction works.
- Do not edit `CHANGELOG.md`. Maintainers write release notes at the tag.
- Do not bump versions.
- Match the surrounding style. `npm run lint` typechecks; it does not format code.
- Write commit messages in the form the log already uses: `fix(cli): …`, `feat(daemon): …`,
  `docs(reference): …`, `test: …`.

## The pull request

Fill in the template. The three things a reviewer needs are: what a user gets, how you verified
it, and anything you were unsure about. State the revision and relevant local changes you tested,
what you actually ran, and any checks you could not run. Redact private information from evidence.

Contributions follow the repository's [Apache-2.0 license](LICENSE). Preserve attribution and any
applicable license notices when adapting third-party material.

## Review

Reviews may involve people and the project's agents. A maintainer makes the merge decision;
this repository does not promise response deadlines or npm publication.

## Where things live

- **Start here:** [ARCHITECTURE.md](ARCHITECTURE.md) maps the packages, the request path, and where to
  add a command, route, migration, adapter, skill, context pack or scenario.
  [docs/as-built/arteries.md](docs/as-built/arteries.md) lists the areas where a small change has a
  large effect; if your change touches one, read it first.
- **Using a coding agent?** Claude Code and Codex load the repository's `developing-softwareteam` skill
  when they work in this checkout (`.claude/skills/` and `.agents/skills/`). It points at the maps
  above and at what to run before you push.
- Repository reference: `docs/reference/`; user documentation: [repository documentation](https://github.com/lw-liuwang/SoftwareTeam/tree/main/docs).
- Skills: `packages/daemon/specs/agents/shared/skills/`, plugin skills under
  `packages/daemon/assets/plugins/`, and `skills/_canonical/`; static context-pack sources:
  `packages/daemon/context-packs-src/`.
  Generated packs live in `packages/daemon/context-packs/` and are not hand-edited or committed.
- Delivery: source from this repository and the root local installer. Package names identify
  local build artifacts, not a claim of npm publication. `docs/releases/` preserves upstream
  release history; it is not the fork's current release feed.
