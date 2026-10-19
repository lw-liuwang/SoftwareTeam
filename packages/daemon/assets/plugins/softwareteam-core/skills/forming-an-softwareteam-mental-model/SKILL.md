---
name: forming-an-softwareteam-mental-model
description: >-
  Use when the system around you does not make sense yet: you just booted into a seat and do not
  know how the pieces fit; someone said SoftwareTeam, pod, seat, fleet, topology, or slice and you are not
  certain what they mean here; you are unsure what kind of SoftwareTeam you are in or what it is for; you do
  not know how skills reach you or where context comes from; or you are about to act on a guess
  about how SoftwareTeam works. Gives the runtime mental model fast, so you stop guessing.
metadata:
  cli_surfaces_referenced:
    - ask
    - capture
    - down
    - ps
    - send
    - transcript
    - up
    - whoami
  softwareteam:
    stage: factory-approved
    sibling_skills:
      - softwareteam-user
      - softwareteam-architect
      - softwareteam-upgrade
      - agent-operated-workflows
      - agent-operated-software
---

# Forming an SoftwareTeam Mental Model

You're new to SoftwareTeam — or returning after time away — and you need to
quickly understand what kind of system this is, what your seat is, and what
the moves are. This skill is the fast on-ramp.

For depth, read the canonical reference docs the skill points to. This
skill's job is to get you *oriented* — accurate enough to operate, fast
enough to be useful — not to replace the canonical docs.

---

## The 60-second mental model

SoftwareTeam is a **local control plane for multi-agent coding topologies**. You
declare a topology of agents in YAML, boot it with one command, and SoftwareTeam
manages tmux sessions, harness lifecycles, transcripts, snapshots, and
restoration. When the system goes down, SoftwareTeam snapshots; when it comes
back, agents resume their conversations.

The product loop:

```
down (auto-snapshot) → up <software-team-name> (auto-restore) → work → repeat
```

The unit of work is the **SoftwareTeam** — a topology of agents working together as
a single system.

---

## The four-layer model (where you live)

Everything in agent engineering happens at one of four layers. **SoftwareTeam
operates at Layer 3.**

| Layer | Name | Analogy | What it is |
|---|---|---|---|
| L0 | Model | CPU | Foundation model — Claude, GPT, Gemini. Stateless tokens-in/tokens-out. |
| L1 | Agent Core | Process loop | The reason-and-act cycle: observe, plan, choose, act, repeat. |
| L2 | Harness | Container / OS | Tools, memory, lifecycle around the model. Examples: Claude Code, Codex CLI. |
| L3 | SoftwareTeam | Docker Compose / Terraform | Multi-agent topology — what agents exist, how they relate. **SoftwareTeam.** |

You are an agent at L1 inside an L2 harness, configured by L3 SoftwareTeam.
SoftwareTeam manages your harness; the harness wraps the model; the model
generates your tokens.

---

## Three pillars of context

SoftwareTeam is built on three context-engineering pillars. When you're oriented,
you should know which pillar you're operating in:

| Pillar | What it is | Where it lives |
|---|---|---|
| **Ontology** | What exists. Curated knowledge — facts, code maps, as-built docs. | Shipped public context packs plus project-authored docs; discover with `SoftwareTeam context list`. |
| **Epistemology** | Why an agent believes what it believes — reasoning, instincts, decisions. | Transcripts (auto-captured). Session logs. ADRs. |
| **Topology** | How agents are connected — pods, edges, communication paths. | SoftwareTeam itself. SoftwareTeamSpec YAML. |

SoftwareTeam manages topology and exposes public context through `SoftwareTeam context`.
Project-authored sources supply project-specific knowledge; transcripts retain
recorded work. These sources already coexist. Discover the configured library
and selected task context rather than assuming a particular private corpus:
`SoftwareTeam context list` shows the configured packs, and `SoftwareTeam context work-install`
lists what the current project declares (intent, context files, skills), so you
read only the pieces a task needs.

---

## The core vocabulary (read these terms literally)

| Term | What it means |
|---|---|
| **SoftwareTeam** | A topology of agents working together as a single system. Defined in YAML (SoftwareTeamSpec). The top-level object. |
| **Pod** | A bounded context group within a SoftwareTeam. Members of a pod share a context domain and continuity responsibility. Think Kubernetes pod for knowledge. |
| **Member / Node** | A single agent (or terminal-node service) within a pod. |
| **Edge** | A relationship between members or pods. Kinds: `delegates_to`, `spawned_by`, `can_observe`, `collaborates_with`, `escalates_to`. |
| **Topology** | The shape of the SoftwareTeam — how agents are grouped into pods, how edges connect them, how the whole thing fits together. |
| **AgentSpec** | A reusable agent blueprint. Defines skills, guidance, hooks, profiles, startup. File: `agent.yaml`. |
| **SoftwareTeamSpec** | The topology YAML. Defines pods, members, edges, culture. File: `software-team.yaml`. |
| **SoftwareTeamBundle** | A portable archive of a SoftwareTeamSpec + vendored AgentSpecs. Move topologies across machines. |
| **Agent Starter** | A named, reusable starting context bundle. SoftwareTeamSpec member can declare `starter_ref`. |
| **Skill** | A markdown file with frontmatter that an agent loads at boot or on activation. Cross-runtime standard at `agentskills.io`. |
| **Profile** | A named configuration within an AgentSpec. The SoftwareTeam spec's member field selects which profile to use. |
| **Culture** | SoftwareTeam-wide constitution — how the team communicates, what "done" means, escalation rules. File: `CULTURE.md`. |
| **Snapshot** | Point-in-time capture of a SoftwareTeam — sessions, conversations, state. Restorable. |
| **Session name** | `{pod}-{member}@{SoftwareTeam}`. The canonical address for tmux sessions and agent-to-agent messaging. |

The session-name format `{pod}-{member}@{SoftwareTeam}` is your address. When you
run `SoftwareTeam whoami --json`, you get back your full topology context: SoftwareTeam name,
pod, member, peers, edges, transcript path. On a large SoftwareTeam the peer list can be
a bounded, edge-first selection: `peersNote` then says how many are not shown,
and `SoftwareTeam whoami --json --all-peers` lists them all.

---

## SoftwareTeam classes (what kind of SoftwareTeam am I in?)

SoftwareTeam has five SoftwareTeam classes. The class determines authoring discipline,
supervision, and lifecycle policy.

| Class | Purpose | Lifecycle |
|---|---|---|
| **kernel** | Host-level supervision, intake, authoring. One per host. | Always on; never auto-hibernated. |
| **project** | Long-lived team bound to a codebase. | Stays hot when active; hibernates on explicit request. |
| **ephemeral** | Short-lived mission (research, build, migration, spike). | Spawn → work → retire. |
| **infra-build** | Subclass of ephemeral whose output becomes permanent infrastructure. | Retired only after output verified in place. |
| **managed-app** | Services-backed SoftwareTeam with specialist agents (e.g., a vault specialist, a skill librarian). | Long-lived; accessed by other SoftwareTeams. |

You're probably in a project SoftwareTeam or managed-app SoftwareTeam if you're doing
substantive work. Knowing your class helps you understand the supervisory
expectations on your seat.

---

## How skills load (the most important thing to get right)

Skills are an **established cross-runtime standard** at
`https://agentskills.io/specification`. Both Claude Code and Codex build on it.

### The shape

A skill is a directory containing `SKILL.md` (uppercase). The SKILL.md has
YAML frontmatter (`name`, `description`) and a Markdown body. Optional
sibling directories: `references/`, `scripts/`, `assets/`.

### Progressive disclosure (why skills scale)

The harness reads frontmatter cheaply at boot — names + descriptions of all
available skills. Body content loads only when a skill activates. This is
**ambient awareness** — you know all the skills exist; you only pay token
cost when you reach for one.

### Where skills come from in SoftwareTeam

- **Per-agent loadout:** your AgentSpec's `profile.uses.skills: [...]`
  determines what skills get projected into your runtime skill folder
  (`.claude/skills/` or `.agents/skills/`) before your harness boots. This
  is the **structural composition** layer.
- **Cross-pod sharing:** AgentSpecs can `imports: [shared]` to access a
  shared skill pool. Built-in agents commonly do this.
- **Belt-and-suspenders:** the spec projects skill files; startup guidance
  also tells you to load specific skills. Both paths matter — if the
  projection silently fails, the guidance still tells you what to read.

### Where skills live (sources of truth)

| Home | Purpose |
|---|---|
| `<software-team-cwd>/.claude/skills/`, `<software-team-cwd>/.agents/skills/` | Where the harness actually loads from. Populated by `SoftwareTeam up`. |
| `~/.claude/skills/`, `~/.agents/skills/` | User-level harness skill directories. Inspect the current projection and harness configuration to determine which skills are installed and where they came from. |
| `packages/daemon/{specs/agents/shared/skills,assets/plugins/*/skills}/` (source checkout) | Product skills that ship with SoftwareTeam — the spec pool + the bundled plugin assets (softwareteam-user, softwareteam-architect, forming-an-softwareteam-mental-model, queue-handoff, claude-compaction-restore, …). |
| the skills authoring workspace | Skill authoring source (not runtime-loaded). |

The product already discovers its installed shared skill pool and serves
packaged context through `SoftwareTeam context list/get`. Discovery and retrieval do
not prove that every skill was projected into every harness. Inspect the
selected profile and actual runtime directories; do not assume a universal
home/bootstrap installation from this table.

---

## The product loop (your day-to-day)

```
SoftwareTeam up <software-team-name>         # boot or restore the topology
SoftwareTeam ps --nodes            # see what's running
SoftwareTeam whoami --json         # know who you are
SoftwareTeam send <session> "msg"  # talk to a peer
SoftwareTeam capture <session>     # see a peer's terminal
SoftwareTeam transcript <session>  # read a peer's history
SoftwareTeam down <softwareTeamId>          # snapshot and stop every agent; check SoftwareTeam ps first, only when asked
SoftwareTeam up <software-team-name>         # restore from snapshot
```

The first command in any new seat is `SoftwareTeam whoami --json`. It tells you your
SoftwareTeam, pod, member, peers, edges, and transcript path. **Treat it as ground
truth — your CLAUDE.md or AGENTS.md startup overlay can be wrong; whoami
is authoritative.**

---

## Cultural posture (how to behave)

SoftwareTeam has a few load-bearing cultural principles. Internalize these:

- **Honesty over convenience.** If resume fails, say so loudly. Don't
  silently launch fresh.
- **The agent is the power user.** The CLI is designed for a 10x staff
  engineer at the terminal. You're that user.
- **CLI is context engineering.** Every error message and help text gives
  you information to act on. Read errors carefully.
- **Convention over invention.** Follow docker/git/kubectl patterns. Agent
  muscle memory is real.
- **Semi-deterministic is OK.** Core contracts are solid; edge cases are
  agent-handled.
- **Pets, not cattle (today).** SoftwareTeam is currently optimized for long-lived
  agents that develop instincts over sessions. Cattle support is on the
  roadmap.

---

## What you should do in your first 10 minutes

If you're booting into a new seat in an SoftwareTeam SoftwareTeam:

1. **`SoftwareTeam whoami --json`** — recover identity. Know your SoftwareTeam, pod, member,
   peers (`--all-peers` when `peersNote` says some are not shown).
2. **Read your role guidance** — typically delivered via startup files.
   `guidance/role.md` for your specific seat.
3. **Read the SoftwareTeam's `CULTURE.md`** if it has one — the team operating
   manual.
4. **Check what skills you have** — list `.claude/skills/` or
   `.agents/skills/` in your cwd. Each skill has a frontmatter description
   that tells you when to reach for it.
5. **Check your peers** — `SoftwareTeam capture <peer-session>` to see what they're
   doing.
6. **Check the transcripts** if you're returning to an in-flight workstream
   — `SoftwareTeam transcript <session> --tail 100` for recent context.
7. **Ask `SoftwareTeam ask <SoftwareTeam> "<question>"`** if you need cross-cutting evidence
   from the SoftwareTeam's transcripts and chat.

You're now oriented enough to start doing useful work.

**Permission policy (at setup):** SoftwareTeam sets only a minimal usability floor on your harness permissions, then offers recommended policies you opt into (Locked / Standard / Open — or YOLO to bypass). If you're creating or bringing up a SoftwareTeam, that's a choice you make, not something SoftwareTeam decides for you — see softwareteam-user's "Permission policy — pick one at setup" and the `applying-a-permission-policy` skill.

---

## Going deeper (canonical references)

For real depth, these are the load-bearing canonical docs:

| Reference | What it covers |
|---|---|
| `docs/as-built/README.md` (source checkout) | As-built map of territory — daemon architecture, system overview, package boundaries; routes to architecture and UI modules via `codemap.md` |
| `SoftwareTeam --help`, then `SoftwareTeam <command> --help` | The installed CLI surface, subcommands and flags |
| `SoftwareTeam context get reference/software-team-spec.md` | The SoftwareTeamSpec YAML format — pods, members, edges, all fields |
| `docs/reference/agent-spec.md` (source checkout) | The AgentSpec YAML format — resources, profiles, imports |
| `docs/reference/agent-startup-guide.md` (source checkout) | The 7-layer startup layering model; delivery hints |
| [Core vocabulary above](#the-core-vocabulary-read-these-terms-literally) | Vocabulary used in this skill (read literally) |
| `softwareteam-operating-model` skill | Placement and operating-model guidance — topology and work trees, context altitude |
| `softwareteam-architect` skill | SoftwareTeam and topology authoring |
| `https://agentskills.io/specification` | The cross-runtime skill standard |

If you're going to be authoring SoftwareTeams, use the `softwareteam-architect` skill before
touching YAML.

---

## What this skill is NOT for

- **Compaction recovery.** That's `claude-compaction-restore`. Different
  skill, different scenario.
- **Operating a specific SoftwareTeam.** Specific SoftwareTeams have their own DESIGN.md and
  CULTURE.md. Read those.
- **Authoring a new SoftwareTeam.** Use the `softwareteam-architect` skill for that.
- **Day-to-day SoftwareTeam operation.** Use `softwareteam-user` for that.

This skill exists to **form your initial mental model of SoftwareTeam as a
system**. Once oriented, reach for the role-specific or task-specific skills
that fit your actual work.

---

## Common misorientations to avoid

| Misorientation | Reality |
|---|---|
| "SoftwareTeam is a chat interface or assistant" | No. SoftwareTeam is a control plane that *manages* your harness sessions. The chat happens inside the harness; SoftwareTeam is around it. |
| "Pods are workflow groups" | No. Pods are **context domains** — agents that share working context. If two agents communicate every turn, they should be in one pod; if they communicate rarely, they shouldn't be. |
| "Edges represent reporting hierarchy" | No. Edges describe *coordination shape* — who delegates to whom, who observes whom. Avoid hierarchy interpretations; they distort behavior. |
| "I should manage Codex's compaction the way I manage Claude's" | No. Codex auto-compacts cleanly; Claude doesn't. Different runtimes, different lifecycles. |
| "MEMORY.md auto-loads, so I don't need to read it" | Maybe. Sometimes MEMORY.md auto-loads via system reminders; sometimes not. Don't assume. If your work touches the topics it covers, read it explicitly. |
| "Skills inherit from a parent or compose like classes" | No. Skills are flat artifacts; composition happens via AgentSpec `profile.uses.skills` (structural) or soft cross-references in skill bodies (advisory). Not via OO-style inheritance. |
| "The substrate `shared-docs/skills/` folder is the canonical runtime path" | No. The harness doesn't read there. It's an authoring workspace. Runtime loads from `.claude/skills/`, `.agents/skills/`, and product built-in. |

---

## Disaster-recovery test for this skill

If you read only this skill, can you:

1. State what kind of system SoftwareTeam is, in one sentence?
2. Name the four layers and where you live?
3. Run `SoftwareTeam whoami --json` and interpret the output?
4. Find your role guidance and your peers?
5. Identify what kind of SoftwareTeam you're in (kernel / project / ephemeral / etc.)?
6. Know where to look for a skill body (which folder)?
7. Know what to read next for depth (the canonical references)?

If yes — you're oriented. If no — tell your peer or the human; missing
context is fixable, but only if surfaced.
