---
name: topology-mutation-and-seat-management
description: Use when changing a SoftwareTeam while it is alive — `SoftwareTeam grow` / `SoftwareTeam expand` / `SoftwareTeam shrink` / `SoftwareTeam launch` / `SoftwareTeam remove` / `SoftwareTeam discover` / `SoftwareTeam bind` / `SoftwareTeam adopt` / `SoftwareTeam attach`. Covers the 4 failure modes (newly created seat lacks queue/startup/role; edges and permissions not updated; adopt/bind succeeds at tmux but not SoftwareTeam identity; shrink/remove leaves stale topology references) and the rule that mutation must work while the SoftwareTeam is active, not just in clean fixtures.
metadata:
  cli_surfaces_referenced:
    - adopt
    - attach
    - bind
    - discover
    - expand
    - grow
    - launch
    - ps
    - release
    - remove
    - shrink
    - unclaim
    - up
    - whoami
  softwareteam:
    stage: factory-approved
    sibling_skills:
      - software-team-lifecycle
      - seat-scaling-and-specialization
      - cross-host-software-team-commands
      - sidecar-operator
      - software-team-bundles-and-shareable-artifacts
      - specification-system
      - extension-and-user-workspace
---

# Topology Mutation and Seat Management

The ability to change a SoftwareTeam **while it is alive**: expand, shrink,
launch, remove, discover, bind, adopt, and attach seats or sessions.
Seat management includes the **stable identifiers, edges, roles, and
startup context** that make those mutations coherent.

**SoftwareTeam should be easy to reach for.** A user should be able to add
capacity, retire capacity, adopt an existing session, or attach a
terminal **without rebuilding the whole topology.** If mutation is
rarely tested, users avoid it and the product collapses back into
static launch scripts.

## Use this when

- Adding seats to a running SoftwareTeam (`SoftwareTeam grow <software-team-id> <member...>` for the simple case, a fragment with `SoftwareTeam expand` or `SoftwareTeam add` otherwise; see below)
- Removing capacity (`SoftwareTeam shrink` / `SoftwareTeam remove`)
- Launching/relaunching a node in a running SoftwareTeam (`SoftwareTeam launch`)
- Binding a discovered session into an existing logical node (`SoftwareTeam bind`)
- Adopting a topology + binding live sessions (`SoftwareTeam adopt`)
- Attaching a shell or agent into a SoftwareTeam node (`SoftwareTeam attach --self`)

## Adding seats: `SoftwareTeam grow` first, a fragment when you need more

`SoftwareTeam grow <software-team-id> <member...>` adds one or more seats to a running SoftwareTeam without
writing YAML. Each seat gets the default agent spec and its `default` profile.
Check `SoftwareTeam grow --help` on your installed version; at the time of writing:

- `--pod <pod>`: the target pod; inferred when the SoftwareTeam has one pod
- `--new-pod <pod>`: create a new pod for the seats (not together with `--pod`)
- `--runtime <runtime>`: one runtime for every named seat (default `claude-code`)
- `--cwd <path>`: one working directory for every named seat (default: the current directory)
- `--json`: output for agents

Write a fragment instead when a seat needs something `SoftwareTeam grow` does not set: an
explicit model, a permission policy, a different agent spec or role profile, a
per-seat runtime or working directory, or startup files. Use
`SoftwareTeam expand <software-team-id> <pod-fragment-path>` to add a pod, or
`SoftwareTeam add <SoftwareTeam> <pod-namespace> <member-fragment-path>` to add one member to an
existing pod (`<SoftwareTeam>` is the SoftwareTeam id or its exact unique name).

## Don't use this when

- The SoftwareTeam is being created fresh from scratch — use `SoftwareTeam up` (lifecycle, not mutation)
- The intent is to scale specifically (add specialized capacity) — use `seat-scaling-and-specialization` skill
- The intent is occupant replacement on a stable seat — use `seat-continuity-and-handover` skill

## Failure modes (4)

1. **A newly created seat lacks the queue, startup context, or role files it needs to operate.** Topology mutation creates the seat, but the seat needs more than a tmux session to be useful.
2. **Edges and permissions are not updated when a seat is added or removed.** Topology references go stale; later workflows route to nonexistent seats.
3. **Adopt/bind succeeds at the tmux/session layer but not at the SoftwareTeam identity layer.** The session is attached but `SoftwareTeam whoami` doesn't know about it; downstream consumers see partial state.
4. **Shrink/remove leaves stale topology references that later workflows route into.** Cleanup is part of the operation, not an afterthought.

## Proof standard

Proof must cover **mutation while a SoftwareTeam is active**, not just in a
clean test fixture. The useful matrix:

| Operation | What to verify |
|---|---|
| Add seat | New seat has queue, startup context, role; `SoftwareTeam whoami` resolves it |
| Remove seat | Stale references cleaned; edges/permissions updated |
| Adopt existing session | tmux session bound at SoftwareTeam identity layer; `SoftwareTeam whoami` reports correctly |
| Attach observer terminal | External CLI attachment recorded |
| Verify topology projections after each move | `SoftwareTeam ps --nodes` reflects current truth, not pre-mutation cache |

A clean-fixture proof is necessary but not sufficient. Live-SoftwareTeam proof
catches the failure modes that fixture-mode misses.

## Stable roles during topology changes

Capacity changes must preserve useful roles, routing and durable work. Distinguish
adding or removing a seat from replacing its occupant; use
`seat-continuity-and-handover` for the latter.

## Currently shipped surfaces

Per `cli-reference.md` v0.2.0:

- `SoftwareTeam grow <software-team-id> <member...> [--pod <pod> | --new-pod <pod>] [--runtime <runtime>] [--cwd <path>]` (added after v0.2.0; check `SoftwareTeam grow --help`)
- `SoftwareTeam expand <software-team-id> <pod-fragment-path>` (with optional `session_source`)
- `SoftwareTeam shrink <softwareTeamId> <podRef>`
- `SoftwareTeam launch <SoftwareTeam> <nodeRef>` (the SoftwareTeam's name or ID)
- `SoftwareTeam remove <softwareTeamId> <nodeRef>`
- `SoftwareTeam discover [--draft]`
- `SoftwareTeam bind <discoveredId> --software-team <softwareTeamId> (--node <id> | --pod <ns> --member <name>)`
- `SoftwareTeam adopt <path> --bind <logicalId=tmuxSessionOrDiscoveryId>`
- `SoftwareTeam attach --self --software-team <softwareTeamId> --node <logicalId>`
- `SoftwareTeam unclaim <sessionRef>` / `SoftwareTeam release <softwareTeamId>`

## Choose the proving environment and authority

Select an isolated active SoftwareTeam or an explicitly authorized live target for the
relevant operation. Record its running build, before/after topology, continuity
and outstanding work. A passing schema check or isolated fixture does not prove
an existing live SoftwareTeam was changed correctly. A runtime timeout is indeterminate
until its durable and process effects are reconciled; do not retry blindly.

The matrix above is verification guidance, not permission to modify another
SoftwareTeam. Name the operation's owner and scope, preserve the state needed for recovery,
and retain missing or failed checks in the result. No local experiment or
unfinished proof obligation is implied by loading this skill.

## See also

- `softwareteam-user` skill — CLI surface for `SoftwareTeam grow / expand / shrink / launch / remove / bind / adopt / attach`
- `seat-scaling-and-specialization` skill — when to add specialized capacity vs generic
- `seat-continuity-and-handover` skill — replacing an occupant on a stable seat (different shape than topology mutation)
- `cross-host-software-team-commands` skill — cross-host topology mutation (deferred)
