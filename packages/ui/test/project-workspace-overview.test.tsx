import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  RouterProvider,
  createRouter,
  createRootRoute,
  createRoute,
  Outlet,
} from "@tanstack/react-router";
import { MissionScopePage, WorkspaceScopePage } from "../src/components/project/ScopePages.js";
import { TopologyOverlayProvider } from "../src/components/topology/topology-overlay-context.js";
import type { SliceDetail } from "../src/hooks/useSlices.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(() => {
  cleanup();
});

function makeDetail(name: string, missionId: string | null, qitemIds: string[]): SliceDetail {
  return {
    name,
    missionId,
    slicePath: `/workspace/${name}`,
    displayName: name,
    railItem: missionId,
    status: "active",
    rawStatus: "active",
    qitemIds,
    commitRefs: ["abc1234"],
    lastActivityAt: "2026-05-07T22:06:36.083Z",
    workflowBinding: null,
    story: {
      events: qitemIds[0] ? [{
        ts: "2026-05-07T22:06:36.083Z",
        kind: "queue.created",
        actorSession: "driver@software-team",
        qitemId: qitemIds[0],
        phase: null,
        summary: `Created ${qitemIds[0]} for ${name}.`,
        detail: { sourceSession: "driver@software-team", destinationSession: "human@host" },
      }] : [],
      phaseDefinitions: null,
    },
    acceptance: { totalItems: 1, doneItems: 1, percentage: 100, items: [], closureCallout: null, currentStep: null },
    decisions: { rows: [] },
    docs: { tree: [{ name: "README.md", relPath: "README.md", type: "file", size: 100, mtime: null }] },
    tests: {
      proofPackets: [{
        dirName: `${name}-proof`,
        primaryMarkdown: { relPath: "proof.md", content: "PASS" },
        additionalMarkdown: [],
        screenshots: ["screenshots/proof.png"],
        videos: [],
        traces: [],
        passFailBadge: "pass",
      }],
      aggregate: { passCount: 1, failCount: 0 },
    },
    topology: { affectedSoftwareTeams: [{ softwareTeamId: "software-team-1", softwareTeamName: "software-team-1", sessionNames: ["driver@software-team-1"] }], totalSeats: 1, specGraph: null },
  };
}

// V0.3.1 slice 12.5 — workspace topology now renders via
// HostMultiSoftwareTeamGraph; tests may override /api/ps to exercise the N=1 vs
// N=2 software-team-clustering paths.
type PsEntry = {
  softwareTeamId: string;
  name: string;
  nodeCount: number;
  runningCount: number;
  status: "running" | "partial" | "stopped";
  uptime: null;
  latestSnapshot: null;
};

const SINGLE_SOFTWARE_TEAM_PS: PsEntry[] = [
  {
    softwareTeamId: "software-team-1",
    name: "software-team-1",
    nodeCount: 1,
    runningCount: 1,
    status: "running",
    uptime: null,
    latestSnapshot: null,
  },
];

function installFetchMock(opts: { psEntries?: PsEntry[] } = {}) {
  const psEntries = opts.psEntries ?? SINGLE_SOFTWARE_TEAM_PS;
  mockFetch.mockImplementation(async (url: string) => {
    // MH-2: the selection-known files gate needs the hosts payload (local).
    if (url.includes("/api/hosts")) {
      return new Response(JSON.stringify({ ownName: "localhost", selected: "local", hosts: [] }), { status: 200 });
    }
    if (url.includes("/api/config")) {
      return new Response(
        JSON.stringify({ settings: { "workspace.root": { value: "/Users/admin/.softwareteam/workspace" } } }),
        { status: 200 },
      );
    }
    // HostMultiSoftwareTeamGraph fetches /api/ps for softwareTeam inventory + per-softwareTeam
    // /api/software-teams/<id>/graph for expanded softwareTeam contents. Provide minimal
    // responses so the swap test renders without network errors.
    if (url === "/api/ps" || url.startsWith("/api/ps?")) {
      return new Response(JSON.stringify(psEntries), { status: 200 });
    }
    const softwareTeamGraphMatch = url.match(/\/api\/software-teams\/([^/]+)\/graph/);
    if (softwareTeamGraphMatch) {
      return new Response(JSON.stringify({ nodes: [], edges: [] }), { status: 200 });
    }
    if (url.includes("/api/slices/idea-ledger")) {
      return new Response(JSON.stringify(makeDetail("idea-ledger", "RELEASE-PROOF", ["qitem-A"])), { status: 200 });
    }
    if (url.includes("/api/slices/seed-slice-active")) {
      return new Response(JSON.stringify(makeDetail("seed-slice-active", null, [])), { status: 200 });
    }
    if (url.includes("/api/queue/qitem-A")) {
      return new Response(JSON.stringify({
        qitemId: "qitem-A",
        tsCreated: "2026-05-07T22:06:36.083Z",
        tsUpdated: "2026-05-07T22:06:36.083Z",
        sourceSession: "driver@software-team",
        destinationSession: "human@host",
        state: "done",
        priority: "urgent",
        tier: "fast",
        tags: ["RELEASE-PROOF"],
        body: "Full queue body for workspace rollup.",
      }), { status: 200 });
    }
    if (url.includes("/api/slices?")) {
      return new Response(
        JSON.stringify({
          slices: [
            {
              name: "idea-ledger",
              displayName: "Idea Ledger release proof slice",
              railItem: "RELEASE-PROOF",
              status: "done",
              rawStatus: "done",
              qitemCount: 78,
              hasProofPacket: false,
              lastActivityAt: "2026-05-07T22:06:36.083Z",
            },
            {
              name: "seed-slice-active",
              displayName: "seed-slice-active",
              railItem: null,
              status: "active",
              rawStatus: "active",
              qitemCount: 0,
              hasProofPacket: false,
              lastActivityAt: "2000-01-01T00:00:00.000Z",
            },
          ],
          totalCount: 2,
          filter: "all",
        }),
        { status: 200 },
      );
    }
    return new Response("[]");
  });
}

function renderWorkspaceScope(
  opts: { psEntries?: PsEntry[] } = {},
): ReturnType<typeof render> {
  installFetchMock(opts);

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // V0.3.1 slice 12.5 — TopologyOverlayProvider must be INSIDE the
  // router (HostMultiSoftwareTeamGraph's useRouterState dependency), so wrap
  // <Outlet /> in the root route component, not the RouterProvider.
  const rootRoute = createRootRoute({
    component: () => (
      <TopologyOverlayProvider>
        <Outlet />
      </TopologyOverlayProvider>
    ),
  });
  const projectRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/project",
    component: () => <WorkspaceScopePage />,
  });
  const fallbackRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "$",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([projectRoute, fallbackRoute]),
    history: createMemoryHistory({ initialEntries: ["/project"] }),
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function renderMissionScope(): ReturnType<typeof render> {
  installFetchMock();

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // V0.3.1 slice 12.5 — mission scope topology fallback still uses
  // ScopeTopologyRollup when no specGraph is declared, so the
  // TopologyOverlayProvider isn't strictly required here. Wrap anyway
  // for symmetry with the workspace helper above (and so future tests
  // that exercise HostMultiSoftwareTeamGraph-shaped fallbacks have a working
  // context).
  const rootRoute = createRootRoute({
    component: () => (
      <TopologyOverlayProvider>
        <Outlet />
      </TopologyOverlayProvider>
    ),
  });
  const missionRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/project/mission/$missionId",
    component: () => <MissionScopePage />,
  });
  const sliceRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/project/slice/$sliceId",
    component: () => null,
  });
  const fallbackRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "$",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([missionRoute, sliceRoute, fallbackRoute]),
    history: createMemoryHistory({ initialEntries: ["/project/mission/RELEASE-PROOF"] }),
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("WorkspaceScopePage overview", () => {
  // OPR.0.4.1.24 — the workspace parent altitude now lands on the cross-mission
  // portfolio (supersedes the prior WorkspaceOverviewPanel mission grid). The
  // thorough portfolio behavior is covered in workspace-portfolio.test.tsx; these
  // integration checks assert the landing mounts the portfolio over the real shell.
  it("OPR.0.4.1.24: the workspace overview lands on the cross-mission portfolio, missions derived from the slice index", async () => {
    const { findByTestId } = renderWorkspaceScope();

    expect(await findByTestId("workspace-portfolio")).toBeTruthy();
    // Missions are DERIVED by grouping slices: idea-ledger -> RELEASE-PROOF; the
    // railItem-less slice -> unsorted. Each is a collapsed row.
    expect(await findByTestId("portfolio-mission-RELEASE-PROOF")).toBeTruthy();
    expect(await findByTestId("portfolio-mission-unsorted")).toBeTruthy();
  });

  it("OPR.0.4.1.24: portfolio rows are collapsed by default with an Open-mission jump", async () => {
    const { findByTestId, queryByTestId } = renderWorkspaceScope();
    // each mission row carries an Open jump to its mission page.
    expect(await findByTestId("portfolio-open-RELEASE-PROOF")).toBeTruthy();
    // collapsed by default: no steering glance (and so no MISSION_BRIEF fetch) until expand.
    expect(queryByTestId("portfolio-glance-RELEASE-PROOF")).toBeNull();
    expect(queryByTestId("portfolio-glance-loading-RELEASE-PROOF")).toBeNull();
    expect(queryByTestId("portfolio-glance-empty-RELEASE-PROOF")).toBeNull();
  });

  it("workspace progress, queue, and topology tabs render aggregate scoped data", async () => {
    const { findByTestId } = renderWorkspaceScope();

    fireEvent.click(await findByTestId("project-tab-story"));
    expect(await findByTestId("scope-story-rollup")).toBeTruthy();
    // OPR.0.4.1.19 — the Story tab is now the queue-lineage git-graph: one row per
    // qitem (keyed by qitemId), summary degraded to the first body line.
    expect((await findByTestId("story-row-qitem-A")).textContent).toContain("Full queue body");

    fireEvent.click(await findByTestId("project-tab-progress"));
    expect(await findByTestId("scope-progress-rollup")).toBeTruthy();

    fireEvent.click(await findByTestId("project-tab-proof"));
    expect(await findByTestId("proof-tab")).toBeTruthy();

    fireEvent.click(await findByTestId("project-tab-queue"));
    expect(await findByTestId("scope-queue-rollup")).toBeTruthy();
    expect((await findByTestId("scope-queue-trigger-qitem-A")).textContent).toContain("Full queue body");

    // V0.3.1 slice 12.5 — workspace topology now renders via
    // HostMultiSoftwareTeamGraph (softwareTeams as distinct visual clusters) instead of
    // the flat session-name ScopeTopologyRollup. Mission-scope topology
    // fallback continues to use ScopeTopologyRollup when no specGraph
    // is declared.
    fireEvent.click(await findByTestId("project-tab-topology"));
    expect(await findByTestId("workspace-topology-hostmultirig")).toBeTruthy();
    expect(await findByTestId("host-multi-software-team-graph")).toBeTruthy();
  });

  // V0.3.1 slice 12.5 HG-3 — N=1 softwareTeam fixture renders cleanly as a
  // single softwareTeam cluster on the workspace topology surface (no flat
  // session-name aggregation).
  it("slice 12.5 HG-3: single-software-team workspace renders a single SoftwareTeam cluster on /topology", async () => {
    const { findByTestId, queryByTestId } = renderWorkspaceScope({
      psEntries: SINGLE_SOFTWARE_TEAM_PS,
    });
    fireEvent.click(await findByTestId("project-tab-topology"));
    expect(await findByTestId("workspace-topology-hostmultirig")).toBeTruthy();
    expect(await findByTestId("host-multi-software-team-graph")).toBeTruthy();
    expect(await findByTestId("software-team-group-node-software-team-1")).toBeTruthy();
    expect(queryByTestId("software-team-group-node-software-team-2")).toBeNull();
    // Back-compat: the legacy flat session-name rollup is NOT mounted
    // for the workspace topology surface anymore.
    expect(queryByTestId("scope-topology-rollup")).toBeNull();
  });

  // V0.3.1 slice 12.5 HG-2 — N=2+ softwareTeam fixture renders distinct visual
  // softwareTeam clusters. Compounds with slice 05 (kernel-software-team-as-default ships
  // multi-softwareTeam workspaces): without software-team-clustering, kernel agents make
  // the flat view noisier; with software-team-clustering, structure stays legible
  // as softwareTeams multiply.
  it("slice 12.5 HG-2: multi-software-team workspace renders distinct SoftwareTeam clusters on /topology", async () => {
    const { findByTestId } = renderWorkspaceScope({
      psEntries: [
        ...SINGLE_SOFTWARE_TEAM_PS,
        {
          softwareTeamId: "software-team-2",
          name: "softwareteam-kernel",
          nodeCount: 2,
          runningCount: 2,
          status: "running",
          uptime: null,
          latestSnapshot: null,
        },
      ],
    });
    fireEvent.click(await findByTestId("project-tab-topology"));
    expect(await findByTestId("workspace-topology-hostmultirig")).toBeTruthy();
    expect(await findByTestId("host-multi-software-team-graph")).toBeTruthy();
    expect(await findByTestId("software-team-group-node-software-team-1")).toBeTruthy();
    expect(await findByTestId("software-team-group-node-software-team-2")).toBeTruthy();
  });

  it("mission scope page filters workspace data to that mission", async () => {
    const { findByTestId, queryByText } = renderMissionScope();

    // OPR.0.4.1.17: the mission now LANDS on the Steering tab; navigate to
    // Overview to assert the mission-overview filtering behavior.
    fireEvent.click(await findByTestId("project-tab-overview"));
    expect(await findByTestId("mission-overview-panel")).toBeTruthy();
    expect((await findByTestId("mission-overview-panel")).textContent).toContain("Idea Ledger release proof slice");
    expect((await findByTestId("mission-overview-slice-idea-ledger-qitems")).textContent).toContain("78");
    expect((await findByTestId("mission-overview-slice-idea-ledger-status")).getAttribute("data-tone")).toBe("success");
    expect(queryByText("seed-slice-active")).toBeNull();

    fireEvent.click(await findByTestId("project-tab-queue"));
    expect((await findByTestId("scope-queue-trigger-qitem-A")).textContent).toContain("Full queue body");

    fireEvent.click(await findByTestId("project-tab-story"));
    expect(await findByTestId("scope-story-rollup")).toBeTruthy();
    expect(queryByText("seed-slice-active")).toBeNull();
  });
});
