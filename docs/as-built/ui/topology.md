---
kind: as-built
title: UI Topology — Graph/Table/Terminal, HotPotato, ActivityRing
status: active
topics: [observability, coordination]
domains: [engineering-advisor, operating-advisor]
applies-when: |
  Need to know how the topology surface is built — the host hybrid graph,
  the SoftwareTeam/pod graphs, the table/terminal views, the activity-ring /
  hot-potato visual language, terminal-preview popovers and launchers, and
  the topology navigation/overlay contracts.
siblings: [shell-and-routing.md, project-and-for-you.md]
prerequisite-reads: [../README.md, shell-and-routing.md]
last-verified-against-source: e8f0ab340db773392ec8be75b072d1c0f3068a50
last-updated: 2026-10-08
---

# UI Topology — Graph/Table/Terminal, HotPotato, ActivityRing

Topology is a scoped workspace with graph, table, and terminal views at the
`/topology` route family (`shell-and-routing.md` §3). It is the operator's
live picture of host → SoftwareTeam → pod → seat.

> Verified against source at `e8f0ab34` (package version 0.6.7). The web UI
> is in maintenance mode (`docs/reference/developing.md`). The source file
> that defines the hybrid nodes is `HybridTopologyNodes.tsx` (DESIGN.md's
> implementation reference).

## 1. Topology pieces

> `HybridAgentNode` and `HybridPodGroupNode` are exports inside
> `packages/ui/src/components/topology/HybridTopologyNodes.tsx`, not
> top-level files (`HybridPodGroupNode = memo(...)` at
> `HybridTopologyNodes.tsx:101`; `HybridAgentNode = memo(HybridAgentNodeInner,
> ...)` at `:321`).

Components in `packages/ui/src/components/topology/`:

- `HostMultiSoftwareTeamGraph.tsx` — host-level hybrid React Flow graph (multi-SoftwareTeam
  single canvas). Also mounted on the `/project` workspace Workflow tab.
- `HybridTopologyNodes.tsx` — exports `HybridAgentNode` (compact agent cards:
  runtime badges, context %, token totals, activity state, terminal preview,
  per-card CMUX open via `useCmuxLaunch`) and `HybridPodGroupNode` (soft
  dashed pod frames).
- `SoftwareTeamGroupNode.tsx` — soft SoftwareTeam frames with registration marks + aggregate
  activity.
- `ActivityRing.tsx` — active / needs-input / blocked activity ring; card
  activity classes in `activity-card-visuals.ts`.
- `HotPotatoEdge.tsx` — directional queue-movement edge animation.
- `TopologyTableView.tsx` — dense table mirror of topology data (with
  `topology-table-shimmer.css`).
- `TopologyTerminalView.tsx` — pinned-card terminal grid for host, SoftwareTeam or
  pod scope; host scope shows 12 cards by default (`SAFE_N`) with a "show
  all" toggle.
- `TopologyTreeView.tsx` — the topology tree, rendered in the Explorer
  sidebar (`components/Explorer.tsx`), not as a center view mode.
- `TopologyViewModeTabs.tsx` — host tabs Graph / Table / Terminal; SoftwareTeam and
  pod tabs add Overview. Tabs switch in place (React state), not separate
  routes. (`SEAT_SCOPE_TABS` is defined but unused; the seat scope renders
  `LiveNodeDetails`.)
- `TerminalPreviewPopover.tsx` — smoked-glass terminal preview, portaled
  above the graph. On the graph and table it is `progressive`: a static
  mirror first, click to go live, under a page-wide live-terminal cap.
- `TerminalLauncher.tsx` — the software-team-scope tab-bar launcher: choose a
  provider (herdr or cmux) and a view (this SoftwareTeam, a pod, a mission's or
  slice's agents, a saved view), then open it via
  `POST /api/terminal/open`. Shown only when the selected host is local.
- `LaunchCmuxButton.tsx` — the older software-team-scope "Launch in CMUX" button.
  `TerminalLauncher` replaced it in the tab bar, and no production
  component imports it now (tests still do).
- `ScopePages.tsx` — host/SoftwareTeam/pod/seat scope page wrappers.
- `topology-overlay-context.tsx` — `TopologyOverlayProvider`: expanded-SoftwareTeam
  state, the SoftwareTeam named in the URL auto-expanded, and the Explorer mode
  (`overlay` on the graph tab, `opaque` on the others).

The SoftwareTeam and pod graphs are not the hybrid graph: SoftwareTeam and pod scopes render
`components/SoftwareTeamGraph.tsx` (`SoftwareTeamNode` cards, `graph-layout.ts` layout),
sharing `HotPotatoEdge` and `useTopologyActivity`. SoftwareTeam scope's Overview tab
renders `SoftwareTeamOverviewTab` (`SoftwareTeamSpecDisplay`); pod scope's is a placeholder.
On narrow viewports the graph tab falls back to the table.

> Source: `topology/TopologyViewModeTabs.tsx` (`HOST_SCOPE_TABS`,
> `SOFTWARE_TEAM_POD_SCOPE_TABS`, `SEAT_SCOPE_TABS`); `topology/ScopePages.tsx`
> (`TerminalLauncher` `:270`, `SoftwareTeamGraph` `:322`/`:437`, `SoftwareTeamOverviewTab`
> `:342`, `useOverlayForActiveTab`); `topology/TerminalPreviewPopover.tsx`
> (`progressive`); `topology/TopologyTerminalView.tsx` (`SAFE_N` `:35`).

> Note (vs `DESIGN.md` "Topology"): DESIGN.md lists the exported brand
> primitives (`HostMultiSoftwareTeamGraph`, `HybridAgentNode`, `HybridPodGroupNode`,
> `SoftwareTeamGroupNode`, `ActivityRing`, `HotPotatoEdge`, `TerminalPreviewPopover`,
> `TopologyTableView`, `TopologyTerminalView`); all are present in source.
> `TopologyTreeView`, `TopologyViewModeTabs`, `TerminalLauncher` and
> `LaunchCmuxButton` exist in source but are not in DESIGN.md's primitive
> list (a scope difference, not drift).

## 2. Topology contracts

Re-confirmed against source:

- Graph / table / tree navigation all resolve to seat detail URLs
  (`/topology/seat/$softwareTeamId/$logicalId`).
- The host-level graph prefixes node IDs per SoftwareTeam for the multi-SoftwareTeam single
  canvas (`lib/hybrid-layout.ts`: `PREFIX_DELIMITER = "::"`,
  `prefixedHybridNodeId`).
- Expanded-SoftwareTeam state is owned by `TopologyOverlayProvider`. SoftwareTeams default to
  **expanded** (`DEFAULT_SOFTWARE_TEAM_EXPANDED = true` in `HostMultiSoftwareTeamGraph.tsx`),
  with "Expand all" / "Collapse all" controls; graph data is fetched for
  expanded SoftwareTeams only.
- Compact agent cards show context percentage, token totals, and activity
  card tint; `ActivityRing` + activity classes surface active / needs-input /
  blocked.
- `HotPotatoEdge` animates directional queue movement with non-scaling
  strokes; reduced-motion preference removes pulse/travel animation and
  keeps static state signals.
- Terminal-preview actions are hover/focus-visible; the
  `TerminalPreviewPopover` escapes React Flow stacking contexts (portaled
  to `document.body`) and stays within the viewport.
- With a non-local host selected, the host graph fetch carries the host
  parameter; terminal-preview and CMUX buttons are hidden on cards and in
  the table; and the SoftwareTeam page shows a read-only marker instead of the
  launcher.

## 3. Layout and activity helpers

In `src/lib/`: `hybrid-layout.ts` lays out the host graph
(`HostMultiSoftwareTeamGraph`); `graph-layout.ts` (`applyTreeLayout`) lays out the
SoftwareTeam/pod graph (`SoftwareTeamGraph`); `multi-software-team-layout.ts` has no production
importer (tests only). `topology-activity.ts` computes ring states and
hot-potato edges, and `activity-visuals.ts` the rollups and activity dots.
Runtime/tool identity on the cards comes from the central
`lib/runtime-brand.ts` / `lib/tool-brand.ts` and
`components/graphics/RuntimeMark.tsx` (runtimes: Claude Code, Codex, Pi,
OMP, terminal, unknown). Do not duplicate brand logic (DESIGN.md "Do
not").

## See also

- `shell-and-routing.md` — the `/topology` route family and shell.
- `project-and-for-you.md` — sibling observability surface.
- `../architecture/coordination-primitive.md` — the queue movement the
  hot-potato edge visualizes.
- Source root: `packages/ui/src/components/topology/`,
  `packages/ui/src/components/SoftwareTeamGraph.tsx`,
  `packages/ui/src/lib/{hybrid,graph}-layout.ts`.
