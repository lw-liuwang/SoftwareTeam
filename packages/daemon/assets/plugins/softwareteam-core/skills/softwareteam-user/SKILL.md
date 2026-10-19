---
name: softwareteam-user
description: >-
  Use when a specific `SoftwareTeam` command, subcommand, or flag is already known and you need its exact
  syntax, JSON shape, defaults, or error meaning. NOT for natural capability discovery, open-ended
  how-do-I questions, or choosing which SoftwareTeam move applies.
---

# SoftwareTeam User

This is an as-built guide to the shipped `SoftwareTeam` CLI.
Use current code and `SoftwareTeam ... --help` as ground truth if anything here ever conflicts with older planning docs.

Use the SoftwareTeam builder guidance when changing SoftwareTeam behavior, doctrine, or release posture.


## Coordination trust boundary

Coordinate as openly as the trust boundary you actually control allows. Within a set of machines you
own that already trust each other — they can reach each other's daemon URLs and the daemon itself
requires no authentication — direct `SoftwareTeam send`, `SoftwareTeam capture`, and `SoftwareTeam queue` should just work.
Don't invent bearer placeholders, allowlists, trust handshakes, or guest-reach restrictions the
environment doesn't require.

Do not add or defend a restriction without naming the protected asset, the actual adversary, the
blocked attack path, and the concrete consequence. Missing capability is not protection — repair the
route, registration, runtime posture, or product defect directly. Arbitrary boundaries create
constraint-induced circumvention: under goal pressure, agents build shadow transports, alternate
credentials, and weaker proof instead of the direct authorized path. Keep only explicitly stated
external or irreversible boundaries — public push / PR / publish, and destruction of canonical data.

## Coordination primitives — when to use which

Three coordination surfaces, used together for forward-momentum work. Internalize this
on first read — it shapes every turn you take in a SoftwareTeam.

### `SoftwareTeam send <seat> "<text>"` — intra-pod direct messaging / nudges

Use when you need to ask a quick question or give a teammate context that does not
carry handoff semantics. **NOT for durable work.** NOT for state that must survive
across turns. The message lands in the target's pane; there is no durable queue
record. The CLI prints `Sent to ...` (and `Verified: yes/no` with `--verify`); read
the receipt and move on.

Example:

```bash
SoftwareTeam send dev-reviewer@example-project "The import report is ready; the durable handoff names its evidence." --verify
```

### `SoftwareTeam queue create --destination <Y> --tags <...> --body-file <path>` — durable work item

Use for any substantive work that must not fall through chat — slice handoffs,
guard verdicts, QA results, full-tip reviews, multi-item batches. Survives agent
restarts. Tracked in the daemon SQLite schema. Surfaces in Project / queue views
+ in the destination seat's inbox. Tag with mission / slice / gate / checkpoint
so future-you (and any peer) can find it. Give the row a `--summary` (its subject, wherever the row is listed)
and the `project:`, `mission:` and `slice:` tags when it is project work.

Body discipline: substantive bodies go through **`--body-file <path>`** (or `-` for stdin) — the
purpose-built, corruption-safe surface (it kills the backtick-shell-corruption class for multi-line
bodies). Do NOT inline a backtick-heavy or multi-line body via `--body`: `SoftwareTeam queue create` body
parsing breaks on unescaped backticks and rejects flag-like tokens.

Example:

```bash
SoftwareTeam queue create \
  --destination dev-reviewer@example-project \
  --summary "Review the import report: it changes how rows are deduplicated" \
  --tags "project:example-project,mission:data-import,slice:import-report" \
  --body-file /tmp/import-report-handoff.md
```

### `SoftwareTeam queue handoff <qitem-id> --to <next> ...` — hot-potato handoff

Use when you have completed your turn on a qitem and the work moves to the next
owner. **This is forward momentum.** The ball passes to the destination seat;
chain-of-record (the prior qitem id) is preserved so the verdict trail is intact;
tags carry the selected work context forward. Gate tags describe checks actually
selected for that work; they do not require a fixed sequence of roles.

Example:

```bash
SoftwareTeam queue handoff <qitem-id> \
  --to dev-reviewer@example-project \
  --summary "Review the import report: it changes how rows are deduplicated" \
  --tags "project:example-project,mission:data-import,slice:import-report" \
  --body-file /tmp/import-report-handoff.md
```

### §1b doctrine — turn ends by passing the ball

**A turn ends by passing the ball, never by going idle holding the slice waiting
on a confirmation the selected process does not include.** Follow the current
`mission-slice-sop`: proportional owner checks are the default; independent review
runs when selected, at the authored work boundary. Role names do not add per-commit
guard, QA, or orchestration gates. Do the authorized work, run its selected checks,
and return the outcome through durable custody.

Valid pauses are only:

- A genuine blocker — file a blocked-state qitem against the blocking peer or
  surface explicitly to orch.
- A scope-or-architecture question that requires owner input and changes the
  plan — surface to orch with the specific decision needed.

Implementing already-authorized work is neither of these. Proceed without
phantom-gating on an imagined "next prompt" or "operator confirmation" that the
process does not require.

### Anti-patterns

- Using `SoftwareTeam send` for durable work → use `SoftwareTeam queue create` instead. Sends do
  not survive restarts and do not show up in queue/project views.
- Idle-holding a slice for an imagined "next prompt" or "operator confirmation"
  that the process does not require → pass the ball via `SoftwareTeam queue handoff` and
  proceed to the next slice or stand by for the inbound verdict. See the §1b
  doctrine above.
- Inlining a multi-line / backtick-heavy body into `SoftwareTeam queue create --body`
  → use `--body-file /tmp/<descriptive-name>.txt` (or `-` for stdin), the
  corruption-safe surface. The body parser does not tolerate raw backticks or
  flag-like tokens inline.

## Runtime-Gated Coordination Primitives

SoftwareTeam v0.3.1 is published publicly as `@softwareteam/cli@0.3.1` and GitHub Release
`v0.3.1`. It includes the bundled PL-004 Coordination Primitive System: Phase A
`SoftwareTeam stream` / `SoftwareTeam queue`, Phase B `SoftwareTeam project` / `SoftwareTeam view`, Phase C
`SoftwareTeam watchdog`, and Phase D `SoftwareTeam workflow` / `workflow-keepalive`.

These are shipped product surfaces in v0.3.x, but they require a compatible
v0.3.x daemon and matching SQLite schema at runtime — the installed package
version is not automatically the version of the daemon serving you. If a
coordination command behaves unexpectedly, confirm the running daemon with
`SoftwareTeam whoami --json` and daemon status before assuming a product bug.

Default posture:

- Treat daemon `SoftwareTeam queue`, `SoftwareTeam stream`, `SoftwareTeam project`, `SoftwareTeam view`, `SoftwareTeam watchdog`, and
  `SoftwareTeam workflow` as the product coordination surfaces when the active daemon is v0.2.0 or newer.
- Use daemon-backed `SoftwareTeam queue` for durable routing. `update / show / list`
  complement `create / handoff` for inspection and state changes; records in an
  unrelated store are not evidence that this daemon owns the work.
- If a daemon-backed coordination command fails, debug the command/runtime/schema edge directly;
  do not assume the right workaround is to drop back to a config-layer primitive.
- Do not perform daemon stop/start, production DB copy/mutation, release, publish, or other
  consequence-boundary actions unless the operator/workstream has granted that specific gate.

## First-user workspace setup

When booting into a SoftwareTeam on a host where the workspace is unset, gap-ridden, or
points at a stale layout, address that before substantive project work. The
shipped surface is small + bounded — reach for the canonical commands rather
than improvising.

### Detect workspace state at boot

Agent-actionable when the daemon is reachable.

```bash
SoftwareTeam workspace validate --json
SoftwareTeam workspace validate <path> --kind <user|project|knowledge|lab|delivery> --json
```

`SoftwareTeam workspace validate` walks the workspace root and emits a structured
frontmatter-gap report against the v0 contract. Exit code is non-zero when
gaps exist (operators chain into hygiene fix loops). Default root is the
current directory; pass a positional path to validate elsewhere. `--kind`
scopes the contract to a specific workspace kind; omit for a kind-agnostic
structural check.

If `SoftwareTeam workspace validate` reports a non-zero `gapCount` OR the workspace
root is unset / unwritable, the workspace needs instantiation — see the next
section.

### Instantiate the canonical workspace scaffold

Agent-actionable. The operation is additive and preserves existing files.

```bash
SoftwareTeam config init-workspace
SoftwareTeam config init-workspace --root <path>
SoftwareTeam config init-workspace --dry-run --json
```

`SoftwareTeam config init-workspace` scaffolds the canonical workspace layout at the
configured `workspace.root` (default `~/.softwareteam/workspace`):

- `missions/` — release missions + slices
- `exhaust/` — project-local coordination exhaust
- `SPEC.md` — project intent
- `project.yaml` — project catalog selections and mission root
- `workspace.yaml` — project registration
- `.gitignore` — local SoftwareTeam state and exhaust exclusions

`--root <path>` targets a non-default root for this call; `--dry-run` reports
what would be created without writing. `--force` is deprecated compatibility
and still preserves existing files.

### Redirect the workspace root

Operator-gated when persistent. Agent-actionable when one-shot via env-var.

For a single command:

```bash
SOFTWARETEAM_WORKSPACE_ROOT=<path> SoftwareTeam <command> ...
```

For a persistent host-level redirect, the operator changes the config file or
runs the setter:

```bash
SoftwareTeam config set workspace.root <path>
```

ConfigStore precedence: `SOFTWARETEAM_WORKSPACE_ROOT` env > config-file
`workspace.root` > built-in default `~/.softwareteam/workspace`. The same
precedence governs `SOFTWARETEAM_WORKSPACE_SPECS_ROOT` → `workspace.specs_root`
(default `<workspace_root>/specs`).

Prefer the env-var form for one-shot redirects (transparent to operators);
reserve `SoftwareTeam config set` for changes the operator owns.

### Build a workspace from scratch

Agent-actionable. Same surface as the canonical scaffold above; the
`workspace.root` cascade handles non-existent host paths.

```bash
SoftwareTeam config init-workspace --root /path/to/new/workspace
```

The command additively creates any missing canonical entries and preserves
every existing one; only a complete six-entry scaffold is a no-op. Run
`SoftwareTeam workspace validate /path/to/new/workspace --json` after to confirm the
contract holds.

### Create a workflow inside an existing workspace

Authoring is operator-or-agent; validation + instantiation are
agent-actionable.

Workflow spec files live at:

```
<workspace_root>/specs/workflows/<name>.yaml
```

`<workspace_root>` resolves via the ConfigStore precedence named above.
There is no `SoftwareTeam workflow create` verb in v0.3.x — the spec YAML is authored
directly. Template by hand from the documented schema, or copy a built-in
starter from `<softwareteam install>/dist/builtins/workflow-specs/` and adapt.
Once written:

```bash
SoftwareTeam workflow validate <workspace_root>/specs/workflows/<name>.yaml --json

SoftwareTeam workflow instantiate <workspace_root>/specs/workflows/<name>.yaml \
  --root-objective "<one-line objective for the run>" \
  --created-by <your-session>@<your-SoftwareTeam> \
  --json
```

Both `--root-objective <text>` and `--created-by <session>` are REQUIRED
on `instantiate` — omitting either yields a Commander required-option
error before the daemon is contacted. `--entry-owner <session>` is an
optional override for the entry-step owner; default routing is per the
workflow spec.

`validate` returns a structured ok/error report; `instantiate` creates a
workflow instance + entry-step qitem. Inspect existing surface state with:

```bash
SoftwareTeam workflow specs --json              # list registered specs (built-in + operator-authored)
SoftwareTeam workflow list --json               # list active workflow instances
SoftwareTeam workflow show <instanceId> --json  # inspect one instance
SoftwareTeam workflow project <instanceId>      # ADVANCE an instance — projects the next-step packet
SoftwareTeam workflow continue <instanceId>     # read-only inspector of an instance (does NOT advance it)
```

*(Surface note — the current `SoftwareTeam workflow` command group registers **13** subcommands: `validate`, `instantiate`, `project`, `list`, `specs`, `show`, `trace`, `continue`, `run`, `watch`, `route`, `resume`, `status`. There is still no `create` verb — the spec YAML is authored on disk. `project` is the advancing verb (it projects the next-step packet); `continue` is a read-only inspector, NOT an advance — do not conflate them. The 13-verb set and the project-vs-continue semantics are verified against current product main `d37a08ad` (`packages/cli/src/commands/workflow.ts`, 13 registered `.command(...)` entries; the earlier "6-verb surface / continue-advances" claim here was stale). Verify individual subcommand flags with `SoftwareTeam workflow --help`.)*

## Permission policy — pick one at setup (onboarding)

SoftwareTeam sets only a **minimal usability floor** on your harness permissions and otherwise stays out of the way — then it ships **recommended policies you opt into**. It never bakes a permission policy for you. On install / onboarding this is a required choice, presented as a top-level pick:

- **POLICY MODE** — pick a built-in policy and have it applied:
  - **Locked** — deny-by-default whitelist; untrusted SoftwareTeams/work.
  - **Standard** ⭐ (recommended) — routine development including push is allowed; PR creation, publication, merge/release, force-push and destructive actions ask.
  - **Open** — allow-by-default; everything except explicitly-destructive, which ask.

  The built-in definitions ship as read-only policy spec files (Locked / Standard / Open); applying your pick is the job of the **`applying-a-permission-policy`** skill — it translates the chosen spec into your live harness config (Claude `settings.json` / Codex `config.toml`), interactively, showing the diff before it writes.
- **YOLO MODE** — done with permissions, just want it to work: SoftwareTeam boots every seat with the harness full-bypass launch flag. No config policy is applied (the bypass overrides it). This is a deterministic SoftwareTeam setting, not a skill.
- **No choice = the floor** — the minimal usability baseline (Claude `acceptEdits` / Codex workspace-only / Pi `--no-approve`), one consistent minimum, nothing more.

The floor and YOLO are **launch flags** SoftwareTeam sets deterministically; the Locked / Standard / Open policies are **config-file** policies the skill applies (agent-driven, because harness config formats drift). A SoftwareTeam **carries** its chosen policy on its spec and boots with it — see Lifecycle → Bring a SoftwareTeam up. To (re)apply or change a policy, open **`applying-a-permission-policy`**.

## v0.3.x Starter, Workspace, And Plugin Surfaces

SoftwareTeam v0.3.0 adds `SoftwareTeam agent-image`, `SoftwareTeam context-pack`, `SoftwareTeam workspace`, and
`SoftwareTeam config init-workspace`. *(0.5.0: the `SoftwareTeam context-pack` alias is retired — the store + compose library is the single `SoftwareTeam context` noun; see "Context packs and paced delivery (0.5.0)".)* It also shifts fresh-user starter guidance toward
`product-team` for human-directed work and `conveyor` for workflow-oriented
work. Treat `demo` as legacy/test content unless a task specifically asks for
the old demo spec. *(0.6.6: the built-in teams are `starter` and `factory`, plus the
specialist teams `code-review`, `research` and `pm`. `product-team`, `conveyor` and
`demo` are gone, and `first-project` is starter's old name. `workshop` is a SoftwareTeam
bundle.)*

SoftwareTeam v0.3.1 adds public package/source surfaces for Plugin Primitive v0,
Claude Auto-Compaction Policy, migration `040_workflow_specs_diagnostic`,
Library Explorer finishing, Settings Destination Explorer, Dashboard/For You
vellum refresh, storytelling adapter, and action outcome + inline error UX.

`SoftwareTeam plugin` is read-only at v0:

```bash
SoftwareTeam plugin list
SoftwareTeam plugin show <id>
SoftwareTeam plugin used-by <id>
SoftwareTeam plugin validate <path>
```

There is no `SoftwareTeam plugin install` verb in v0.3.1. Plugin installation remains
explicit operator copy/symlink to `$SOFTWARETEAM_HOME/plugins/<plugin-id>/`.

The v0.3.1 package introduced opt-in Claude auto-compaction policy through
`policies.claude_compaction.*` ConfigStore keys. A package version alone says
nothing about a running daemon's configuration; inspect the selected instance
before relying on a policy or its default.

Compatibility checks:
- `SoftwareTeam down` accepts a SoftwareTeam name or id. An ambiguous name matching more than one
  active SoftwareTeam is refused with matching ids; use the intended id. It ends every
  agent's session and any work in progress, so check `SoftwareTeam ps --nodes --software-team <SoftwareTeam>`
  and that the person asked; `SoftwareTeam up <SoftwareTeam> --existing` restores it.
- For queue/view JSON or limit differences, compare the installed command's help,
  the running daemon version and the actual response. A wrapper mismatch is not
  by itself a daemon-health failure, and historical workarounds are not current
  behavior guarantees.
- After a startup timeout, inspect status and logs before retrying; a timeout
  does not establish whether the underlying operation completed.

## Recovery and Resilience (v0.3.4+)

v0.3.4's theme is Recovery + Resilience. The surfaces below compose into a
single boot-to-running-SoftwareTeam path that survives crashes, hand-resumed sessions,
profile-load drift, and partial workspace state without silently fudging
status.

### `SoftwareTeam start` — recovery entrypoint

`SoftwareTeam start` is the top-level recovery sequencer. It does not invent recovery;
it composes existing primitives (daemon start + kernel verify + per-SoftwareTeam
restore) into one call.

```bash
SoftwareTeam start                    # interactive: daemon + kernel + pick-and-restore
SoftwareTeam start --last             # headless: restore SoftwareTeams that were last running; a SoftwareTeam stopped on purpose stays down
SoftwareTeam start --all              # headless: restore all SoftwareTeams with restore-usable snapshots
SoftwareTeam start --software-teams <name> [<name>...]   # headless: restore only the named SoftwareTeams
SoftwareTeam start --json             # JSON output for agents
```

`SoftwareTeam start --last` keeps down a SoftwareTeam that was stopped on purpose (`SoftwareTeam down` or `SoftwareTeam seat stop`).
Bring it back with `SoftwareTeam start --software-teams <SoftwareTeam>`. A SoftwareTeam whose seat statuses can't be read is still
attempted, with a warning (`seat_status_unreadable`).

Framing: `SoftwareTeam start` is the RECOVERY entry point, not the getting-started
hero. The fresh-user boot hero remains `SoftwareTeam up <team>` (typically
`SoftwareTeam up starter` for a first change, or `SoftwareTeam up factory`). Reach for `SoftwareTeam start` after a host reboot, daemon
restart, or any "bring my SoftwareTeams back" moment.

### `SoftwareTeam reconcile-session` — no-launch adopt of a hand-resumed session

When an operator has externally resumed an agent session (e.g. attached a
shell, restarted a runtime by hand) and you want SoftwareTeam to reconcile its
lifecycle state without re-launching or sending input, use:

```bash
SoftwareTeam reconcile-session <session>
SoftwareTeam reconcile-session <session> --software-team <softwareTeamId> --node <logicalId>
SoftwareTeam reconcile-session <session> --no-launch
SoftwareTeam reconcile-session <session> --json
```

This is a no-launch, no-input adopt. `--software-team`/`--node` disambiguate when the
canonical session name does not uniquely resolve. `--no-launch` is accepted
for explicitness (it is the only mode this command has).

### Five-term restore status vocabulary

The shipped restore vocabulary is intentionally honest. It surfaces in
`SoftwareTeam up` / `SoftwareTeam restore` / `SoftwareTeam ps`. Use the term that fits — do not collapse
to a generic "ok/failed":

- `resumed` — seat resumed from its original session/snapshot and is live.
- `fresh-primed` — seat opted into `--fresh` and was freshly started.
- `awaiting-decision` — zero-session honest state. There is no resumable
  session AND no `--fresh` opt-in was given; the seat is waiting for an
  operator decision. Previously fudged as `failed`; that was wrong — nothing
  is broken, the system is asking for input.
- `attention_required` — seat is in a state needing operator attention; not
  a transport failure. Clear via `SoftwareTeam seat clear-attention` once the
  attention has been resolved.
- `failed` — the send transport or launch genuinely failed.

This replaces the prior collapsed model (the v0.3.3 four-term vocabulary, in
which `rebuilt` was a term, is retired).

### `SoftwareTeam seat clear-attention` — audited reconcile of stuck attention

When a seat is stuck in `attention_required`, do NOT hand-edit SQLite to
fake-clear the state. Use the evidence-gated, operator-attested, audited
reconcile:

```bash
SoftwareTeam seat clear-attention <session>
SoftwareTeam seat clear-attention <session> --reason "operator attested: the operator re-authed, confirmed live"
SoftwareTeam seat clear-attention <session> --json
```

`--reason <text>` can acknowledge startup-status and subset-restore attention.
It does not bypass full-restore continuity checks or an active pane-identity
mismatch/missing-pane check; those run first. Successful identity re-verification
can also clear coexisting startup or subset-restore attention. If neither earlier
path clears attention, omitting `--reason` requires activity or send evidence.
Startup and restore clears write their corresponding audit events; an identity-only
clear updates the current binding and identity verdict without a clear event.
Acknowledgment or responsiveness alone does not prove that the original
conversation resumed.

A 422 response names the uncleared class and its failed check. If the recorded
native token needs correction and you know the actual token, use
`SoftwareTeam seat set-resume-token <session> --token-stdin --reason <explanation>`, then
rerun `SoftwareTeam seat clear-attention <session>` to check the live evidence. The token
update records operator provenance; it does not itself prove continuity.
Stopping/relaunching a working seat is a separate disruptive operation, not a
required cleanup or proof of resumed lineage.

### Periodic snapshots — crash-insurance floor

The daemon ships a periodic-snapshot scheduler. It runs independently of
teardown events and provides the crash-insurance floor that prior
event-only/teardown-only snapshots could not provide on hard crashes.

Config keys (SettingsStore):
- `snapshots.periodic.enabled` — default `true`
- `snapshots.periodic.interval_seconds` — default `300`
- `snapshots.periodic.retention_keep` — default `10`

Newest-wins semantics: when both `auto-periodic` and `auto-pre-down`
snapshots exist for a SoftwareTeam, the freshest of the two is selected for restore.
A newer `auto-periodic` beats a stale `auto-pre-down` (the crash fix); a
genuinely-fresher `auto-pre-down` still wins on graceful cycles. Manual
snapshots are handled separately. See
`packages/daemon/src/domain/snapshot-repository.ts` for the ordering rule.

The last-snapshot floor surfaces in `SoftwareTeam ps` / status output so an operator
can see at a glance how recent the crash-insurance floor is.

### Codex profile-v2 preflight

Profile-bearing launch/restore surfaces run a profile-load preflight. When
profile-load issues are detected, the failure is honest and actionable
(named error + remediation pointer) instead of a silent partial launch that
would later look like an attention_required seat with no explanation.

### cmux launch readiness

cmux-backed launches no longer produce silent partial workspace state. When
parts of the workspace are missing, the launch surfaces partial state
honestly and the UI exposes a one-click open-missing affordance.

(See also `## Token-Efficient Defaults (v0.4.0+)` below for the compact-by-default read-command surface that lands in 0.4.0.)

## Token-Efficient Defaults (v0.4.0+)

v0.4.0 flips the five most frequently invoked read-commands from firehose-by-default to compact-by-default, and `SoftwareTeam queue list` adopts the docker / kubectl read-command grammar. **All defaults preserve breadth and capability — the firehose is one explicit flag away.**

### `SoftwareTeam ps` — scope-aware: bare `SoftwareTeam ps` = ALL SoftwareTeams; `--nodes` = your SoftwareTeam only

```bash
SoftwareTeam ps                      # ALL active SoftwareTeams on the host, one compact row each — RUN FIRST to know the world
SoftwareTeam ps --software-team <name>         # one named SoftwareTeam's summary
SoftwareTeam ps --nodes --software-team <name> # per-node (seat) detail for a NAMED SoftwareTeam — the normal drill-in
SoftwareTeam ps --nodes              # per-node detail — CURRENT SoftwareTeam ONLY (deliberately narrow; NOT the whole host)
SoftwareTeam ps --json               # compact JSON (default = a bare array of ALL non-archived SoftwareTeams)
SoftwareTeam ps --nodes -A           # cross-SoftwareTeam node inventory (was v0.3.4 default)
SoftwareTeam ps --nodes --full       # complete record (the v0.3.4 per-node default shape; resumeToken VALUE retained here for downstream consumers)
SoftwareTeam ps --nodes --session <sess>  # narrow to one canonical session
SoftwareTeam ps --active             # opt-in active-state filter (does NOT change the all-states default — ps surfaces topology/readiness, where stopped/recoverable/attention IS the actionable signal)
```

**v0.4.0 breadth + projection changes**:
- **SoftwareTeam-level `SoftwareTeam ps` lists ALL active SoftwareTeams** (one row each — the cheap "know the world" view). The **`--nodes` (per-seat) view defaults to your CURRENT SoftwareTeam only** (from `SOFTWARETEAM_SESSION_NAME`'s `@<SoftwareTeam>` suffix); `--software-team <name>` picks another SoftwareTeam, `-A` widens `--nodes` to the whole host (expensive — prefer `--fields`/`--limit`).
- **Per-node TL;DR projection (compact) is the default**; `--full` returns the raw byte-equivalent passthrough. Daemon-side `recoveryGuidance` relocated to a guidance-by-reference map (no longer duplicated per-node) — even `--full` benefits.
- **All-states stays default** (different from `SoftwareTeam queue list` which defaults to active-only) — for `ps`, non-running states ARE often the actionable signal.
- **Resume-token security**: `--full` JSON emits `resumeTokenPresent` (boolean) — the actual `resumeToken` value also remains in `--full` for downstream consumers that legitimately need it, but the compact default never carries it (an orch glance never accidentally leaks token material).

**⚠ SCOPE-AWARENESS — the one that bites:** `SoftwareTeam ps --nodes` (and `--nodes --json`) show ONLY your current SoftwareTeam's seats, by design — the narrow default protects your context window. **Narrow output is not the whole world.** Never conclude "my SoftwareTeam is the only SoftwareTeam on the host" from a `--nodes` read — run bare `SoftwareTeam ps` FIRST (cheap; it lists every SoftwareTeam), then `SoftwareTeam ps --nodes --software-team <name>` for the one you need. (`-A` widens to the whole-host node view; choose it when that breadth is needed.)

### `SoftwareTeam whoami` — compact-by-default + `--full` (`--verbose` alias)

```bash
SoftwareTeam whoami                  # compact: identity + peers names + edges + transcript path
SoftwareTeam whoami --json           # compact JSON
SoftwareTeam whoami --json --all-peers  # compact JSON with every peer, when output.compact bounds the list
SoftwareTeam whoami --full           # complete payload (v0.3.4 default shape)
SoftwareTeam whoami --verbose        # alias of --full
```

The first command every agent runs on boot AND every compaction-restore. The compact default keeps identity-recovery essentials (`identity`, `peers` names + sessionNames, `peersNote`, `edges` directional `kind` + `to.sessionName`, the transcript path). `--full` adds `contextUsage`, `commands`, `runtimeContext` and `workspace`. With `output.compact` on, compact JSON lists at most `output.whoami_peers` peers (default 8): edge peers first, then your pod, then roster order. `peersNote` and `peersOmitted` then say how many were left out, and `--all-peers` lists every one; `edges` stays complete. The compact-default is an ALLOWLIST projection — future payload fields default to `--full` and cannot silently re-bloat the every-boot path.

### `SoftwareTeam queue list` — active-frontier + docker/kubectl grammar

```bash
SoftwareTeam queue list                       # active, compact, CURRENT-SoftwareTeam (docker-ps default)
SoftwareTeam queue list -a                    # + closed/done history within current breadth (docker -a)
SoftwareTeam queue list -A                    # cross-SoftwareTeam breadth (kubectl -A)
SoftwareTeam queue list --full                # add body + chain-of-record + transition history
SoftwareTeam queue list -o json               # compact JSON (token-safe, machine-parseable)
SoftwareTeam queue list --full -o json        # full JSON
SoftwareTeam queue list --mine                # just the caller's items
SoftwareTeam queue list --destination <s>     # destined to <s>
SoftwareTeam queue list --source <s>          # sourced by <s>
SoftwareTeam queue show <qitemId>             # bounded single-item body preview
SoftwareTeam queue show <qitemId> --full      # complete body and chain fields; a closed row adds closingTransition (the close's state, reason, target, actor, time and note)
```

Four orthogonal axes (scope × history × field-breadth × encoding), all composable. **STOP using bare `SoftwareTeam queue list` as the cross-SoftwareTeam firehose.** Default is now active + compact + current-SoftwareTeam. Cross-SoftwareTeam history with full bodies is opt-in via `-A -a --full`; request only the breadth and fields needed for the question.

### `SoftwareTeam restore-check` — summary + not-ready-only default + `--full`

```bash
SoftwareTeam restore-check               # summary counts + not-ready seats (with reasons) only
SoftwareTeam restore-check --full        # complete per-seat readiness across the fleet (v0.3.4 default)
SoftwareTeam restore-check --software-team <name>  # narrow
SoftwareTeam restore-check --as <session>  # narrow to one seat
```

The summary retains not-ready seats and their reasons; `--full` adds ready-seat detail when needed. Scope the query before expanding its payload.

### `SoftwareTeam context` — context-window usage viewer (0.4.x; REMOVED in 0.5.0)

```bash
SoftwareTeam context                # compact summary        (0.4.x only)
SoftwareTeam context --full         # complete current payload
SoftwareTeam context --software-team <name>   # narrow to one SoftwareTeam
SoftwareTeam context --threshold 80 # filter to seats at/above 80%
```

Lower leverage than the others; keeps the read-command surface compact-by-default after the 0.4.0 upgrade. **⚠ 0.5.0: this usage viewer is removed entirely and the `SoftwareTeam context` name is reassigned to the context library (store + compose) — see "Context packs and paced delivery (0.5.0)" below. On a 0.5.0 host, bare `SoftwareTeam context` is the library, not this viewer.**

### Keep routine reads bounded

Choose scope, active/history breadth and fields before expanding a result. A
status question usually needs identifiers, owner, state and reason; open the full
body or artifact when it is relevant. Preserve full evidence on disk instead of
repeatedly loading unchanged output. Compact defaults reduce reading cost; they
do not remove the full-detail path or prove that nothing exists outside the scope.

### `SoftwareTeam scope mission|slice progress` — deterministic progress updates

```bash
SoftwareTeam scope mission progress <mission> --add "<line>"   # append a progress line; --set replaces; --section <heading> (default Rail); --status active|done|blocked
SoftwareTeam scope slice progress <slice-path> --add "<line>"  # same flags: --add / --set, --section <heading>, --status active|done|blocked
```

Replaces hand-editing `PROGRESS.md` with markdown. Writes the canonical structure the SoftwareTeam PROGRESS UI page reads. `SoftwareTeam scope mission create` + `SoftwareTeam scope slice create` now scaffold `PROGRESS.md` automatically.

### `SoftwareTeam scope mission|slice stage / verified / repair` — deterministic maturity vocabulary

```bash
SoftwareTeam scope slice stage <slice> <new-stage>             # wip / provisional / established / canonical / superseded / retired
SoftwareTeam scope slice stage <slice> superseded --successor <id>  # superseded REQUIRES --successor (rejected otherwise)
SoftwareTeam scope mission stage <mission> <new-stage>         # same enum + rules at mission tier

SoftwareTeam scope slice verified <slice> --against "<source>" # stamp `verified: <today> against <source>`; --against MANDATORY
SoftwareTeam scope mission verified <mission> --against "<source>"

SoftwareTeam scope slice repair <slice>                        # idempotent repair: backfill PROGRESS.md, conform id/stage/verified, repair ghosts
SoftwareTeam scope mission repair <mission>                    # mission-tier idempotent repair

SoftwareTeam scope slice show <slice>                          # derives read-time effective-reliability from (stage × verified)
                                                      # — stale-`verified` `canonical` reported as effectively `provisional`
```

Composes with the `progress` command + scaffolding to update scope IDs and maturity vocabulary through `SoftwareTeam scope`. Agents update `stage` / `verified` / `id` through commands rather than hand-editing markdown and drifting. The `--against` MANDATORY rule on `verified` is the anti-stale keystone: bare timestamps are rejected because a bare timestamp is exactly what lets stale trackers lie while looking fresh. **STOP hand-editing the `stage` / `verified` / `id` fields in scope frontmatter; use the new verbs.** Existing missions / slices with `id:null` ghosts or missing `PROGRESS.md` are repaired idempotently via `repair`.

### `SoftwareTeam skill audit` — skill cascade provenance

```bash
SoftwareTeam skill audit                  # human report of findings
SoftwareTeam skill audit --json           # structured findings
SoftwareTeam skill audit --severity warn  # stale + mirror-drift only
SoftwareTeam skill audit --software-team <name>     # narrow to embedded skill copies for one SoftwareTeam
```

Read-only audit of the skill cascade. Detects `missing` / `stale` / `self-referential` / `invalid-date` / `mirror-drift` across the canonical skills workspace → product mirror → hub cwd → installed plugin chain. Findings route back to the lifecycle for shaped propagation runs. **False-green prevention**: when audit evidence is unavailable, the CLI emits `unable-to-audit` with exit code `2` rather than reporting `clean`.

### `SoftwareTeam seat clear-attention` — extended to derived projection staleness

`clear-attention` also reaches restore-derived attention even when
`startupStatus=ready` and `sessionStatus=running`. Full-restore attention requires
the restore reconciler's exact native-token and usable-pane checks; `--reason`
cannot replace them. Subset-restore attention can reach the attestation path
when no active pane-identity class takes precedence. That path records
`operator_recovered` with `runtimeCwdVerified:false`; it is an acknowledgment,
not proof of resumed lineage. Without an explicit stored continuity outcome,
inventory leaves continuity null (`unverified` in `SoftwareTeam seat status`) unless the
same restore attempt has a matching receipt and reconciliation with strict
native-token and usable-pane proof. Explicit stored outcomes remain historical
facts; acknowledgment or responsiveness alone cannot infer `resumed`.

### Native Codex session id capture

Codex seats can now record the real native session id from the Codex
`SessionStart` hook instead of relying on scrape-shaped identity. Corroborate the id across the current hook payload, provider history and
managed record before relying on it. A release introducing native capture does
not prove that every existing seat uses it; retain any unavailable or conflicting
identity evidence explicitly.

### Codex resume preserves approval posture

Resuming a Codex seat preserves the launching seat's approval/sandbox posture
and profile flags. Product-emitted resume commands carry the posture flags
instead of silently falling back to implicit-deny or an unrelated profile.

Do not "fix" a resumed Codex seat by relaunching it with broader approvals
unless the operator explicitly grants a bounded window. Verify the seat's
active posture first, and preserve it when composing recovery commands.

### `SoftwareTeam seat set-resume-token --token-stdin`

```bash
printf '%s' "$RESUME_TOKEN" | SoftwareTeam seat set-resume-token <session> --token-stdin
```

Use this command to set or restore a seat resume token. It replaces direct
SQLite edits, rejects unauthorized writes and bad/null token false-ready paths,
records redacted audit/provenance, and keeps token material out of command
arguments, stdout, logs, and normal status rows. Use stdin, not an inline flag,
when passing token material.

## Core Loop

Most work in SoftwareTeam reduces to this loop:
- recover identity: `SoftwareTeam whoami` (compact default; add `--full` only when you need the heavy payload)
- inspect inventory: `SoftwareTeam ps --nodes` (compact default; add `--full` only when you need the firehose)
- read context: `SoftwareTeam transcript ...`, `SoftwareTeam ask ...`, `SoftwareTeam chatroom history ...`
- act: `SoftwareTeam send`, `SoftwareTeam capture`, `SoftwareTeam broadcast`, lifecycle commands

## Agent-Managed Apps

An agent-managed app is a deployable SoftwareTeam unit made of:
- the software or service
- one specialist agent dedicated to that software

Treat the specialist as the domain delegate for that app.
The current canonical example is:
- SoftwareTeam: `secrets-manager`
- pod: `vault`
- member: `specialist`
- logical ID: `vault.specialist`
- session: `vault-specialist@secrets-manager`

Typical operator loop:

```bash
SoftwareTeam up secrets-manager --cwd /path/to/project
SoftwareTeam ps --nodes --json
SoftwareTeam send vault-specialist@secrets-manager "Check Vault health and report back." --verify
SoftwareTeam env status secrets-manager
SoftwareTeam env logs secrets-manager
```

Cross-SoftwareTeam communication is valid when the target session resolves uniquely.
Example:

```bash
SoftwareTeam send vault-specialist@secrets-manager "Read secret/data/dogfood and report the value." --verify
```

Use the specialist instead of teaching every peer the same app-specific toolchain.
For Vault, ask `vault.specialist` to do secrets-domain work rather than improvising curl or Vault CLI usage in unrelated agents.

## Identity and Recovery

Start here after launch, compaction, or confusion:

```bash
SoftwareTeam whoami --json
```

What it gives you today:
- identity: SoftwareTeam, logical ID, pod/member, session name, runtime
- peers and directional edges
- transcript info
- `contextUsage` when available

Flags:
```bash
SoftwareTeam whoami --session <name>
SoftwareTeam whoami --node-id <id>
```

If the daemon is unreachable but identity can still be inferred, `--json` may return a partial result instead of crashing.

`WhoamiResult` (v0.3.3+) carries a required `peersNote` field with three pointers
the agent can use to navigate the rest of the SoftwareTeam from a cold start. The
human-formatted CLI output preserves the literal `Peers:` line prefix verbatim
(parser/test compatibility) and surfaces the clarifier in-band beneath it; the
JSON form exposes `peersNote` directly for programmatic consumers.

## Inventory and Monitoring

```bash
SoftwareTeam ps                      # ALL active SoftwareTeams on the host, one compact row each (run FIRST to know the world)
SoftwareTeam ps --nodes              # compact node inventory (current SoftwareTeam)
SoftwareTeam ps -A                   # all-SoftwareTeams breadth (was the pre-0.4.0 default)
SoftwareTeam ps --nodes --full       # complete per-node record (the firehose — opt-in)
SoftwareTeam ps --nodes --json       # compact JSON node inventory (add --full for the full record)
```

**v0.4.0 flipped these to compact-by-default — see the `SoftwareTeam ps` compact-defaults section above; STOP using bare `SoftwareTeam ps --nodes --json` as a fleet-wide firehose (scope and detail are separate choices).** The compact `SoftwareTeam ps --nodes` node inventory (add `--full` only when you need the complete record, `-A` for cross-SoftwareTeam breadth) carries, per node:
- session name
- runtime
- session/startup status
- restore outcome (compact: `resumeTokenPresent` boolean; the token VALUE is in `--full`)
- attach/resume commands
- latest error

Other health surfaces:

```bash
SoftwareTeam status
SoftwareTeam daemon status
SoftwareTeam config
SoftwareTeam preflight
SoftwareTeam doctor
SoftwareTeam env status <SoftwareTeam>
SoftwareTeam env logs <SoftwareTeam>
SoftwareTeam env down <SoftwareTeam>
```

### Bounded agent self-scout

Use the typed health projection before reading raw coordination history. The
default query is the current seat; widen deliberately when the evidence points
beyond it:

```bash
SoftwareTeam health --json
SoftwareTeam health --software-team <software-team-id> --json
SoftwareTeam health --instance --json
SoftwareTeam health explain <finding-id> --json
```

Follow the returned stable finding ID and `suggestedInspection`. Use `explain`
when the summary matters: it returns the same canonical record with its bounded
window, freshness, literal detector rule, evidence references, and next
inspection. Human output projects those same fields; it does not calculate a
second score.

An empty result means only that no records matched the bounded query. It is
**not a healthy assertion**. Stale, unavailable, contradictory, and
indeterminate evidence stays explicit. Never read raw SQLite for a self-scout,
and never turn a finding into an acknowledgement, notification, queue row, or
remediation automatically: `SoftwareTeam health` is strictly read-only.

## Transcript and Communication

### Transcript access

```bash
SoftwareTeam transcript <session> --tail 100
SoftwareTeam transcript <session> --grep "pattern"
SoftwareTeam transcript <session> --json
```

### Send to one session

```bash
SoftwareTeam send <session> "message"
SoftwareTeam send <session> "message" --verify
SoftwareTeam send <session> "message" --wait-for-idle <seconds>
SoftwareTeam send <session> "message" --raw
SoftwareTeam send <session> "message" --dangerously-interact --reason "<why>"
SoftwareTeam send <session> "message" --host <id>
SoftwareTeam send <session> "message" --json
```

**The send-guard (v0.4.0) — the default is SAFE.** A default `SoftwareTeam send` is guarded: it will NOT submit into an interactive prompt / permission block on the target pane. Flags:
- `--verify` — delivery evidence.
- `--force` — **a back-compat no-op on the send DECISION**: it never bypasses the interactive-prompt/permission guard and never changes whether a message is delivered (a mid-task/busy pane already sends-with-advisory by default). *(It does NOT "bypass activity-risk checks" — that earlier teaching is retired.)* It is **not fully inert**, though — it is still parsed solely to be **rejected in combination with `--wait-for-idle`**: `SoftwareTeam send … --force --wait-for-idle <n>` prints `--wait-for-idle cannot be combined with --force`, exits 1, and sends nothing. So do not read "no-op" as "`--force --wait-for-idle` is harmless"; that pairing errors. *(Verified against current product main `d37a08ad`: the guard-bypass no-op is declared at `send.ts` and confirmed by runtime capture — a plain `--force` send delivers through the ordinary path; the `--wait-for-idle` rejection is enforced at `send.ts`, `routes/transport.ts`, and `session-transport.ts`, and confirmed by runtime capture — exit 1, nothing sent.)*
- `--wait-for-idle <seconds>` — wait until the target is explicitly idle before sending. **Cannot be combined with `--force`** (that pairing is rejected: exit 1, nothing sent).
- `--raw` — send exact text/keystrokes without the From/To messaging envelope (still guarded against interactive prompts).
- `--dangerously-interact --reason "<why>"` — the ONLY override of the prompt/permission guard: deliberately drive an interactive prompt/permission block (implies `--raw`, requires `--reason`, audit-logged).
- `--host <id>` — send on a remote host declared in `~/.softwareteam/hosts.yaml` (ssh hosts shell out; http hosts go CLI-direct to the remote daemon).
- `--from <session>` — deprecated and ignored; it does not select the sender. Sender identity comes from the current seat and transport provenance; cross-host envelopes use the durable local origin, not the supplied flag or a relay identity.
- `--context <ref>` **(0.5.0)** — attach a composed context pack/piece by ref (see "Context packs and paced delivery"). Small piece → `send --context`; a real pack → `SoftwareTeam walk`. The noun `SoftwareTeam context` composes the ref; the verb delivers it.

> **Durable work goes to the QUEUE, not `send`.** `SoftwareTeam send` is an *ephemeral* message to a pane — it can be missed, and its delivery status is pane-render, not receipt. If you are **assigning work, or the message is important enough that losing it would be a real bummer**, use `SoftwareTeam queue` (below): it's durable, owned, tracked, and survives compaction and restart. Reach for `send` for a quick conversational nudge; reach for the **queue** for anything that must not get lost. Do not default to `send` for work — that's the most common mistake.

As of v0.3.3, content beginning with `--` or `-` is safe:
`SoftwareTeam send <session> "content starting with -- or - is now safe"` delivers
literally. The daemon's `send_text` path carries an explicit `--`
end-of-options sentinel so tmux no longer parses dash-prefixed content
as its own flags. The CLI surface itself is unchanged. For multi-line
or large bodies handed off as durable work, use
`SoftwareTeam queue create --body-file <path>` (`-` for stdin) — that's the
queue-side surface, not `SoftwareTeam send`.

`--verify` delivery outcomes (v0.3.3+):
- `delivered` — text + Enter both succeeded and capture re-confirmed the body landed.
- `rendered-unconfirmed` — text + Enter both succeeded but capture could not re-confirm the body (TUI redraw race or scroll). The message landed; the post-send re-check could not prove it. Treat as landed-but-unconfirmable, NOT failure.
- `failed` — the send transport itself failed.

The legacy `Verified: yes/no` line is preserved verbatim (parser/test
compatibility). A new `Delivery: <outcome>` line carries the named outcome
above.

Observed operator nuance for `--verify`:
- `Sent to ...` + `Verified: yes` (`Delivery: delivered`) = strong positive delivery evidence.
- `Sent to ...` + `Verified: no` + `Delivery: rendered-unconfirmed` = the message landed; capture could not re-prove it. Don't blind-retry — check reply / `SoftwareTeam capture` / transcript before sending again.
- `Sent to ...` + `Verified: no` + `Delivery: failed` = send-transport failure.
- no `Sent to ...` line or a hard error = send failure.

When you get `Verified: no`, do not immediately retry blindly. First check one of:
- a direct reply from the target
- `SoftwareTeam capture <session>`
- transcript evidence
- queue/outbox state if the message asked for a durable handoff

### Capture terminal output

```bash
SoftwareTeam capture <session>
SoftwareTeam capture <session> --lines 50
SoftwareTeam capture --software-team <name>
SoftwareTeam capture --pod <name> --software-team <name>
SoftwareTeam capture --software-team <name> --json
```

### Broadcast

```bash
SoftwareTeam broadcast --software-team <name> "message"
SoftwareTeam broadcast --pod <name> "message"
SoftwareTeam broadcast "message"
SoftwareTeam broadcast --software-team <name> "message" --json
```

**Use `SoftwareTeam broadcast` sparingly — prefer `SoftwareTeam send` fan-out.** Without `--software-team` or `--pod`, broadcast targets
**every running session across ALL SoftwareTeams** (plus attached external_cli nodes) — the fastest way to cause a
broadcast storm. Reserve `SoftwareTeam broadcast` for small SoftwareTeams or a genuine all-hands emergency. For the normal
"message several seats at once" case, use `SoftwareTeam send`, which scopes the fan-out and keeps the messaging
envelope, the delivery/interactive-prompt guards, and per-recipient results:

```bash
SoftwareTeam send --to dev-impl@my-SoftwareTeam,dev-qa@my-SoftwareTeam "message to specific seats"   # named seats (comma-list or repeat --to)
SoftwareTeam send --pod dev "message to one pod"                                    # scoped fan-out
SoftwareTeam send --software-team my-SoftwareTeam "message to one SoftwareTeam"                                 # scoped fan-out
```

### Chatroom

```bash
SoftwareTeam chatroom send <SoftwareTeam> <message> [--sender <name>]
SoftwareTeam chatroom history <SoftwareTeam> [--topic <name>] [--after <id>] [--since <ts>] [--sender <name>] [--limit <n>] [--json]
SoftwareTeam chatroom wait <SoftwareTeam> [--after <id>] [--topic <name>] [--sender <name>] [--timeout <seconds>] [--json]
SoftwareTeam chatroom clear <SoftwareTeam>
SoftwareTeam chatroom topic <SoftwareTeam> <topic-name> [--body <text>] [--sender <name>]
SoftwareTeam chatroom watch <SoftwareTeam> [--tmux]
```

**Key commands:**
- `send` — post a message
- `history` — retrieve with composable filters (sender, since, after, topic)
- `wait` — block until new matching messages arrive (polls history, times out honestly)
- `clear` — delete all messages for the SoftwareTeam (destructive, software-team-scoped)

## See something, say something

SoftwareTeam has an **observation stream** — the fleet's zero-friction institutional memory, mined for
real product improvements. When you notice **anything worth externalizing**, say something and keep
working:

- a **bug**, a rough edge, or something that needs fixing
- a **feature idea** or an improvement
- something that **worked really well** — a technique, tool, or pattern worth spreading
- an **observation**, positive or negative feedback, or something genuinely cool, productive, or funny

```bash
SoftwareTeam stream emit --source <your-session> --body "what you noticed"
```

That's the whole reflex. **Don't** decide where it goes or who it's for — the intake router triages
(destination/type/urgency/tags are optional hints — `--hint-type review|handoff|idea`,
`--hint-urgency routine|urgent|critical`, `--hint-tags` — never required). One command, then carry
on; the value is the habit, not the polish. **Don't overdo it, either:** stream real signal, not
narration — a good observation beats ten noisy ones. It's a passing thought you externalize, not a chore.
- `topic` — set a topic marker
- `watch` — SSE or tmux-based live stream

**Roundtable protocol:**
1. Inspect old room: `SoftwareTeam chatroom history my-SoftwareTeam --limit 5`
2. Save if needed: `SoftwareTeam chatroom history my-SoftwareTeam --json > /tmp/old-room.json`
3. Clear if needed: `SoftwareTeam chatroom clear my-SoftwareTeam`
4. Set topic: `SoftwareTeam chatroom topic my-SoftwareTeam "ROUND START"`
5. Post: `SoftwareTeam chatroom send my-SoftwareTeam "position..." --sender <session>`
6. Monitor: `SoftwareTeam chatroom wait my-SoftwareTeam --timeout 120`
7. Close: `SoftwareTeam chatroom topic my-SoftwareTeam "ROUND CLOSED"`

### `SoftwareTeam ask`

```bash
SoftwareTeam ask <SoftwareTeam> "question"
SoftwareTeam ask <SoftwareTeam> "question" --json
```

Current shipped behavior:
- queries the daemon for evidence
- returns SoftwareTeam summary
- returns transcript excerpts
- may return chat excerpts
- returns insufficiency state and optional guidance

This is an evidence/context command. It is not a hidden second-LLM call.

### `SoftwareTeam auth` — agent auth-profile management (v0.4.1, product-native)

Product-native switching of agent auth profiles from the CLI. The runtime is a **flag** (`--runtime <codex>`), not a command noun — never `SoftwareTeam codex-auth`.

```bash
SoftwareTeam auth status --runtime codex          # presence / mode / parseability / login-state (never prints token contents)
SoftwareTeam auth list --runtime codex            # saved profiles
SoftwareTeam auth save <profile> --runtime codex  # snapshot the auth FILE (mode-guarded), never echoes contents
SoftwareTeam auth switch <profile> --runtime codex
SoftwareTeam auth validate <profile> --runtime codex
SoftwareTeam auth seats … --runtime codex         # seat -> profile registry (metadata only; NOT proof of a live account)
```

**Hard secret boundary:** no token value is ever printed, logged, queued, streamed, or committed; status/validate report presence/mode/login-state only; seat labels are metadata, not live-account proof. MVP is `--runtime codex`; other runtimes use the same surface with a different `--runtime`, never a parallel command.

## Context packs and paced delivery (0.5.0)

**Compose context once, hand it to a seat cleanly.** A library primitive plus a set of delivery flags. The rule that keeps the grammar coherent — internalize this one: **the noun stores and composes; the verbs deliver.** `SoftwareTeam context` never sends anything; delivery is only ever `SoftwareTeam send` / `SoftwareTeam broadcast` / `SoftwareTeam walk` / `SoftwareTeam queue`.

> Version note: this describes the library surface introduced in 0.5.0. Check the installed command and serving daemon before relying on it. In 0.4.x, bare `SoftwareTeam context` was a context-window usage viewer (above); in 0.5.0 that viewer is removed and the `SoftwareTeam context` name belongs to the library here.

### `SoftwareTeam context` — the store + compose library (never delivers)

Manage and compose context (any text/markdown) into reusable **packs**. Every piece and pack has a stable, **path-like ref** — you address context the way you address files (`skills/claude-compaction-restore`, `reference/software-team-spec.md`).

```bash
SoftwareTeam context list                     # what's in the library
SoftwareTeam context show <ref>               # read a piece or pack
SoftwareTeam context add <source-dir>         # install an existing pack directory into the store
SoftwareTeam context preview <ref>            # assemble + show a pack WITHOUT delivering it
SoftwareTeam context sync                     # re-walk discovery roots, refresh the library index
SoftwareTeam context rm <ref>
SoftwareTeam context compose --out packs/<ref> --from <fileA> <fileB> ...   # ordered pieces -> a durable pack
```

- Sensible default store location; works unconfigured, can be pointed elsewhere later (another folder now; a machine or URL later).
- `compose` (v1) is honest ordered concatenation of named files into a durable pack with a ref — "here's a file, read a file."
- **No delivery verb lives on the noun.** To get a pack to a seat, hand its ref to a delivery verb below.

### `SoftwareTeam walk` — paced delivery of a sequence

```bash
SoftwareTeam walk <seat> --through <ref | file ...> --pace 10s
```

Walk a seat *through* a pack: each piece is sent into the pane, spaced by `--pace`, so the agent processes between sends (the human paste → wait → paste rhythm). Its own top-level verb, push-direction — the walker leads and does not wait for replies; the spacing does the work. Reach for `walk` on onboarding, repriming, or a fleet update — anything absorbed in order rather than all at once.

### The delivery grammar — send a ref, walk a pack, or attach it to a qitem

| When | Verb |
|---|---|
| One thing, now | `SoftwareTeam send <seat> --context <ref>` |
| One thing, everyone | `SoftwareTeam broadcast --software-team <SoftwareTeam> --context <ref>` |
| A sequence, absorbed | `SoftwareTeam walk <seat> --through <ref> --pace 10s` |
| Context riding a durable handoff | `SoftwareTeam queue create … --body-context <ref>` |

- **Rule of thumb:** small piece → `send --context`; real pack → `walk`. An oversized `send --context` warns "this is walk-sized" instead of blasting the pane.
- **`--body-context` snapshot rule:** a qitem built from a ref stores the **resolved content** in its body **plus the ref for provenance** — the handoff carries what was actually sent, and a later library edit never silently rewrites a past handoff's history.
- **The orchestrator habit — assign work *with* its context attached:**
  ```bash
  SoftwareTeam context compose --out packs/qitem-brief --from <brief-file> <proof-file>
  SoftwareTeam queue create --destination dev-driver@build --body-context packs/qitem-brief \
    --summary "…" --tags "project:<id>,mission:<id>,slice:<id>"
  ```
  Replace `<brief-file>` and `<proof-file>` with your existing local files. The curated context rides the durable handoff, survives compaction, and is auditable.

**Skills tier vs context tier:** skills are the HOT tier (ambient, finite, always-visible front-matter); context packs are the COLD tier (unbounded, fetched on instruction — "read `SoftwareTeam context get onboarding-width`"). Don't overrun the skill layer by using skills as context packs — that's what this primitive is for.

## Lifecycle

### Bring a SoftwareTeam up

```bash
SoftwareTeam up <source>
SoftwareTeam up <source> --plan
SoftwareTeam up <source> --yes
SoftwareTeam up <source> --cwd /path/to/project
SoftwareTeam up <source> --existing
SoftwareTeam up <source> --fresh <seat...>
SoftwareTeam up <source> --json
```

`<source>` can be:
- a SoftwareTeam spec path
- a `.softwareteambundle` path
- a bare name

Bare names are special:
- if they match a library spec, `SoftwareTeam up` launches from the spec library
- if they do not match a library spec, `SoftwareTeam up` treats the name as an existing-SoftwareTeam restore/power-on target
- if both exist, `SoftwareTeam up` fails loudly on ambiguity

Resume-original-by-default (v0.3.4+):
- For an existing SoftwareTeam, `SoftwareTeam up <name>` resumes each seat from its original session/snapshot by default (operation A). Seats that successfully resume report `resumed`.
- `--fresh <seat...>` is the per-seat opt-in for deliberate fresh-prime (operation B). Named seats are reported as `fresh-primed`.
- `--existing` forces existing-SoftwareTeam restore semantics on a bare name, bypassing library-spec resolution. Useful when a SoftwareTeam name collides with a library spec name.
- Example: `SoftwareTeam up --existing my-SoftwareTeam --fresh dev-impl` — resume everything in `my-SoftwareTeam` except `dev-impl`, which is freshly primed.
- Seats with no resumable session land in `awaiting-decision` (zero-session honest state, NOT `failed`); see the five-term restore vocabulary in "Recovery and Resilience" below.

`--plan` (v0.3.4+):
- `SoftwareTeam up <source> --plan` produces a read-only restore plan preview. It surfaces per-seat resume/fresh-prime intent and any awaiting-decision seats without mutating state. Honest async timeout: a stuck plan reports the timeout rather than hanging silently.

Current behavior notes:
- `--target <root>` is only for `.softwareteambundle` / package installation. It does not change agent cwd.
- `SoftwareTeam up --cwd` is shipped. `SoftwareTeam up --cwd <path>` sends a per-run cwd override for all members in that launch.
- `local:` `agent_ref` values resolve relative to the SoftwareTeam spec directory, not your shell cwd.
- if you copy a built-in spec elsewhere, keep its `agents/` tree beside the YAML or rewrite those refs to `path:/absolute/path`
- `SoftwareTeam specs add <directory>` installs a full spec tree when the directory contains `software-team.yaml` or `agent.yaml`.
- **Permission policy:** a SoftwareTeam carries a permission policy and boots with it (never changed on the fly). Default if none set = the minimum floor (Claude `acceptEdits` / Codex workspace-only / Pi `--no-approve`); otherwise a chosen built-in (Locked / Standard / Open) or deliberately none. When you spec or bring up a SoftwareTeam, decide its policy — apply it via `applying-a-permission-policy` (see also the onboarding menu, "Permission policy — pick one at setup").

Legacy/spec-specific surfaces still ship too:

```bash
SoftwareTeam bootstrap <spec> [--plan] [--yes] [--json]
SoftwareTeam requirements <spec> [--json]
```

### Tear a SoftwareTeam down

```bash
SoftwareTeam down <SoftwareTeam>            # <SoftwareTeam> = SoftwareTeam name or id (active SoftwareTeam)
SoftwareTeam down <SoftwareTeam> --snapshot
SoftwareTeam down <SoftwareTeam> --delete
SoftwareTeam down <SoftwareTeam> --force
SoftwareTeam down <SoftwareTeam> --json
```

If `--snapshot` succeeds, human output includes the restore hint.

### Archive a stopped SoftwareTeam (recoverable) — v0.3.3+

```bash
SoftwareTeam archive <SoftwareTeam> [--json]
SoftwareTeam unarchive <SoftwareTeam> [--json]
```

`SoftwareTeam archive` marks a stopped SoftwareTeam as archived (sets `archivedAt`) without
discarding it. The SoftwareTeam is preserved for later restoration via `SoftwareTeam unarchive`,
which clears `archivedAt` and returns the SoftwareTeam to the active set.

Archive vs delete:
- `SoftwareTeam down --delete` — permanent removal; not recoverable.
- `SoftwareTeam archive` — recoverable; the SoftwareTeam is hidden from the default active view but its record + snapshots are preserved.

Visibility in `SoftwareTeam ps`:
- `SoftwareTeam ps` — active SoftwareTeams only (default).
- `SoftwareTeam ps --include-archived` — includes archived SoftwareTeams, marked with `*`.

SSE events `SoftwareTeam.archived` / `SoftwareTeam.unarchived` drive Project / dashboard updates;
consumers that depend on the SoftwareTeam list should subscribe rather than poll.

### Environment services

```bash
SoftwareTeam env status <SoftwareTeam>
SoftwareTeam env logs <SoftwareTeam> [service]
SoftwareTeam env down <SoftwareTeam>
```

Use these for service-backed SoftwareTeams and agent-managed apps.
For `secrets-manager`, these are the fastest CLI surfaces for:
- confirming whether Vault is healthy
- reading Vault container logs
- stopping the Vault env without tearing down the specialist session first

### Release management without killing live claimed sessions

```bash
SoftwareTeam release <softwareTeamId>
SoftwareTeam release <softwareTeamId> --delete
SoftwareTeam release <softwareTeamId> --json
```

Use `SoftwareTeam release` for adopted/claimed-session SoftwareTeams when you want SoftwareTeam to stop managing the SoftwareTeam but leave the tmux sessions alive.
This is the safe recovery/reset surface for the "sessions still exist, management is broken or stale" case.
If the SoftwareTeam contains SoftwareTeam-launched nodes, `SoftwareTeam release` refuses loudly instead of pretending the mixed SoftwareTeam is safe to detach.

### Snapshots and restore

```bash
SoftwareTeam snapshot <softwareTeamId>
SoftwareTeam snapshot list <softwareTeamId>
SoftwareTeam restore <snapshotId> --software-team <softwareTeamId>
```

`SoftwareTeam restore` requires `--software-team <softwareTeamId>`.

Claude Code autonomy note:
- unattended `SoftwareTeam whoami` on boot may require the local permission allow list to include `Bash(SoftwareTeam:*)`

### Import/export and bundles

```bash
SoftwareTeam export <softwareTeamId> -o software-team.yaml
SoftwareTeam import <path> [--instantiate] [--materialize-only] [--preflight] [--target-SoftwareTeam <softwareTeamId>] [--software-team-root <root>]
SoftwareTeam bundle create <spec> -o out.softwareteambundle
SoftwareTeam bundle inspect <bundle>
SoftwareTeam bundle install <bundle> [--plan] [--yes] [--target <root>] [--json]
```

### Legacy package surface

This still ships, but is explicitly marked legacy:

```bash
SoftwareTeam package validate <path>
SoftwareTeam package plan <path> [--target <dir>] [--runtime <runtime>] [--role <name>]
SoftwareTeam package install <path> [--target <dir>] [--runtime <runtime>] [--role <name>] [--allow-merge]
SoftwareTeam package list
SoftwareTeam package rollback <installId>
```

## Discovery and Topology Mutation

### Discover unmanaged tmux sessions

```bash
SoftwareTeam discover
SoftwareTeam discover --json
SoftwareTeam discover --draft
```

### Bind a discovered session

```bash
SoftwareTeam bind <discoveredId> --software-team <softwareTeamId> --node <logicalId>
SoftwareTeam bind <discoveredId> --software-team <softwareTeamId> --pod <namespace> --member <name>
```

There is no shipped top-level `SoftwareTeam claim` command.
The current adoption surface is `discover`, `bind`, `adopt`, and `unclaim`.

### Self-attach the current shell or agent

```bash
SoftwareTeam attach --self --software-team <softwareTeamId> --node <logicalId>
SoftwareTeam attach --self --software-team <softwareTeamId> --node <logicalId> --print-env
SoftwareTeam attach --self --software-team <softwareTeamId> --pod <namespace> --member <name> --runtime <runtime>
```

Use `SoftwareTeam attach --self` when the current agent should attach itself directly instead of going through `discover` + `bind`.

Current proven behavior:
- inside `tmux`: attaches as a normal tmux-backed node, preserving inbound `SoftwareTeam send` / `SoftwareTeam capture`
- outside `tmux`: attaches as `external_cli`
- `--print-env` prints the `SOFTWARETEAM_NODE_ID` and `SOFTWARETEAM_SESSION_NAME` exports for the current shell

Recommended flow:

```bash
SoftwareTeam attach --self --software-team <softwareTeamId> --node <logicalId> --print-env > /tmp/softwareteam-self-attach.env
. /tmp/softwareteam-self-attach.env
SoftwareTeam whoami --json
```

Notes:
- for tmux-backed self-attach, `SoftwareTeam whoami --json` is the right verification
- for raw/external self-attach, `SoftwareTeam ps --nodes --json` is currently the more reliable verification surface
- if the current shell is outside tmux, pass `--display-name <name>` when you want a stable human session label recorded

### Adopt a topology and bind live sessions

```bash
SoftwareTeam adopt <path> --bind <logicalId=tmuxSessionOrDiscoveryId>
SoftwareTeam adopt <path> --bind <logicalId=...> --bind <logicalId=...> --json
SoftwareTeam adopt <path> --bindings-file <bindings.yaml>
SoftwareTeam adopt <path> --bind <logicalId=...> --target-SoftwareTeam <softwareTeamId> --software-team-root <root>
```

Use `SoftwareTeam adopt` when the sessions already exist and you want SoftwareTeam to start managing them.

A bindings file is the durable map from authored logical IDs to live sessions. Shape:

```yaml
bindings:
  dev1.impl2: dev1.impl2@softwareteam-buildout
  dev1.qa: dev1.qa@softwareteam-buildout
```

Spec + bindings is the proven recovery pair for adopted SoftwareTeams.
Spec gives SoftwareTeam the intended topology. Bindings tells SoftwareTeam which discovered live session belongs in each logical node.

### Proven adopted-SoftwareTeam recovery workflow

This workflow is proven for the case where the external tmux sessions are still alive:

```bash
SoftwareTeam release <softwareTeamId> --delete
SoftwareTeam discover --json
SoftwareTeam adopt <spec.yaml> --bindings-file <bindings.yaml>
```

What this does:
- removes SoftwareTeam management without killing the sessions
- re-discovers those same sessions as unmanaged
- re-attaches them to the topology defined by the spec + bindings

Important limits:
- this is for `sessions still alive`
- spec alone is not enough for adopted SoftwareTeams; you also need bindings
- this does not yet mean SoftwareTeam can recreate dead external sessions from nothing

### Add unmanaged pods into an existing SoftwareTeam

This is the proven workflow when a SoftwareTeam is already managed, but a new pod was created outside SoftwareTeam and you want to add it later:

```bash
SoftwareTeam adopt <pod-fragment.yaml> --bindings-file <pod.bindings.yaml> --target-SoftwareTeam <softwareTeamId>
```

Use this when:
- the target SoftwareTeam already exists
- the new sessions are live and visible in `SoftwareTeam discover --json`
- you want additive topology growth, not a full rebuild

What to prepare:
- a pod fragment spec with only the new pod
- a bindings file mapping the new logical IDs to the live session names

Verification loop:

```bash
SoftwareTeam discover --json
SoftwareTeam adopt <fragment.yaml> --bindings-file <bindings.yaml> --target-SoftwareTeam <softwareTeamId>
SoftwareTeam ps --nodes --software-team <softwareTeamId>   # the target SoftwareTeam's nodes (--nodes alone = your current SoftwareTeam)
SoftwareTeam export <softwareTeamId> -o software-team.yaml
```

Success looks like:
- the new sessions stop appearing in `SoftwareTeam discover`
- the new logical IDs appear in `SoftwareTeam ps --nodes --software-team <softwareTeamId>`
- `SoftwareTeam export` includes the new pod

### Mixed-origin SoftwareTeams are allowed

One SoftwareTeam can contain both:
- adopted nodes bound from already-running sessions
- SoftwareTeam-launched nodes created later with `SoftwareTeam expand` / `SoftwareTeam launch`

Current safety rule:
- `SoftwareTeam release` is for claimed/adopted-only SoftwareTeams
- if a SoftwareTeam contains launched nodes, `SoftwareTeam release` fails with `contains_launched_nodes`

### Manager-assisted recovery

The proven operator pattern is:
- keep one SoftwareTeam manager session outside the SoftwareTeam it manages
- address the target by SoftwareTeam name, not cached SoftwareTeam ID
- find the target SoftwareTeam with bare `SoftwareTeam ps` (lists all SoftwareTeams), then resolve its owner from `SoftwareTeam ps --nodes --software-team <target>` (a bare `--nodes` read is your current SoftwareTeam only, not the target's)
- send the manager the spec path, bindings path, and verification steps with `SoftwareTeam send`

This lets ordinary agents ask the manager for SoftwareTeam help instead of every agent needing to be an SoftwareTeam expert.

### Add/remove running topology parts

```bash
SoftwareTeam grow <software-team-id> <member...> [--pod <pod> | --new-pod <pod>] [--runtime <runtime>] [--cwd <path>] [--json]
SoftwareTeam expand <software-team-id> <pod-fragment-path> [--software-team-root <path>] [--json]
SoftwareTeam launch <SoftwareTeam> <nodeRef> [--json]
SoftwareTeam launch <SoftwareTeam> --seats <a,b,c> [--hold-reason <text>] [--json]
SoftwareTeam remove <softwareTeamId> <nodeRef> [--json]
SoftwareTeam shrink <softwareTeamId> <podRef> [--json]
SoftwareTeam unclaim <sessionRef> [--json]
```

`SoftwareTeam grow` is the simplest way to add seats: no YAML, the default agent spec, and one
runtime and working directory for the named seats (`--new-pod` creates a pod for them).
Check `SoftwareTeam grow --help` on your installed version. Use a fragment with `SoftwareTeam expand` (a pod)
or `SoftwareTeam add` (one member) when a seat needs an explicit model, a permission policy, a
different agent spec or role profile, per-seat runtime or cwd, or startup files.

Node-granular managed partial restore (v0.3.4+):
- `SoftwareTeam launch <SoftwareTeam> <nodeRef>` relaunches a single seat by logical id or node id through orchestration. `<SoftwareTeam>` is the
  SoftwareTeam's name or ID; a name shared by more than one active SoftwareTeam stops with the candidate IDs.
- `SoftwareTeam launch <SoftwareTeam> --seats <a,b,c>` relaunches a comma-separated subset of seats.
- `--hold-reason <text>` records a reason for holding non-target seats during the partial launch.
- This is a SUPPORTED managed path. The prior `pod_aware_launch_unsupported` dead-end is retired; pod-aware narrow launch now goes through this surface rather than ad-hoc rebuilds.

### Add a member to an existing pod — v0.3.3+

```bash
SoftwareTeam add <SoftwareTeam> <pod-namespace> <member-fragment-path> [--json]
```

`SoftwareTeam add` is the top-level verb for the `add_member` converge op. It adds a
single member to an existing pod from a YAML/JSON member fragment file. The
daemon resolves the named pod, validates the member, runs preflight, and
launches the member in place.

`<SoftwareTeam>` is the SoftwareTeam id or its exact name (the `softwareTeamName` that `SoftwareTeam whoami --json`
reports). A name shared by more than one SoftwareTeam is refused before anything is
added, with the matching ids listed (`software_team_ambiguous` under `--json`). `SoftwareTeam add`
always targets the local daemon: while a remote host is selected it refuses to
resolve a name (`remote_host_selected`); an exact local id still works.

HTTP outcomes:
- `201` — member added; per-node launch state included in the response.
- `400` — `validation_failed` or `preflight_failed` (the fragment or its launch posture is rejected before any state change).
- `409` — `member_conflict` (a member with that identity already exists in the pod).

Use `SoftwareTeam add` when you want additive growth inside a pod without re-running
the full `SoftwareTeam expand` pod-fragment path or rebuilding the SoftwareTeam.

## Specs and Validation

### Validate specs

```bash
SoftwareTeam spec validate <path> [--json]
SoftwareTeam spec preflight <path> [--software-team-root <root>] [--json]
SoftwareTeam agent validate <path> [--json]
```

### Spec library

```bash
SoftwareTeam specs ls [--kind <kind>] [--json]
SoftwareTeam specs show <name-or-id> [--json]
SoftwareTeam specs preview <name-or-id> [--json]
SoftwareTeam specs add <yaml-or-directory> [--json]
SoftwareTeam specs sync [--json]
SoftwareTeam specs remove <name-or-id> [--json]
SoftwareTeam specs rename <name-or-id> <new-name> [--json]
```

## MCP

```bash
SoftwareTeam mcp serve [--port <port>]
```

Current shipped MCP tools:
- `software_team_up`
- `software_team_down`
- `software_team_ps`
- `software_team_status`
- `software_team_snapshot_create`
- `software_team_snapshot_list`
- `software_team_restore`
- `software_team_discover`
- `software_team_bind`
- `software_team_bundle_inspect`
- `software_team_agent_validate`
- `software_team_software_team_validate`
- `software_team_software_team_nodes`
- `software_team_send`
- `software_team_capture`
- `software_team_chatroom_send`
- `software_team_chatroom_watch`

## Troubleshooting and Weird States

When the CLI behaves strangely, use the smallest truthful check first:

```bash
SoftwareTeam whoami --json
SoftwareTeam daemon status
SoftwareTeam ps --nodes --json
```

Specific operator rules:
- `Sent to ...` + `Verified: no` is ambiguous delivery, not automatic failure. Check reply, `SoftwareTeam capture`, transcript evidence, or queue/outbox state before retrying.
- partial `SoftwareTeam whoami --json` can happen when identity is still inferable but the daemon-backed path is degraded.
- the unified-exec-process warning is a host/tooling-layer signal, not automatic proof that the SoftwareTeam topology is unhealthy.

If you hit the unified-exec warning, inspect for stale one-shot helpers before touching live seats:

```bash
ps -axo pid,ppid,command | rg 'tmux send-keys|SoftwareTeam queue create|tmux attach|codex|claude'
```

Safe cleanup target:
- orphaned one-shot wrappers like `tmux send-keys ...`

Do not mass-kill:
- `tmux attach ...`
- `codex ...`
- `claude ...`

## JSON and Error Posture

Design assumptions that hold in the shipped CLI:
- many operator commands support `--json`
- error messages are intended to say what happened, why it matters, and what to do next
- daemon-backed commands fail loudly when the daemon is stopped or unhealthy
- restore failure is not something you should silently reinterpret as success

## After-Compaction Recovery Checklist

1. `SoftwareTeam whoami --json`
2. `SoftwareTeam transcript <your-session> --tail 100`
3. `SoftwareTeam ps` — lists ALL SoftwareTeams on the host (know the world FIRST); then `SoftwareTeam ps --nodes --software-team <your-SoftwareTeam>` for your seats. ⚠ `SoftwareTeam ps --nodes --json` alone is your CURRENT SoftwareTeam only — do NOT mistake it for the whole host (a freshly-compacted agent has no other context to catch the lie).
4. `SoftwareTeam chatroom history <SoftwareTeam> --limit 50`

## Commands That Do Not Exist

Do not assume these exist unless the shipped help starts listing them:
- `SoftwareTeam claim`
- `SoftwareTeam blame`
- `SoftwareTeam replay`
