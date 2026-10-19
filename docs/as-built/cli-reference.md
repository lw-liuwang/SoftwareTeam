---
kind: as-built
title: CLI Reference — Registered Commands and Options
status: active
topics: [orchestration, coordination, observability, knowledge-and-context]
domains: [engineering-advisor, operating-advisor]
applies-when: |
  Looking up the complete registered SoftwareTeam command/option surface or locating
  the source that implements a command. Use command help for invocation details.
siblings: [README.md, codemap.md]
prerequisite-reads: [../reference/help.md]
last-verified-against-source: e8f0ab340db773392ec8be75b072d1c0f3068a50
last-updated: 2026-10-08
---

# CLI Reference — Registered Commands and Options

Verified against source commit `e8f0ab340db773392ec8be75b072d1c0f3068a50`.
The inventory below comes from the actual Commander tree returned by
[`createProgram()`](../../packages/cli/src/index.ts), not a grep of command
strings or an installed CLI from a different commit.

There are **87 top-level registrations**, **356 registered command objects**
below `SoftwareTeam` (including groups and the hidden `restore apply` command), and
**1,082 explicitly registered option objects**, including the root version
option. Aliases do not add command objects; short/long spellings of one
option do not add option objects. Commander-generated help is additional.
These are source counts, not a claim about a deployed release.

## Reading this reference

Each table row lists one registered command, its positional arguments,
command aliases, and its **own declared options**. `<value>` denotes a
required positional/option value; `[value]` is optional; `...` is variadic.
An option marked **required** was registered with Commander's mandatory
option setting. An option marked (repeatable) collects every value when it is
given more than once. Conditional requirements enforced by an action are not
encoded by this inventory.

Use `SoftwareTeam <command> --help` for descriptions, choices, defaults, and examples.
Defaults may depend on the current directory, configuration, or action code;
they are not fixed by the flags table. Parent command options are listed on
the parent row, not repeated on every child. The root declares `-V, --version`;
Commander also provides `-h, --help` and applicable `help [command]` handling.
The only explicit command alias at this pin is `SoftwareTeam host ls` for `host list`.

An option named `--json` selects the command's JSON mode; it does not imply
that every verb shares one response schema. The handler and its daemon
route remain the source for result/error shape and side effects.

## Entry points and practical routes

Bare `SoftwareTeam` opens the TUI, the status dashboard rather than an agent conversation, when both
stdin and stdout are terminals. Arguments,
pipes, and redirected streams follow normal CLI parsing.
[`runFrontDoor` and `openMissionControl`](../../packages/cli/src/front-door.ts)
own the entry behavior; [`tuiCommand`](../../packages/cli/src/commands/tui.ts)
owns explicit TUI options; `SoftwareTeam terminal open saved:kernel --window` opens a terminal view
of the SoftwareTeam TUI, the operator and the advisor (in a new tab or window, or the current
Herdr session), and `SoftwareTeam tui --shared` is the dashboard-only fallback when that view cannot open. A daemon-down transport result can still open the
recovery cockpit; it is not automatically a reason to exit before rendering.

| Need | Start here |
|---|---|
| Install, upgrade, or make a first project | [Getting started](../reference/getting-started.md), then `SoftwareTeam setup --help` and `SoftwareTeam doctor --help`. |
| Inspect live state and diagnose failures | `SoftwareTeam ps`, `SoftwareTeam health`, `SoftwareTeam doctor`; [health diagnosis](../reference/health-diagnosis.md). |
| Define/start SoftwareTeams and seats | `SoftwareTeam spec`, `SoftwareTeam agent`, `SoftwareTeam up`, `SoftwareTeam create`, `SoftwareTeam grow`, `SoftwareTeam seat continue`; [SoftwareTeamSpec](../reference/software-team-spec.md) and [AgentSpec](../reference/agent-spec.md). |
| Snapshot, restore, or hand over | `SoftwareTeam snapshot`, `SoftwareTeam restore`, `SoftwareTeam restore-check`, `SoftwareTeam restore-packet`, `SoftwareTeam handover`; [lifecycle source map](architecture/lifecycle-snapshot-restore.md). |
| Find owned work or communicate | `SoftwareTeam queue`, `SoftwareTeam send`, `SoftwareTeam stream`, `SoftwareTeam chatroom`, `SoftwareTeam walk`; [coordination source map](architecture/coordination-primitive.md). |
| Work with projects, missions, slices, and proof | `SoftwareTeam scope`, `SoftwareTeam proof`, `SoftwareTeam workflow`; [project workspace](../reference/project-workspace.md) and [SDLC conventions](../reference/sdlc-conventions.md). |
| Read/project context and skills | `SoftwareTeam context`, `SoftwareTeam skill`, `SoftwareTeam package`; [context source map](architecture/plugin-agent-image-context-pack.md). |
| Connect another host or human channel | `SoftwareTeam host`, `SoftwareTeam gateway`, `SoftwareTeam slack`; [Slack setup](../reference/slack-app-setup.md). |
| Check, share, or start a SoftwareTeam bundle | `SoftwareTeam bundle check`, `SoftwareTeam bundle`, `SoftwareTeam up <GitHub folder link>`; [packaging source map](architecture/packaging-bootstrap-bundles.md). |
| Find a specialist seat across SoftwareTeams and hosts | `SoftwareTeam roster` (read-only). |
| Read event, queue-transition, and tenure telemetry | `SoftwareTeam telemetry`. |

Do not confuse `SoftwareTeam project`'s coordination/classification surface with
`SoftwareTeam scope`'s project and work-tree commands. Likewise, `SoftwareTeam spec` manages
SoftwareTeam specifications, `SoftwareTeam specs` browses the spec library, and
`SoftwareTeam workflow specs` lists workflow specifications. The tree below preserves
those distinct registrations.

A successful read, queue admission, terminal delivery, proof judgment, and
publication are different operations. Consult the relevant command handler
and [workflow runtime](architecture/workflow-runtime.md) when deciding what a
result establishes. This reference does not turn an inventory entry into
permission to perform that operation.

## Reproducing the registration inventory

In a development checkout at the stamped commit, after installing its locked
dependencies and building the daemon and CLI, this import walks the registered
tree without parsing arguments or invoking command actions:

```sh
node --input-type=module <<'JS'
import { createProgram } from './packages/cli/dist/index.js';
const root = createProgram();
const rows = [];
function walk(command, prefix = '') {
  const path = prefix ? `${prefix} ${command.name()}` : command.name();
  rows.push({
    path,
    aliases: command.aliases(),
    arguments: command.registeredArguments.map(a => ({
      name: a.name(), required: a.required, variadic: a.variadic,
    })),
    options: command.options.map(o => ({
      flags: o.flags, required: Boolean(o.mandatory),
    })),
  });
  for (const child of command.commands) walk(child, path);
}
walk(root);
console.log(JSON.stringify({
  topLevel: root.commands.length,
  registeredCommands: rows.length - 1,
  declaredOptions: rows.reduce((n, row) => n + row.options.length, 0),
  rows,
}, null, 2));
JS
```

This inspects registration, not action semantics or availability of a running
daemon. [`index.ts`](../../packages/cli/src/index.ts) imports the command
factories; their implementations live in
[`packages/cli/src/commands/`](../../packages/cli/src/commands/).
The tables below retain registration order. Only the command/argument/alias/
option cells are mechanically transcribed; the explanations above are authored.

## Registered command tree

Root: `SoftwareTeam`; declared option: `-V, --version`.

### start

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam start` | — | `--last`<br>`--all`<br>`--software-teams <names...>`<br>`--json` |

### daemon

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam daemon` | — | — |
| `SoftwareTeam daemon start` | — | `--port <port>`<br>`--host <host>`<br>`--db <path>`<br>`--no-kernel`<br>`--wait-for-kernel`<br>`--wait-for-kernel-ms <ms>` |
| `SoftwareTeam daemon stop` | — | — |
| `SoftwareTeam daemon status` | — | — |
| `SoftwareTeam daemon logs` | — | `--follow` |

### status

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam status` | — | `--json` |

`SoftwareTeam status --json` prints one object: `daemon`, `kernel`, `workspaceRoot`, `SoftwareTeams` and `cmux`.
`daemon.reachable` has three values. `true`: the daemon answered its health probe (it may still
report `healthy: false`, and may carry a `reason` and `eventLoop` evidence). `false`: positively down
(`state` is `stopped` or `stale`). `null`: not confirmed (`state` is `unverified`, or `running`
with `reason: "unresponsive"` because `/healthz` did not answer). When `reachable` is not `true`,
the sections that were not read are `null`.

### snapshot

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam snapshot <softwareTeamId>` | — | `--intended-seats <ids>` |
| `SoftwareTeam snapshot list <softwareTeamId>` | — | — |

### restore

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam restore` | — | — |
| `SoftwareTeam restore apply <snapshotId>` (hidden) | — | `--software-team <softwareTeamId>` **required** |
| `SoftwareTeam restore status <attemptId>` | — | `--software-team <softwareTeamId>` **required**<br>`--json` |

### crash-cart

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam crash-cart` | — | `--json` |

### gateway

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam gateway` | — | — |
| `SoftwareTeam gateway human` | — | — |
| `SoftwareTeam gateway human add <entityId>` | — | `--display-name <name>` **required**<br>`--binding <kind:connectorRef:secretsRef:role[:handle=<id>]>` **required** (repeatable)<br>`--delivery-class <A\|B\|C\|D>` **required**<br>`--away`<br>`--replace`<br>`--reason <reason>`<br>`--actor <actor>` |
| `SoftwareTeam gateway human list` | — | `--json` |
| `SoftwareTeam gateway human show <entityId>` | — | `--json` |
| `SoftwareTeam gateway human set <entityId> <field> <value>` | — | `--reason <reason>`<br>`--actor <actor>` |
| `SoftwareTeam gateway human remove <entityId>` | — | `--force` |

### parked

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam parked [seat]` | — | `--software-team <SoftwareTeam>`<br>`--json` |

### export

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam export <softwareTeamId>` | — | `-o, --output <path>` |

### import

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam import <path>` | — | `--instantiate`<br>`--materialize-only`<br>`--workspace-only`<br>`--preflight`<br>`--target-SoftwareTeam <softwareTeamId>`<br>`--software-team-root <root>`<br>`--cwd <path>` |

### ui

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam ui` | — | — |
| `SoftwareTeam ui open` | — | — |

### tui

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam tui` | — | `--shared` |
| `SoftwareTeam tui commands` | — | `--json` |

### package

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam package` | — | — |
| `SoftwareTeam package validate <path>` | — | — |
| `SoftwareTeam package plan <path>` | — | `--target <dir>`<br>`--runtime <runtime>`<br>`--role <name>` |
| `SoftwareTeam package install <path>` | — | `--target <dir>`<br>`--runtime <runtime>`<br>`--role <name>`<br>`--allow-merge` |
| `SoftwareTeam package rollback <installId>` | — | — |
| `SoftwareTeam package list` | — | — |

### bootstrap

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam bootstrap <spec>` | — | `--plan`<br>`--yes`<br>`--cwd <path>`<br>`--target <path>`<br>`--skip-version-check`<br>`--force`<br>`--json` |

### requirements

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam requirements <spec>` | — | `--json` |

### discover

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam discover` | — | `--json`<br>`--draft` |

### attach

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam attach` | — | `--self` **required**<br>`--software-team <softwareTeamId>` **required**<br>`--node <logicalId>`<br>`--pod <namespace>`<br>`--member <name>`<br>`--runtime <runtime>`<br>`--cwd <path>`<br>`--display-name <name>`<br>`--print-env`<br>`--json` |

### bind

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam bind <discoveredId>` | — | `--software-team <softwareTeamId>` **required**<br>`--node <logicalId>`<br>`--pod <namespace>`<br>`--member <name>` |

### adopt

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam adopt <path>` | — | `--bind <logicalId=tmuxSessionOrDiscoveryId>` (repeatable)<br>`--bindings-file <path>`<br>`--target-SoftwareTeam <softwareTeamId>`<br>`--software-team-root <root>`<br>`--json` |

### bundle

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam bundle` | — | — |
| `SoftwareTeam bundle create <spec>` | — | `-o, --output <path>` **required**<br>`--name <name>`<br>`--bundle-version <ver>`<br>`--include-packages <refs...>`<br>`--software-team-root <root>`<br>`--context-pack <dir>` (repeatable)<br>`--project-dir <dir>`<br>`--preset <name>`<br>`--seat <member=runtime>` (repeatable)<br>`--notes <text>`<br>`--min-daemon-version <ver>`<br>`--min-cli-version <ver>`<br>`--allow-drift`<br>`--json` |
| `SoftwareTeam bundle configurations <spec>` | — | `--json` |
| `SoftwareTeam bundle inspect <path>` | — | `--preset <name>`<br>`--seat <member=runtime>` (repeatable)<br>`--json` |
| `SoftwareTeam bundle install <path>` | — | `--preset <name>`<br>`--seat <member=runtime>` (repeatable)<br>`--non-interruptive`<br>`--no-non-interruptive`<br>`--plan`<br>`--yes`<br>`--target <root>`<br>`--cwd <path>`<br>`--skip-version-check`<br>`--force`<br>`--json` |
| `SoftwareTeam bundle check <folder>` | — | `--json` |
| `SoftwareTeam bundle history` | — | `--software-team <name>`<br>`--since <iso>`<br>`--json` |

### up

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam up <source>` | — | `--non-interruptive`<br>`--no-non-interruptive`<br>`--plan`<br>`--yes`<br>`--cwd <path>`<br>`--env <KEY=VALUE>` (repeatable)<br>`--target <root>`<br>`--preset <name>`<br>`--seat <member=runtime>` (repeatable)<br>`--existing`<br>`--fresh <seats...>`<br>`--json`<br>`--host <id>` |

### down

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam down <SoftwareTeam>` | — | `--delete`<br>`--force`<br>`--snapshot`<br>`--json`<br>`--host <id>` |

### archive

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam archive <softwareTeamId>` | — | `--force`<br>`--json` |

### unarchive

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam unarchive <softwareTeamId>` | — | `--json` |

### host

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam host` | — | — |
| `SoftwareTeam host add` | — | `--id <id>` **required**<br>`--transport <transport>` **required**<br>`--target <target>`<br>`--user <user>`<br>`--url <url>`<br>`--bearer-env <name>`<br>`--bearer-file <path>`<br>`--notes <text>`<br>`--json` |
| `SoftwareTeam host select <id>` | — | `--json` |
| `SoftwareTeam host rename <name>` | — | `--json` |
| `SoftwareTeam host pair <url>` | — | `--id <id>`<br>`--timeout <seconds>`<br>`--human <address>`<br>`--json` |
| `SoftwareTeam host list` | `ls` | `--json` |
| `SoftwareTeam host doctor <id>` | — | `--posture <profile>`<br>`--public-addr <ip>`<br>`--json` |

### ps

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam ps` | — | `--json`<br>`--no-cleanup`<br>`--resources`<br>`--nodes`<br>`--full`<br>`--verbose`<br>`--limit <n>`<br>`--fields <list>`<br>`--summary`<br>`--filter <key=value>`<br>`--active`<br>`--running`<br>`-A, --all-SoftwareTeams`<br>`--software-team <name>`<br>`--session <name>`<br>`--include-archived`<br>`--host <id>`<br>`--all-hosts`<br>`--hosts <ids>` |

### roster

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam roster` | — | — |
| `SoftwareTeam roster list` | — | `--folder <path>`<br>`--json` |
| `SoftwareTeam roster show <id>` | — | `--folder <path>`<br>`--json` |
| `SoftwareTeam roster find <query>` | — | `--folder <path>`<br>`--json` |

### mcp

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam mcp` | — | — |
| `SoftwareTeam mcp serve` | — | `--port <port>` |

### agent

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam agent` | — | — |
| `SoftwareTeam agent validate <path>` | — | `--json` |

### spec

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam spec` | — | — |
| `SoftwareTeam spec show <software-team-id>` | — | `--json`<br>`--as-template` |
| `SoftwareTeam spec audit <path>` | — | `--json` |
| `SoftwareTeam spec validate <path>` | — | `--json` |
| `SoftwareTeam spec preflight <path>` | — | `--software-team-root <root>`<br>`--json` |

### transcript

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam transcript <session>` | — | `--tail <lines>`<br>`--grep <pattern>`<br>`--host <id>`<br>`--json` |

### send

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam send [session] [text]` | — | `--to <sessions>` (repeatable)<br>`--pod <name>`<br>`--software-team <name>`<br>`--verify`<br>`--force`<br>`--wait-for-idle <seconds>`<br>`--raw`<br>`--dangerously-interact`<br>`--reason <text>`<br>`--host <id>`<br>`--from <session>`<br>`--context <ref>`<br>`--json` |

### stream

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam stream` | — | — |
| `SoftwareTeam stream emit` | — | `--source <session>` **required**<br>`--body <text>` **required**<br>`--hint-destination <session>`<br>`--hint-type <type>`<br>`--hint-urgency <urgency>`<br>`--hint-tags <tags>`<br>`--format <fmt>`<br>`--interrupt`<br>`--id <streamItemId>`<br>`--json` |
| `SoftwareTeam stream list` | — | `--source <session>`<br>`--hint-destination <session>`<br>`--tag <tag>`<br>`--since <iso>`<br>`--until <iso>`<br>`--limit <n>`<br>`--after <sortKey>`<br>`--include-archived`<br>`--json` |
| `SoftwareTeam stream watch` | — | `--json` |
| `SoftwareTeam stream show <streamItemId>` | — | `--json` |
| `SoftwareTeam stream archive <streamItemId>` | — | `--json` |

### queue

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam queue` | — | — |
| `SoftwareTeam queue create` | — | `--source <session>`<br>`--destination <session>` **required**<br>`--body <text>`<br>`--body-file <path>`<br>`--body-context <ref>`<br>`--mission <id>`<br>`--slice <id>`<br>`--gate <role>`<br>`--priority <priority>`<br>`--tier <tier>`<br>`--tags <tags>`<br>`--expires-at <iso>`<br>`--id <qitemId>`<br>`--target-repo <name>`<br>`--summary <text>`<br>`--human-intent <intent>`<br>`--human-detail-file <path>`<br>`--reply-to <qitemId>`<br>`--human-questions-file <path>`<br>`--evidence-ref <path>`<br>`--host <id>`<br>`--no-nudge`<br>`--verify`<br>`--full`<br>`--json` |
| `SoftwareTeam queue claim <qitemId>` | — | `--destination <session>`<br>`--full`<br>`--json` |
| `SoftwareTeam queue unclaim <qitemId>` | — | `--destination <session>`<br>`--reason <text>`<br>`--full`<br>`--json` |
| `SoftwareTeam queue update <qitemId>` | — | `--actor <session>`<br>`--state <state>`<br>`--reopen`<br>`--closure-reason <reason>`<br>`--closure-target <target>`<br>`--resolution <text>`<br>`--blocked-on <blocker>`<br>`--wake-watchdog <jobId>`<br>`--wake-after <duration>`<br>`--summary <text>`<br>`--evidence-ref <path>`<br>`--note <text>`<br>`--full`<br>`--json` |
| `SoftwareTeam queue block <qitemId>` | — | `--on <blocker>` **required**<br>`--actor <session>`<br>`--summary <text>`<br>`--evidence-ref <path>`<br>`--note <text>`<br>`--continuation <text>`<br>`--wake-watchdog <jobId>`<br>`--wake-after <duration>`<br>`--full`<br>`--json` |
| `SoftwareTeam queue resolve <qitemId>` | — | `--decision <text>` **required**<br>`--actor <session>`<br>`--bearer <token>`<br>`--no-notify`<br>`--json` |
| `SoftwareTeam queue handoff <qitemId>` | — | `--from <session>`<br>`--to <session>` **required**<br>`--body <text>`<br>`--body-file <path>`<br>`--note <text>`<br>`--priority <priority>`<br>`--tier <tier>`<br>`--tags <tags>`<br>`--gate <role>`<br>`--target-repo <name>`<br>`--summary <text>`<br>`--evidence-ref <path>`<br>`--host <id>`<br>`--no-nudge`<br>`--full`<br>`--json` |
| `SoftwareTeam queue handoff-and-complete <qitemId>` | — | `--from <session>`<br>`--to <session>` **required**<br>`--body <text>`<br>`--body-file <path>`<br>`--note <text>`<br>`--priority <priority>`<br>`--tier <tier>`<br>`--tags <tags>`<br>`--gate <role>`<br>`--target-repo <name>`<br>`--summary <text>`<br>`--evidence-ref <path>`<br>`--host <id>`<br>`--no-nudge`<br>`--full`<br>`--json` |
| `SoftwareTeam queue whoami` | — | `--session <session>`<br>`--recent-limit <n>`<br>`--json` |
| `SoftwareTeam queue fallback <qitemId>` | — | `--destination <session>` **required**<br>`--reason <text>`<br>`--json` |
| `SoftwareTeam queue show <qitemId>` | — | `--full`<br>`--json` |
| `SoftwareTeam queue transitions <qitemId>` | — | `--json` |
| `SoftwareTeam queue list` | — | `-a, --all`<br>`-A, --all-SoftwareTeams`<br>`--full`<br>`--owned`<br>`--mine`<br>`-o <format>`<br>`--destination <session>`<br>`--source <session>`<br>`--state <state>`<br>`--target-repo <name>`<br>`--limit <n>`<br>`--json` |
| `SoftwareTeam queue overdue` | — | `--software-team <name>`<br>`-A, --all-SoftwareTeams`<br>`--full`<br>`--limit <n>`<br>`--json` |
| `SoftwareTeam queue undelivered` | — | `--software-team <name>`<br>`-A, --all-SoftwareTeams`<br>`--full`<br>`--limit <n>`<br>`--json` |
| `SoftwareTeam queue inbox-drop <destinationSession>` | — | `--sender <session>`<br>`--body <text>`<br>`--body-file <path>`<br>`--tags <tags>`<br>`--urgency <urgency>`<br>`--audit <pointer>`<br>`--id <inboxId>`<br>`--json` |
| `SoftwareTeam queue inbox-absorb <inboxId>` | — | `--receiver <session>` **required**<br>`--json` |
| `SoftwareTeam queue inbox-deny <inboxId>` | — | `--receiver <session>` **required**<br>`--reason <text>` **required**<br>`--json` |
| `SoftwareTeam queue inbox-pending <destinationSession>` | — | `--json` |
| `SoftwareTeam queue outbox-record` | — | `--sender <session>`<br>`--destination <session>` **required**<br>`--body <text>`<br>`--body-file <path>`<br>`--tags <tags>`<br>`--urgency <urgency>`<br>`--audit <pointer>`<br>`--id <outboxId>`<br>`--json` |
| `SoftwareTeam queue outbox-list <senderSession>` | — | `--limit <n>`<br>`--json` |

### slack

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam slack` | — | — |
| `SoftwareTeam slack setup` | — | `--channel <id>`<br>`--inbound-destination <session>`<br>`--minimum-level-that-posts <level>`<br>`--minimum-level-that-interrupts <level>`<br>`--source-label <label>`<br>`--secrets-env-file <path>`<br>`--required-scopes <csv>`<br>`--reason <reason>`<br>`--actor <actor>` |
| `SoftwareTeam slack status` | — | `--json` |
| `SoftwareTeam slack manifest` | — | `--url`<br>`--json` |
| `SoftwareTeam slack verify` | — | `--json`<br>`--reason <reason>`<br>`--actor <actor>` |
| `SoftwareTeam slack channel-map` | — | — |
| `SoftwareTeam slack channel-map list` | — | `--json` |
| `SoftwareTeam slack channel-map set <match> <channel>` | — | `--reason <reason>`<br>`--actor <actor>` |
| `SoftwareTeam slack channel-map remove <match>` | — | `--reason <reason>`<br>`--actor <actor>` |
| `SoftwareTeam slack enable` | — | `--reason <reason>`<br>`--actor <actor>` |
| `SoftwareTeam slack disable` | — | `--reason <reason>` **required**<br>`--actor <actor>` |
| `SoftwareTeam slack outbound` | — | `--json` |
| `SoftwareTeam slack inbound` | — | — |

### project

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam project` | — | — |
| `SoftwareTeam project experimental` | — | — |
| `SoftwareTeam project experimental enable` | — | `--config <file>` **required**<br>`--max-requests <n>`<br>`--timeout-ms <n>`<br>`--json` |
| `SoftwareTeam project experimental disable` | — | `--config <file>` **required**<br>`--max-requests <n>`<br>`--timeout-ms <n>`<br>`--json` |
| `SoftwareTeam project experimental status` | — | `--config <file>` **required**<br>`--max-requests <n>`<br>`--timeout-ms <n>`<br>`--json` |
| `SoftwareTeam project experimental capture` | — | `--config <file>` **required**<br>`--input <file>` **required**<br>`--output <file>` **required**<br>`--json` |
| `SoftwareTeam project candidates` | — | `--project <id>` **required**<br>`--taxonomy <file>` **required**<br>`--classifier-version <version>` **required**<br>`--evidence-epoch <epoch>` **required**<br>`--decisions <file>`<br>`--experiment <file>`<br>`--limit <count>`<br>`--json` |
| `SoftwareTeam project wake` | — | `--project <id>` **required**<br>`--taxonomy <file>` **required**<br>`--classifier-version <version>` **required**<br>`--evidence-epoch <epoch>` **required**<br>`--decisions <file>`<br>`--experiment <file>`<br>`--limit <count>`<br>`--json` |
| `SoftwareTeam project shadow-status` | — | — |
| `SoftwareTeam project shadow-drain` | — | `--actor <name>` |
| `SoftwareTeam project shadow-stop` | — | `--actor <name>` |
| `SoftwareTeam project lease-acquire` | — | `--session <session>` **required**<br>`--evaluate-deadness-first`<br>`--json` |
| `SoftwareTeam project lease-heartbeat` | — | `--lease-id <id>` **required**<br>`--session <session>` **required**<br>`--json` |
| `SoftwareTeam project lease-show` | — | `--json` |
| `SoftwareTeam project reclaim-classifier` | — | `--session <session>` **required**<br>`--if-dead`<br>`--reason <text>`<br>`--json` |
| `SoftwareTeam project classify <streamItemId>` | — | `--session <session>` **required**<br>`--lease-id <id>` **required**<br>`--attempt-id <id>`<br>`--execution-id <id>`<br>`--type <type>`<br>`--urgency <urgency>`<br>`--maturity <maturity>`<br>`--confidence <confidence>`<br>`--destination <destination>`<br>`--action <action>`<br>`--area <area>`<br>`--scope-ref <id>`<br>`--duplicate-of <streamItemId>`<br>`--needs-human <value>`<br>`--classifier-version <v>`<br>`--taxonomy-version <v>`<br>`--candidate-set-version <v>`<br>`--json` |
| `SoftwareTeam project list` | — | `--session <session>`<br>`--destination <destination>`<br>`--area <area>`<br>`--scope-ref <id>`<br>`--needs-human <value>`<br>`--limit <n>`<br>`--json` |
| `SoftwareTeam project show <projectId>` | — | `--json` |

### view

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam view` | — | — |
| `SoftwareTeam view list` | — | `--json` |
| `SoftwareTeam view show <viewName>` | — | `--software-team <SoftwareTeam>`<br>`--limit <n>`<br>`--mission <id>`<br>`--project <name>`<br>`--json` |
| `SoftwareTeam view register` | — | `--name <name>` **required**<br>`--definition <sql>` **required**<br>`--session <session>` **required**<br>`--json` |

### terminal

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam terminal` | — | — |
| `SoftwareTeam terminal open <view>` | — | `--provider <name>`<br>`--window`<br>`--expected-plan <id>`<br>`--json` |
| `SoftwareTeam terminal views` | — | `--json` |
| `SoftwareTeam terminal status` | — | `--provider <name>`<br>`--json` |

### watchdog

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam watchdog` | — | — |
| `SoftwareTeam watchdog register` | — | `--spec <path>`<br>`--policy <policy>` **required**<br>`--target-session <session>` **required**<br>`--interval-seconds <n>` **required**<br>`--registered-by <session>` **required**<br>`--threshold-bytes <n>`<br>`--threshold-mb <n>`<br>`--watched-file <path>`<br>`--requires-job <jobId>`<br>`--message <text>`<br>`--active-wake-interval-seconds <n>`<br>`--scan-interval-seconds <n>`<br>`--json` |
| `SoftwareTeam watchdog list` | — | `-a, --all`<br>`--full`<br>`--limit <n>`<br>`--json` |
| `SoftwareTeam watchdog show <jobId>` | — | `--json` |
| `SoftwareTeam watchdog status <jobId>` | — | `--json` |
| `SoftwareTeam watchdog stop <jobId>` | — | `--reason <text>`<br>`--json` |

### workflow

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam workflow` | — | — |
| `SoftwareTeam workflow validate <specPath>` | — | `--json` |
| `SoftwareTeam workflow compile <missionPath>` | — | `--operation-key <key>`<br>`--json` |
| `SoftwareTeam workflow revise <instanceId>` | — | `--apply`<br>`--expected-version <number>`<br>`--expected-digest <sha256>`<br>`--operation-key <key>`<br>`--actor-session <session>`<br>`--reason <text>`<br>`--json` |
| `SoftwareTeam workflow operation <key>` | — | `--json` |
| `SoftwareTeam workflow instantiate-lifecycle <missionPath>` | — | `--operation-key <key>` **required**<br>`--root-objective <text>` **required**<br>`--created-by <session>` **required**<br>`--entry-owner <session>`<br>`--software-team <name>`<br>`--json` |
| `SoftwareTeam workflow instantiate <specPath>` | — | `--root-objective <text>` **required**<br>`--created-by <session>` **required**<br>`--entry-owner <session>`<br>`--software-team <name>`<br>`--project <id>`<br>`--mission <id>`<br>`--slice <id>`<br>`--tags <tags>`<br>`--json` |
| `SoftwareTeam workflow project` | — | `--instance <id>` **required**<br>`--current-packet <qitem-id>` **required**<br>`--exit <kind>` **required**<br>`--actor-session <session>` **required**<br>`--result-note <text>`<br>`--evidence-ref <ref>`<br>`--wait-for-proof <scope>`<br>`--blocked-on <ref>`<br>`--next-owner <session>`<br>`--acceptance-candidate <identity>`<br>`--acceptance-verdict <verdict>`<br>`--acceptance-evidence-ref <path>`<br>`--json` |
| `SoftwareTeam workflow list` | — | `--status <s>`<br>`--json` |
| `SoftwareTeam workflow specs` | — | `--json` |
| `SoftwareTeam workflow guidance <instanceId>` | — | `--packet <id>`<br>`--component <id>`<br>`--full`<br>`--json` |
| `SoftwareTeam workflow show <instanceId>` | — | `--json` |
| `SoftwareTeam workflow trace <instanceId>` | — | `--json` |
| `SoftwareTeam workflow continue <instanceId>` | — | `--json` |
| `SoftwareTeam workflow run <specPath>` | — | `--root-objective <text>` **required**<br>`--created-by <session>` **required**<br>`--entry-owner <session>`<br>`--software-team <name>`<br>`--project <id>`<br>`--mission <id>`<br>`--slice <id>`<br>`--tags <tags>`<br>`--json` |
| `SoftwareTeam workflow watch <instanceId>` | — | `--json` |
| `SoftwareTeam workflow route <instanceId>` | — | `--to <session>` **required**<br>`--actor-session <session>` **required**<br>`--packet <qitem-id>`<br>`--reason <text>`<br>`--json` |
| `SoftwareTeam workflow resume <instanceId>` | — | `--actor-session <session>` **required**<br>`--occurrence <failed-qitem-id>`<br>`--decision <text>`<br>`--json` |
| `SoftwareTeam workflow abort <instanceId>` | — | `--reason <text>` **required**<br>`--actor-session <session>` **required**<br>`--json` |
| `SoftwareTeam workflow status` | — | `--json` |

### capture

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam capture [session]` | — | `--software-team <name>`<br>`--pod <name>`<br>`--lines <n>`<br>`--host <id>`<br>`--json` |

### broadcast

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam broadcast [text]` | — | `--software-team <name>`<br>`--pod <name>`<br>`--force`<br>`--host <id>`<br>`--context <ref>`<br>`--json` |

### walk

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam walk <seat>` | — | `--through <items...>`<br>`--through-profile <ref>`<br>`--situation <situation>`<br>`--runtime <runtime>`<br>`--profile <profile>`<br>`--software-team <SoftwareTeam>`<br>`--seat-grant <seat>`<br>`--mission <mission>`<br>`--slice <slice>`<br>`--budget <tokens>`<br>`--pace <duration>`<br>`--consume-timeout <duration>`<br>`--consume-poll <duration>`<br>`--turn-timeout <duration>`<br>`--json` |

### ask

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam ask <SoftwareTeam> <question>` | — | `--json`<br>`--seat <session-name>`<br>`--session <token>`<br>`--wake <target>`<br>`--runtime <runtime>`<br>`--wake-timeout <seconds>` |

Wake seat targets must include the SoftwareTeam: `member@software-team` or `member@software-team@N` (1 = newest tenure).
Values without `@` go unchanged to the runtime as a session ID or title; a bare member
name is not resolved within `<SoftwareTeam>`.

### chatroom

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam chatroom` | — | — |
| `SoftwareTeam chatroom send <SoftwareTeam> <message>` | — | `--sender <name>` |
| `SoftwareTeam chatroom history <SoftwareTeam>` | — | `--topic <name>`<br>`--after <id>`<br>`--since <timestamp>`<br>`--sender <name>`<br>`--limit <n>`<br>`--json` |
| `SoftwareTeam chatroom watch <SoftwareTeam>` | — | `--tmux` |
| `SoftwareTeam chatroom topic <SoftwareTeam> <topic-name>` | — | `--body <text>`<br>`--sender <name>` |
| `SoftwareTeam chatroom wait <SoftwareTeam>` | — | `--after <id>`<br>`--topic <name>`<br>`--sender <name>`<br>`--timeout <seconds>`<br>`--json` |
| `SoftwareTeam chatroom clear <SoftwareTeam>` | — | — |

### specs

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam specs` | — | — |
| `SoftwareTeam specs ls` | — | `--kind <kind>`<br>`--json` |
| `SoftwareTeam specs show <name-or-id>` | — | `--kind <kind>`<br>`--json` |
| `SoftwareTeam specs preview <name-or-id>` | — | `--kind <kind>`<br>`--json` |
| `SoftwareTeam specs add <path>` | — | `--json` |
| `SoftwareTeam specs sync` | — | `--json` |
| `SoftwareTeam specs remove <name-or-id>` | — | `--json` |
| `SoftwareTeam specs rename <name-or-id> <new-name>` | — | `--json` |

### context

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam context` | — | — |
| `SoftwareTeam context work-install` | — | `--project <id>`<br>`--mission <id>`<br>`--slice <id>`<br>`--deliver`<br>`--runtime <runtime>`<br>`--cwd <path>`<br>`--topology <ids>`<br>`--apply-skills`<br>`--json` |
| `SoftwareTeam context trace` | — | `--software-team <SoftwareTeam>` **required**<br>`--pod <pod>`<br>`--seat <seat>`<br>`--name <file>` **required**<br>`--json` |
| `SoftwareTeam context compose` | — | `--out <ref>` **required**<br>`--from <files...>` **required** |
| `SoftwareTeam context list` | — | `--json` |
| `SoftwareTeam context show <name-or-ref>` | — | `--json` |
| `SoftwareTeam context preview <name-or-ref>` | — | `--json` |
| `SoftwareTeam context get <name-or-ref>` | — | `--json` |
| `SoftwareTeam context profile <name-or-ref>` | — | `--situation <situation>` **required**<br>`--runtime <runtime>`<br>`--profile <profile>`<br>`--budget <tokens>`<br>`--software-team <SoftwareTeam>`<br>`--seat <seat>`<br>`--mission <mission>`<br>`--slice <slice>`<br>`--json` |
| `SoftwareTeam context recap-write` | — | `--software-team <SoftwareTeam>` **required**<br>`--seat <seat>` **required**<br>`--file <path>` **required** |
| `SoftwareTeam context sync` | — | `--json` |
| `SoftwareTeam context add <source>` | — | `--name <name>`<br>`--git`<br>`--checkout`<br>`--pack <path>`<br>`--json` |
| `SoftwareTeam context source` | — | — |
| `SoftwareTeam context source inspect <ref>` | — | `--json` |
| `SoftwareTeam context source update <ref>` | — | `--json` |
| `SoftwareTeam context rm <ref>` | — | `--json` |

### plugin

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam plugin` | — | — |
| `SoftwareTeam plugin list` | — | `--runtime <runtime>`<br>`--source <source>`<br>`--json` |
| `SoftwareTeam plugin show <id>` | — | `--json` |
| `SoftwareTeam plugin used-by <id>` | — | `--json` |
| `SoftwareTeam plugin validate <path>` | — | `--json` |

### skill

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam skill` | — | — |
| `SoftwareTeam skill loadout` | — | `--runtime <runtime>` **required**<br>`--cwd <path>`<br>`--project-root <path>`<br>`--topology <ids>`<br>`--apply`<br>`--json` |
| `SoftwareTeam skill audit` | — | `--json` |

### agent-image

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam agent-image` | — | — |
| `SoftwareTeam agent-image list` | — | `--runtime <runtime>`<br>`--json` |
| `SoftwareTeam agent-image show <name-or-id>` | — | `--json` |
| `SoftwareTeam agent-image preview <name-or-id>` | — | `--json` |
| `SoftwareTeam agent-image create <source-session>` | — | `--name <name>` **required**<br>`--image-version <version>`<br>`--notes <text>`<br>`--estimated-tokens <n>`<br>`--lineage <names...>`<br>`--json` |
| `SoftwareTeam agent-image delete <name-or-id>` | — | `--force`<br>`--json` |
| `SoftwareTeam agent-image pin <name-or-id>` | — | `--json` |
| `SoftwareTeam agent-image unpin <name-or-id>` | — | `--json` |
| `SoftwareTeam agent-image prune` | — | `--dry-run`<br>`--force`<br>`--json` |
| `SoftwareTeam agent-image sync` | — | `--json` |

### fork

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam fork <source-session>` | — | `--software-team <software-team-id>` **required**<br>`--pod <pod-namespace>` **required**<br>`--member <member-id>` **required**<br>`--keep-image`<br>`--image-name <name>`<br>`--image-version <version>`<br>`--software-team-root <path>`<br>`--json` |

### workspace

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam workspace` | — | — |
| `SoftwareTeam workspace validate [root]` | — | `--kind <kind>`<br>`--no-recursive`<br>`--require-frontmatter`<br>`--max-files <n>`<br>`--json` |
| `SoftwareTeam workspace doctor` | — | `--workspace <path>`<br>`--json`<br>`--strict` |

### mode

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam mode` | — | — |
| `SoftwareTeam mode set <mode>` | — | `--scope <scope>`<br>`--qualifier <id>`<br>`--autonomy-scope <v>`<br>`--heartbeat-cadence <v>`<br>`--inspection-depth <v>`<br>`--update-detail <v>`<br>`--escalation-threshold <v>`<br>`--concurrency-limit <v>`<br>`--permission-prompt-posture <v>`<br>`--expiry-or-stale-rule <v>`<br>`--evidence <citation>`<br>`--confirm`<br>`--bearer <token>`<br>`--json` |
| `SoftwareTeam mode show` | — | `--json` |
| `SoftwareTeam mode effective` | — | `--software-team <id>`<br>`--project <id>`<br>`--mission <id>`<br>`--workstream <id>`<br>`--qitem <id>`<br>`--json` |
| `SoftwareTeam mode cite` | — | `--software-team <id>`<br>`--project <id>`<br>`--mission <id>`<br>`--workstream <id>`<br>`--qitem <id>` |
| `SoftwareTeam mode unset <scope> [qualifier]` | — | `--bearer <token>`<br>`--json` |
| `SoftwareTeam mode defaults` | — | `--json` |

### policy

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam policy` | — | — |
| `SoftwareTeam policy permissions` | — | — |
| `SoftwareTeam policy permissions list` | — | `--spec <path>`<br>`--json` |
| `SoftwareTeam policy permissions show <nameOrRef>` | — | `--spec <path>`<br>`--json` |
| `SoftwareTeam policy permissions current` | — | `--spec <path>` **required**<br>`--json` |
| `SoftwareTeam policy permissions apply <name>` | — | `--spec <path>`<br>`--seat <seat>`<br>`--reason <text>`<br>`--operator <address>`<br>`--json` |
| `SoftwareTeam policy list` | — | `--spec <path>`<br>`--json` |
| `SoftwareTeam policy show <nameOrRef>` | — | `--spec <path>`<br>`--json` |
| `SoftwareTeam policy current` | — | `--spec <path>` **required**<br>`--json` |
| `SoftwareTeam policy apply <name>` | — | `--spec <path>`<br>`--seat <seat>`<br>`--reason <text>`<br>`--operator <address>`<br>`--json` |

### whoami

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam whoami` | — | `--node-id <id>`<br>`--session <name>`<br>`--host <id>`<br>`--all-hosts`<br>`--hosts <ids>`<br>`--json`<br>`--full`<br>`--verbose` |

### config

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam config` | — | `--json`<br>`--with-source` |
| `SoftwareTeam config get <key>` | — | `--json`<br>`--show-source` |
| `SoftwareTeam config set <key> <value>` | — | — |
| `SoftwareTeam config reset [key]` | — | — |
| `SoftwareTeam config init-workspace` | — | `--root <path>`<br>`--force`<br>`--dry-run`<br>`--json` |

- `init-workspace` — `SoftwareTeam config init-workspace` creates missing `missions/`, `exhaust/`, `SPEC.md`, `project.yaml`, `workspace.yaml`, and `.gitignore` entries at the configured workspace root (or `--root <path>`). Initialization is additive and preserves existing files; a complete six-entry scaffold is a no-op. `--force` is deprecated compatibility and still preserves existing files. `--dry-run` reports planned additions without writing; incompatible path types are reported before any writes.

### file

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam file` | — | — |
| `SoftwareTeam file copy <src> <dst>` | — | `--dry-run`<br>`--json` |

### preflight

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam preflight` | — | `--json` |

### auth

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam auth` | — | — |
| `SoftwareTeam auth status` | — | `--runtime <runtime>` |
| `SoftwareTeam auth list` | — | `--runtime <runtime>` |
| `SoftwareTeam auth save <profile>` | — | `--runtime <runtime>` |
| `SoftwareTeam auth switch <profile>` | — | `--runtime <runtime>` |
| `SoftwareTeam auth validate <profile>` | — | `--runtime <runtime>` |
| `SoftwareTeam auth seats` | — | — |
| `SoftwareTeam auth seats list` | — | `--runtime <runtime>` |
| `SoftwareTeam auth seats show <seat>` | — | `--runtime <runtime>` |
| `SoftwareTeam auth seats set` | — | `--runtime <runtime>`<br>`--seat <seat>` **required**<br>`--software-team <SoftwareTeam>` **required**<br>`--cwd <cwd>`<br>`--profile <profile>` |
| `SoftwareTeam auth seats report` | — | `--runtime <runtime>` |

### provider

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam provider` | — | — |
| `SoftwareTeam provider status` | — | `--json`<br>`--refresh`<br>`--provider <p>` |
| `SoftwareTeam provider accounts` | — | `--json`<br>`--provider <p>`<br>`--account <a>` |
| `SoftwareTeam provider bindings` | — | `--json`<br>`--provider <p>`<br>`--account <a>` |
| `SoftwareTeam provider signals` | — | `--json`<br>`--provider <p>`<br>`--account <a>` |
| `SoftwareTeam provider precheck` | — | `--seat <s>` **required**<br>`--to-account <a>` **required**<br>`--json` |
| `SoftwareTeam provider switch` | — | `--seat <s>` **required**<br>`--to-account <a>` **required**<br>`--force-unsafe`<br>`--json` |

### usage

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam usage` | — | — |
| `SoftwareTeam usage top` | — | `--window <duration>`<br>`--top <n>`<br>`--json` |
| `SoftwareTeam usage series` | — | `--seat <session>`<br>`--lane <lane>`<br>`--since <iso>`<br>`--until <iso>`<br>`--limit <n>`<br>`--json` |

### telemetry

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam telemetry` | — | — |
| `SoftwareTeam telemetry events` | — | `--cursor <token>`<br>`--limit <n>`<br>`--json`<br>`--start <mode>`<br>`--node <id>`<br>`--software-team <id>` |
| `SoftwareTeam telemetry transitions` | — | `--cursor <token>`<br>`--limit <n>`<br>`--json`<br>`--start <mode>`<br>`--qitem <id>` |
| `SoftwareTeam telemetry tenures <node-id>` | — | `--cursor <token>`<br>`--limit <n>`<br>`--json` |

### health

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam health` | — | `--self`<br>`--seat <node-id>`<br>`--software-team <software-team-id>`<br>`--instance [instance-id]`<br>`--severity <severity>`<br>`--status <status>`<br>`--limit <count>`<br>`--json`<br>`--actor <name>` |
| `SoftwareTeam health explain <finding-id>` | — | `--json` |
| `SoftwareTeam health policy` | — | `--file <path>`<br>`--json` |
| `SoftwareTeam health checkpoint` | — | `--file <path>`<br>`--json` |
| `SoftwareTeam health diagnose` | — | `--apply`<br>`--json` |
| `SoftwareTeam health diagnosis` | — | — |
| `SoftwareTeam health diagnosis list` | — | `--json`<br>`--full` |
| `SoftwareTeam health diagnosis show <qitem-id>` | — | `--json`<br>`--full` |
| `SoftwareTeam health diagnosis record <qitem-id>` | — | `--file <path>` **required**<br>`--json` |
| `SoftwareTeam health diagnosis notify <qitem-id>` | — | `--json` |

### doctor

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam doctor` | — | `--json`<br>`--spec <path>` |

### expand

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam expand <software-team-id> <pod-fragment-path>` | — | `--json`<br>`--software-team-root <path>` |

### add

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam add <SoftwareTeam> <pod-namespace> <member-fragment-path>` | — | `--json`<br>`--software-team-root <path>` |

### create

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam create <name>` | — | `--runtime <runtime>`<br>`--cwd <path>`<br>`--json` |

### grow

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam grow <software-team-id> <members...>` | — | `--pod <pod>`<br>`--new-pod <pod>`<br>`--runtime <runtime>`<br>`--cwd <path>`<br>`--json` |

### reconcile-session

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam reconcile-session <session>` | — | `--software-team <softwareTeamId>`<br>`--node <logicalId>`<br>`--no-launch`<br>`--json` |

### env

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam env` | — | — |
| `SoftwareTeam env status <SoftwareTeam>` | — | `--json` |
| `SoftwareTeam env logs <SoftwareTeam> [service]` | — | `--tail <n>` |
| `SoftwareTeam env down <SoftwareTeam>` | — | `--volumes` |

### unclaim

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam unclaim <sessionRef>` | — | `--json` |

### release

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam release <softwareTeamId>` | — | `--delete`<br>`--json` |

### launch

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam launch <SoftwareTeam> [nodeRef]` | — | `--seats <ids>`<br>`--hold-reason <reason>`<br>`--snapshot-id <id>`<br>`--retry-startup-from <member-file>`<br>`--software-team-root <path>`<br>`--plan`<br>`--json`<br>`--host <id>` |

### remove

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam remove <softwareTeamId> <nodeRef>` | — | `--fallback <live-seat>`<br>`--json` |

### shrink

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam shrink <softwareTeamId> <podRef>` | — | `--fallback <live-seat>`<br>`--json` |

### destroy

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam destroy` | — | `--state`<br>`--all`<br>`--backup`<br>`--yes`<br>`--confirm <token>` |

### setup

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam setup` | — | `--dry-run`<br>`--json`<br>`--full`<br>`--no-herdr`<br>`--ghostty`<br>`--no-ghostty`<br>`--providers <list>`<br>`--policy <name>`<br>`--spec <path>` |

### restore-check

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam restore-check` | — | `--json`<br>`--full`<br>`--ready`<br>`--software-team <name>`<br>`--no-queue`<br>`--no-hooks` |

### restore-packet

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam restore-packet` | — | — |
| `SoftwareTeam restore-packet write` | — | `--source-session <session>`<br>`--source-jsonl <path>`<br>`--source-runtime <runtime>`<br>`--target <dir>` **required**<br>`--target-SoftwareTeam <SoftwareTeam>`<br>`--target-runtime <runtime>`<br>`--target-workspace-root <path>`<br>`--default-target-repo <path>`<br>`--role-pointer <path>`<br>`--current-work-summary <text>`<br>`--next-owner <name>`<br>`--caveat <text>` (repeatable)<br>`--authority-boundaries <text>`<br>`--source-trust-ranking <csv>`<br>`--generator-version <version>`<br>`--source-session-id-override <id>`<br>`--source-software-team-override <SoftwareTeam>` |
| `SoftwareTeam restore-packet read <packet-dir>` | — | `--json` |
| `SoftwareTeam restore-packet validate <packet-dir>` | — | `--json` |

### compact-plan

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam compact-plan` | — | `--json`<br>`--software-team <name>`<br>`--refresh`<br>`--threshold-tokens <n>`<br>`--threshold-percent <0-100>` |

### compact

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam compact <session>` | — | `--json`<br>`--skip-map`<br>`--cancel`<br>`--state` |

### heartbeat

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam heartbeat` | — | `--software-team <name>`<br>`--json`<br>`--nudge`<br>`--include-done` |

### seat

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam seat` | — | — |
| `SoftwareTeam seat set-typing-guard <seat>` | — | `--enabled <boolean>` **required**<br>`--reason <text>` **required**<br>`--json` |
| `SoftwareTeam seat held-messages <seat>` | — | `--limit <n>`<br>`--offset <n>`<br>`--id <id>`<br>`--json` |
| `SoftwareTeam seat retire-held-message <seat> <id>` | — | `--reason <text>` **required**<br>`--json` |
| `SoftwareTeam seat status <seat>` | — | `--json` |
| `SoftwareTeam seat handover <seat>` | — | `--source <source>`<br>`--reason <reason>`<br>`--operator <address>`<br>`--dry-run`<br>`--json` |
| `SoftwareTeam seat switch-client <seat>` | — | `--to-window <n>`<br>`--client <id>`<br>`--json` |
| `SoftwareTeam seat clear-attention <session>` | — | `--reason <text>`<br>`--json` |
| `SoftwareTeam seat set-permissions <seat>` | — | `--mode <mode>` **required**<br>`--reason <text>` **required**<br>`--operator <address>`<br>`--json` |
| `SoftwareTeam seat set-model <seat>` | — | `--model <id>` **required**<br>`--reason <text>` **required**<br>`--operator <address>`<br>`--json` |
| `SoftwareTeam seat launch <seat>` | — | `--fresh` **required**<br>`--reason <text>` **required**<br>`--stop`<br>`--operator <address>`<br>`--json` |
| `SoftwareTeam seat continue <seat>` | — | `--json` |
| `SoftwareTeam seat stop <seat>` | — | `--reason <text>` **required**<br>`--operator <address>`<br>`--json` |
| `SoftwareTeam seat clean <seat>` | — | `--reason <text>` **required**<br>`--operator <address>`<br>`--json` |
| `SoftwareTeam seat set-resume-token <session>` | — | `--token-stdin`<br>`--reason <text>` **required**<br>`--json` |

A `SoftwareTeam seat stop` that successfully kills the current session records that it
was intentionally stopped. With other healthy members running, the SoftwareTeam's `lifecycleState` in
`SoftwareTeam ps` and the TUI stays `running`; the stopped member no longer makes it
`degraded`. Stopping every member
leaves the SoftwareTeam `stopped`. Node JSON exposes `intentionallyStopped` in compact,
`--full`, and `--fields` output.

Process counts still reflect reality: stopping one of two members leaves
`nodeCount: 2`, `runningCount: 1`, and process `status: partial`. Node lifecycle,
resume information, and attention diagnostics remain available. A crash or
attention condition on another member still affects the SoftwareTeam lifecycle.

Stop intent survives daemon restarts and audit retention. It applies only to the
latest exited session while the seat has no binding; a subsequent session status
change clears it, and a new session starts without it. Existing exits are not
backfilled as intentional stops. If the session disappears between the live
probe and the stop, its unexplained exit still affects SoftwareTeam health. The internal
stop in `SoftwareTeam seat launch --fresh --stop` does not record final stop intent, so a
refused replacement still degrades a SoftwareTeam with other healthy members running.

`SoftwareTeam start --last` and `SoftwareTeam start --software-teams <SoftwareTeam>` use the full per-seat lifecycle
for restore selection. A partly running SoftwareTeam with an intentionally stopped member
still appears as a `degraded` candidate and reports `software_team_not_stopped` (exit 1)
when restore is attempted. Launch scheduling and restore eligibility remain
unchanged.

### handover

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam handover <seat>` | — | `--source <source>`<br>`--reason <reason>`<br>`--operator <address>`<br>`--dry-run`<br>`--json` |

### startup-proof

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam startup-proof` | — | — |
| `SoftwareTeam startup-proof submit` | — | `--challenge-id <id>` **required**<br>`--answer <answer>` **required**<br>`--json` |

### scope

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam scope` | — | `--workspace <path>` |
| `SoftwareTeam scope slice` | — | — |
| `SoftwareTeam scope slice ls` | — | `--mission <name>`<br>`--state <state>`<br>`--json` |
| `SoftwareTeam scope slice show <slice-path>` | — | `--mission <name>`<br>`--json` |
| `SoftwareTeam scope slice create <mission> <slug>` | — | `--template <kind>`<br>`--title <text>`<br>`--intent <text>`<br>`--depends-on <dot-id...>`<br>`--readme-only`<br>`--json` |
| `SoftwareTeam scope slice ship <slice-path> <release-mission>` | — | `--mission <name>`<br>`--json` |
| `SoftwareTeam scope slice close <slice-path>` | — | `--reason <reason>` **required**<br>`--note <text>`<br>`--mission <name>`<br>`--json` |
| `SoftwareTeam scope slice move <slice-path> <dest-mission>` | — | `--mission <name>`<br>`--json` |
| `SoftwareTeam scope slice progress <slice-path>` | — | `--mission <name>`<br>`--add <text>`<br>`--set <text>`<br>`--section <heading>`<br>`--status <status>`<br>`--json` |
| `SoftwareTeam scope slice repair <slice-path>` | — | `--mission <name>`<br>`--json` |
| `SoftwareTeam scope slice stage <slice-path> <new-stage>` | — | `--successor <id>`<br>`--mission <name>`<br>`--json` |
| `SoftwareTeam scope slice verified <slice-path>` | — | `--against <source>`<br>`--mission <name>`<br>`--json` |
| `SoftwareTeam scope slice approve <slice-path>` | — | `--mission <name>`<br>`--scope <scope>`<br>`--actor <session>`<br>`--on-behalf-of <human>`<br>`--re-approve`<br>`--reason <why>`<br>`--locked-artifacts <paths>`<br>`--json` |
| `SoftwareTeam scope mission` | — | — |
| `SoftwareTeam scope mission ls` | — | `--json` |
| `SoftwareTeam scope mission show <mission>` | — | `--json` |
| `SoftwareTeam scope mission create <name>` | — | `--template <kind>`<br>`--id <dot-id>`<br>`--title <text>`<br>`--intent <text>`<br>`--depends-on <dot-id...>`<br>`--no-notes`<br>`--no-mission-notes`<br>`--json` |
| `SoftwareTeam scope mission graph <mission>` | — | `--json` |
| `SoftwareTeam scope mission progress <mission>` | — | `--add <text>`<br>`--set <text>`<br>`--section <heading>`<br>`--status <status>`<br>`--json` |
| `SoftwareTeam scope mission repair <mission>` | — | `--json` |
| `SoftwareTeam scope mission stage <mission> <new-stage>` | — | `--successor <id>`<br>`--json` |
| `SoftwareTeam scope mission verified <mission>` | — | `--against <source>`<br>`--json` |
| `SoftwareTeam scope mission approve <mission>` | — | `--mission <name>`<br>`--scope <scope>`<br>`--actor <session>`<br>`--on-behalf-of <human>`<br>`--re-approve`<br>`--reason <why>`<br>`--locked-artifacts <paths>`<br>`--json` |
| `SoftwareTeam scope resolve-notes <absolute-work-node-dir>` | — | `--json` |
| `SoftwareTeam scope audit` | — | `--mission <name>` **required**<br>`--json` |

### proof

| Invocation | Aliases | Declared options |
|---|---|---|
| `SoftwareTeam proof` | — | `--workspace <path>` |
| `SoftwareTeam proof show [scope]` | — | `--json` |
| `SoftwareTeam proof judge <scope-item>` | — | `--verdict <verdict>` **required**<br>`--reason <text>` **required**<br>`--evidence <ref>` (repeatable)<br>`--subject <kind:ref>`<br>`--comparison <ref>`<br>`--revision <revision>`<br>`--operation-id <id>`<br>`--replace`<br>`--json` |
| `SoftwareTeam proof add <slice-path>` | — | `--mission <name>`<br>`--artifact-type <type>` **required**<br>`--verdict <verdict>` **required**<br>`--candidate-sha <sha>` **required**<br>`--money-evidence <line>` **required**<br>`--slice-id <dot-id>`<br>`--file <path>`<br>`--body <text>`<br>`--name <filename>`<br>`--replace`<br>`--evidences <refs>`<br>`--self-check <text>`<br>`--media <refs>`<br>`--json` |
