---
name: softwareteam-skills
description: "Use when an agent running inside SoftwareTeam needs the right skill or context for fleet recovery, seat handover, new-seat orientation, a watchdog wake, cross-host reach to an agent on another machine, SoftwareTeam packaging, an SoftwareTeam upgrade, systematic debugging, queue triage, or implementation planning; also when the agent doesn't know what applies or nothing is projected on cold boot. Installing, starting or updating SoftwareTeam, getting back to a team or bringing a stopped one back from a person's own session is the SoftwareTeams skill."
allowed-tools: Bash(SoftwareTeam:*)
metadata:
  softwareteam:
    stage: shipped
---

# SoftwareTeam skills — the index (start here)

You're running inside SoftwareTeam. SoftwareTeam ships a set of **skills** — small documents that tell you *when* to do something and *how*. This file is the map: what ships, when to reach for each, and how to load it. If you don't know which skill applies, or nothing is projected into your context, **start here.**

## How SoftwareTeam context works (30 seconds)

Skills are **progressive disclosure**: a skill's *name + description* sit in your context ambiently (the "hot tier"); its *body* loads only when you open it. So you don't pre-read everything — you pattern-match a skill's "when" to your moment, then open just that one. This file recommends skills from the shipped set. (For bounded procedures, open `agent-operated-workflows`; for ongoing agent-backed applications, open `agent-operated-software`.)

Every row below names **how to reach the skill** — already-hot, or an exact load path. No row is a dead end.

## Loading an entry on demand — `SoftwareTeam context get`

Don't guess a file path or a name. Go **ask → ref → load** in three steps:

1. **Discover** — run `SoftwareTeam context list` for every shipped entry's **ref** and name. The *when* for
   each is the index below (or `SoftwareTeam context list --json`, which carries each entry's purpose) — match
   your moment there.
2. **Select** — match your moment to a row's *when* and take its **ref**. Refs are canonical full paths
   that mirror the library layout — `skills/<namespace>/<name>` (e.g. `skills/core/software-team-lifecycle`,
   `skills/process/systematic-debugging`). A unique bare name (e.g. `watchdog`) also resolves; any
   slash-bearing ref is an exact lookup and fails loud if it does not exist.
3. **Load** — `SoftwareTeam context get skills/<namespace>/<name>`:

```
SoftwareTeam context get skills/core/software-team-lifecycle
```

The router itself is available through both forms it teaches:
`SoftwareTeam context get softwareteam-skills` and `SoftwareTeam context get skills/core/softwareteam-skills`.

The content is served **from the installed CLI**, so what you load always matches your running version —
no path-guessing, no frozen-fork drift. (The daemon assembles the same bundle `SoftwareTeam context preview`
shows an operator — `get` is the agent-facing pull.)

## The index

> Membership rule (`layout.skills[*].edges.length > 0`): this index recommends skills from the public product edges. Optional procedures remain available through `SoftwareTeam context list` without a recommendation here.

### Always loaded — the universal spine (open its body when its moment hits)
These are auto-delivered to every SoftwareTeam; their name+description are already in your context. Open the body when the "when" matches.

- **forming-an-softwareteam-mental-model** — first boot, or you're unsure how the pieces fit. The runtime mental model.
- **softwareteam-operating-model** — you do not know where context or work belongs, or you are about to duplicate knowledge. The two-tree placement and trace-to-root model.
- **softwareteam-user** — you need a `SoftwareTeam` CLI command (send / queue / ps / whoami / scope / broadcast). The daily CLI surface.
- **applying-a-permission-policy** — a SoftwareTeam or seat has a permission policy attached, or you're setting one up: translate it into the live harness configuration.
- **claude-compaction-restore** — you just compacted (Claude). Restore from durable evidence before resuming real work.
- **delegating-work** — deciding who should do a task: you, a spawned subagent, or a durable peer seat that already holds the context.
- **loading-addressable-markdown** — a task names Markdown as `path#h2-slug` or `path#h2-slug/h3-slug` outside the context-pack library.
- **session-compaction-and-restore** — preparing for, or recovering from, compaction (any runtime). The write- and read-side protocol.
- **queue-handoff** — you're passing durable work to another seat or ending your turn. The queue is the work ledger, not chat.
- **refocusing** — invoke as `refocusing` when a long-running seat may have lost the product outcome, crossed a major boundary, or compacted and needs a fresh path-based trace.
- **seat-continuity-and-handover** — handing your seat's work across a restart or to another owner.
- **orienting-to-an-inherited-seat** — you just inherited an existing seat through a planned handover and need to verify its identity, state, and testimony.
- **retiring-and-inheriting-a-seat** — you're planning a seat transition and need to retire the current occupant into a fresh successor without losing continuity.
- **mission-slice-sop** — you're working a mission/slice (the SDLC: intent → mini-requirements + proof contract → build → QA → proof). The operating manual.
- **messaging-the-human** — composing a message to the human. Plain language, no insider jargon.
- **agent-operated-workflows** — a bounded real-world procedure needs an agent to interpret state and operate exact tools, or you are deciding whether ordinary code should own the loop.
- **agent-operated-software** — you are designing or operating an ongoing application whose live backend includes SoftwareTeam agents.
- **software-for-agents** — compatibility redirect for the former `agent-operated-software` name; remove in 0.6.0.
- **softwareteam-skills** — this index (you're reading it). Always loaded; the entry point to everything below.

### Load when your role or task calls for it (repo-shipped, profile-selected)
These ship in the SoftwareTeam repo and reach a seat when its profile selects them. To use one, select it in your profile's `uses.skills`, or open it directly at `packages/daemon/specs/agents/shared/skills/core/<skill>/SKILL.md`.

- **softwareteam-software-factory** — a user wants continuing reviewed work: manual/team, queue-only orchestration or an explicit Workflow; add one or two seats to the running starter when useful, with context, ownership, concurrency, spend and permission limits. Load `SoftwareTeam context get skills/core/softwareteam-software-factory/SKILL.md`.
- **softwareteam-architect** — authoring a SoftwareTeam or topology (NOT for changing SoftwareTeam itself — that's `developing-softwareteam`).
- **softwareteam-cmux** — driving the `cmux` terminal provider.
- **softwareteam-herdr** — opening/managing seat terminals via the default proof-gated provider.
- **agent-startup-and-context-ingestion** — a seat is booting and ingesting its startup context.
- **topology-mutation-and-seat-management** — adding, removing, renaming seats or otherwise mutating SoftwareTeam topology.
- **software-team-lifecycle** — SoftwareTeam up / down / pause / resume lifecycle operations.
- **software-team-bundles-and-shareable-artifacts** — packaging or installing a SoftwareTeam bundle / shareable artifact.
- **cross-host-software-team-commands** — reaching seats or queues on another host (`--host`).
- **softwareteam-upgrade** — upgrading SoftwareTeam or the daemon.
- **agent-starters** — composing an agent's starter context / priming packs.
- **specification-system** — authoring or reading AgentSpecs and SoftwareTeam specs.
- **human-in-the-loop** — deciding when to involve the human vs. proceed on your own authority.
- **watchdog** — monitoring or recovering a seat (health, restore, stuck state).
- **session-source-fork** — forking a session's source/context.
- **context-engineering** — designing context systems. Provisional and non-normative: current SoftwareTeam skills, explicit rulings, and measured practice outrank it on any conflict.

Pod handbooks (load when you're in that pod):
- **orchestration-team** — you're orchestrating a SoftwareTeam: dispatching, monitoring, keeping the loop moving.
- **development-team** — you're on the dev pod: building and shipping product changes.
- **review-team** — you're reviewing: fresh scrutiny, anti-slop, empirical verification.
- **oversight-team** — you're in an oversight pod: monitor boundaries and route findings without taking over the work.

Product-management craft (load when shaping/reviewing work):
- **requirements-writer** — turning intent into clear requirements.
- **plan-review** — reviewing a plan before it's built.
- **exec-summary** — writing a decision-ready summary for a human.
- **office-hours** — running a structured advisory / decision session.
- **context-builder** — assembling the context a task or seat needs.
- **backlog-capture** — capturing and shaping backlog items.
- **ui-mockup** — producing a UI mockup for a slice.

### Vendored craft — load when you're coding (ships with upstream provenance)
General engineering skills SoftwareTeam ships as vendored copies. Open when the task matches; they retain their inherited "modified by OpenRig" provenance. SoftwareTeam changes
product names, paths and integration instructions; it does not claim those earlier modifications.

- **verification-before-completion** — about to claim done / passing / fixed: run the check and read the output first.
- **systematic-debugging** — debugging: find the root cause before the fix.
- **agent-browser** — driving a browser (screenshot / screencast) from an agent.
- **frontend-design** — designing frontend / UI.
- **dogfood** — web-QA / dogfooding a shipped UI.

## When SoftwareTeam itself misbehaves

Run `SoftwareTeam context get help`: the one help guide for your installed version, from symptom to next step, known problems,
and a useful report to the SoftwareTeam team if you are still stuck. If `SoftwareTeam` won't run, read
`daemon/docs/reference/help.md` inside the installed `@softwareteam/cli` package, or https://github.com/lw-liuwang/SoftwareTeam/blob/main/docs/reference/help.md
(the same text).

## Developing SoftwareTeam itself

If you're changing SoftwareTeam's own source in a clone of the softwareteam repository, use that repository's
`developing-softwareteam` skill (in the checkout's `.claude/skills/` or `.agents/skills/`). It maps the architecture, the
areas where a small change has a large effect, and which tests to run before a pull request.

## Need more than what ships here?

This index covers the **shipped** surface. Your project, SoftwareTeam or machine may add its own skills and routers. Check the
skills your working directory loads before concluding that something doesn't exist.
