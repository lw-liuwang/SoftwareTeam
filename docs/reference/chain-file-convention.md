# The Chain-File Convention (CE-v2)

**This document is the SSOT for chain files**: what they are named, what each
altitude carries, and how the leaf-to-root trace resolves. Both trees' walkers
consume the paths defined here. If a walker and this document disagree, one of
them has a defect — report it; do not fork the convention.

## The one rule

**One filename, identical at every altitude of a tree.** A reader orients by
walking from where they stand toward the root, reading the same-named file at
each level. No pointers to follow, no branching, no per-level names. Inventing
a level-specific name breaks every walker.

Chain files sit on **nodes** (an instance, a SoftwareTeam, a pod, a seat; a mission, a slice)
— never on shelves (`SoftwareTeams/`, `seats/`, `missions/` are containment, not
nodes, and carry no chain file).

## Two trees, two questions

| tree | path shape | carries | ships? |
|---|---|---|---|
| **Topology** | instance → SoftwareTeam → pod → seat | how work is done here | **yes** — generally applicable defaults ship in source |
| **Project** | project → mission → slice | what is being built | **no** — depends on what the user builds; see below |

### The topology tree

Rooted at the typed config key **`topology.root`** (resolution
`env SOFTWARETEAM_TOPOLOGY_ROOT > config file > derived default
$SOFTWARETEAM_HOME/topology`). Never hardcode the path — `SoftwareTeam config get
topology.root` is the answer on any machine. The instance altitude **is the
top of the root** (there is no instance directory to find; the root is the
instance):

```
<topology.root>/<NAME>.md                         # instance altitude
<topology.root>/SoftwareTeams/<SoftwareTeam>/<NAME>.md              # SoftwareTeam altitude
<topology.root>/SoftwareTeams/<SoftwareTeam>/pods/<pod>/<NAME>.md   # pod altitude
<topology.root>/SoftwareTeams/<SoftwareTeam>/seats/<seat>/<NAME>.md # seat altitude
```

The engine creates the instance root, SoftwareTeam directory, and each declared pod
directory when it materializes topology, even when no authored chain default
exists. Pod context remains optional: use that altitude only for knowledge
shared within one context domain. Cross-pod guidance still belongs at the SoftwareTeam
altitude.

Established chain names on the topology tree:

- `LEARNED.md` — what a POSITION has learned; never shared or shipped as-is.
  A seat's LEARNED is identified by its PATH: the same seat name in two SoftwareTeams
  is two different files.
- `CRAFT.md` — how work is done at that altitude (shipped at instance, SoftwareTeam and
  seat), with `ORCHESTRATION-CRAFT.md` at SoftwareTeam level for orchestration practice.
- `CULTURE.md` — team norms. Note that startup delivers the SoftwareTeam spec's own
  `culture_file` (a path beside `software-team.yaml`), not a `CULTURE.md` under
  `topology.root`.

### The project tree

Rooted at the workspace keys (`workspace.root`, `workspace.slices_root`).
Chain names there: `SPEC.md` (intent in frontmatter composes up the chain;
specification is a leaf property), `PROOF.md`, `PROGRESS.md`. The walkers also
read `NOTES.md` (or `MISSION_NOTES.md`), and fall back to `README.md` for a node
without a `SPEC.md`.

**Project-tree context cannot ship.** It describes what *you* are building —
mission intent, slice specifications, proof contracts. No vendor can author it
in advance, and shipping a default would install someone else's project as
your context. Real projects author their own; `SoftwareTeam scope mission create` and
`SoftwareTeam scope slice create` start the tree. (Topology-tree context is the opposite: how a team
of agents runs well is largely general, which is why included SoftwareTeams ship
defaults.)

## Legacy location and the advisory

Before this convention the topology tree lived at `~/.softwareteam/shared-docs/SoftwareTeams/`
(design decision 2026-08-14: an arbitrary folder on one machine, not a product
path). That location **stays readable** as a per-level fallback for
`SoftwareTeam context trace`, at the SoftwareTeam and seat levels, so existing SoftwareTeams migrate instead
of breaking. The refocus trace, `seat:` profile atoms and handover priming read
only `topology.root`, so until migration they report those files as missing. Every
read that resolves to the legacy location emits a
named advisory (`legacy-topology-read: …`) stating the legacy source, the
canonical destination under `topology.root`, and the config key. A silent
legacy read is a defect. The legacy literal lives in exactly one helper per
settings twin (`resolveLegacyTopologySoftwareTeamsRoot`); walkers import it and carry
no path literal.

## The trace

`SoftwareTeam context trace --software-team <SoftwareTeam> [--pod <pod>] [--seat <seat>] --name <NAME>.md`
performs the walk: it prints each selected altitude root-first (general →
specific), marks whether content came from `topology.root`, the legacy tree
(with the advisory on stderr), or is absent, and needs no running daemon —
orientation is exactly when the daemon may be down. Existing SoftwareTeam/seat traces
remain valid; selecting `--pod` adds that context domain between them. `--json`
returns the structured result.

Your reads ARE the walk: a trace assembled from memory is a recitation that
reproduces the drift it was meant to catch. Run it; do not recall it.

## Shipped defaults and the curation path

Included SoftwareTeams ship sensible-default chain files under a `topology/` folder,
installed under `topology.root` at software-team-up. Today only `factory` ships one,
with instance, SoftwareTeam and seat defaults; the installer also supports pod defaults.
A shipped default is a **starting point** the occupying team appends to — it
is never overwritten by a later software-team-up (existing files win).

Adding a discovered best practice to the shipped defaults is deliberately
lightweight:

1. **Discovery** — the practice appears where it was earned: a seat's
   `LEARNED.md`, a field note, a review observation.
2. **Curation** — someone judges it *generally applicable* (would it hold on a
   stranger's machine, in a different project?). If it is project-specific it
   stays at the altitude that earned it.
3. **Ship** — add it to the SoftwareTeam's default chain files in source
   (`packages/daemon/specs/SoftwareTeams/…/topology/`), with the motivating incident in
   one line. It reaches new installs at the next release; running SoftwareTeams pick it
   up only via explicit delivery (see the refocus channel) — **editing a file
   is not delivery to a running seat.**

## What this file does not cover

How chain files reach a RUNNING seat (the refocus channel) is specified in the
refocus documentation; quality bars for the work itself live in the SoftwareTeam's
operating-model skill and culture file.
