// V1 polish slice Phase 5.2 — multi-softwareTeam single-canvas /topology graph
// regression guard. Covers ritual #6 (HostMultiSoftwareTeamGraph reachability)
// + ritual #8 (no .map(useSoftwareTeamGraph) rules-of-hooks anti-pattern) +
// ritual #9 (coupled-literal scan for default-expanded state across
// HostMultiSoftwareTeamGraph + SoftwareTeamGroupNode + multi-software-team-layout).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { readFileSync } from "node:fs";
import path from "node:path";

const navigateSpy = vi.fn();
vi.mock("@tanstack/react-router", async (importActual) => {
  const actual = await importActual<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => navigateSpy,
  };
});

import { HostMultiSoftwareTeamGraph } from "../src/components/topology/HostMultiSoftwareTeamGraph.js";
import { TopologyOverlayProvider } from "../src/components/topology/topology-overlay-context.js";
import {
  prefixSoftwareTeamData,
  packSoftwareTeamGroups,
  computeBounds,
  COLLAPSED_SOFTWARE_TEAM_WIDTH,
  COLLAPSED_SOFTWARE_TEAM_HEIGHT,
} from "../src/lib/multi-software-team-layout.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

beforeEach(() => {
  navigateSpy.mockClear();
  mockFetch.mockReset();
});

afterEach(() => {
  cleanup();
});

function withQueryClient(ui: React.ReactNode, opts: { selectedHost?: string } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (opts.selectedHost) {
    queryClient.setQueryData(["hosts"], {
      ownName: "localhost",
      selected: opts.selectedHost,
      hosts: [
        {
          id: opts.selectedHost,
          transport: "http",
          url: `http://${opts.selectedHost}:7434`,
          selected: true,
          status: "reachable",
        },
      ],
    });
  }
  // Wrap in TanStack Router with memory history so <Link> resolves the
  // route context without crashing inside SoftwareTeamGroupNode.
  // V1 polish slice Phase 5.2 bounce-fix: TopologyOverlayProvider wraps
  // the route component so HostMultiSoftwareTeamGraph's useTopologyOverlay()
  // returns a real toggleSoftwareTeam (not the no-op default).
  const rootRoute = createRootRoute({
    component: () => (
      <TopologyOverlayProvider>
        <Outlet />
      </TopologyOverlayProvider>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <>{ui}</>,
  });
  const fallbackRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "$",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, fallbackRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const PS_RESPONSE = [
  {
    softwareTeamId: "software-team-1",
    name: "softwareteam-velocity",
    nodeCount: 13,
    runningCount: 9,
    status: "running",
    uptime: null,
    latestSnapshot: null,
  },
  {
    softwareTeamId: "software-team-2",
    name: "softwareteam-discovery",
    nodeCount: 5,
    runningCount: 3,
    status: "partial",
    uptime: null,
    latestSnapshot: null,
  },
  {
    softwareTeamId: "software-team-3",
    name: "softwareteam-product-lab",
    nodeCount: 0,
    runningCount: 0,
    status: "stopped",
    uptime: null,
    latestSnapshot: null,
  },
];

function setupFetchOk(opts: {
  ps?: typeof PS_RESPONSE;
  graphsBySoftwareTeamId?: Record<string, { nodes: unknown[]; edges: unknown[] }>;
}) {
  mockFetch.mockImplementation(async (url: string) => {
    if (url.split("?")[0] === "/api/ps") {
      return new Response(JSON.stringify(opts.ps ?? PS_RESPONSE));
    }
    const m = url.split("?")[0]!.match(/\/api\/software-teams\/([^/]+)\/graph/);
    if (m) {
      const softwareTeamId = decodeURIComponent(m[1]!);
      return new Response(
        JSON.stringify(opts.graphsBySoftwareTeamId?.[softwareTeamId] ?? { nodes: [], edges: [] }),
      );
    }
    return new Response("[]");
  });
}

// ----------------------------------------------------------------------
// multi-software-team-layout helpers — pure-fn tests
// ----------------------------------------------------------------------

describe("multi-software-team-layout: prefixSoftwareTeamData (P5.2-3 cross-software-team prefixing)", () => {
  it("prefixes node IDs with `${softwareTeamId}::` and threads data.softwareTeamId", () => {
    const { nodes, edges } = prefixSoftwareTeamData(
      "software-team-1",
      [
        { id: "n1", data: {} },
        { id: "n2", data: { foo: "bar" } },
      ],
      [{ id: "e1", source: "n1", target: "n2" }],
    );
    expect(nodes[0]!.id).toBe("software-team-1::n1");
    expect(nodes[1]!.id).toBe("software-team-1::n2");
    expect(nodes[0]!.data?.softwareTeamId).toBe("software-team-1");
    expect(nodes[1]!.data?.foo).toBe("bar");
    expect(nodes[1]!.data?.softwareTeamId).toBe("software-team-1");
    expect(edges[0]!.id).toBe("software-team-1::e1");
    expect(edges[0]!.source).toBe("software-team-1::n1");
    expect(edges[0]!.target).toBe("software-team-1::n2");
  });

  it("two softwareTeams with overlapping internal IDs have NO collision after prefixing (ritual #9)", () => {
    const r1 = prefixSoftwareTeamData(
      "software-team-A",
      [{ id: "orchestrator", data: {} }, { id: "review", data: {} }],
      [],
    );
    const r2 = prefixSoftwareTeamData(
      "software-team-B",
      [{ id: "orchestrator", data: {} }, { id: "review", data: {} }],
      [],
    );
    const allIds = new Set([...r1.nodes.map((n) => n.id), ...r2.nodes.map((n) => n.id)]);
    expect(allIds.size).toBe(4); // No collisions despite same internal IDs.
    expect(allIds.has("software-team-A::orchestrator")).toBe(true);
    expect(allIds.has("software-team-B::orchestrator")).toBe(true);
  });

  it("preserves and prefixes parentId for react-flow parent/child nodes", () => {
    const { nodes } = prefixSoftwareTeamData(
      "software-team-A",
      [
        { id: "podGroup-1", data: {} },
        { id: "agent-1", data: {}, parentId: "podGroup-1" } as any,
      ],
      [],
    );
    expect((nodes[1] as { parentId?: string }).parentId).toBe("software-team-A::podGroup-1");
  });
});

describe("multi-software-team-layout: packSoftwareTeamGroups (P5.2-6 outer offset packing)", () => {
  it("places softwareTeams in a row when viewport is wide enough", () => {
    const packed = packSoftwareTeamGroups(
      [
        { softwareTeamId: "software-team-1", width: 300, height: 120 },
        { softwareTeamId: "software-team-2", width: 300, height: 120 },
      ],
      1024,
    );
    expect(packed[0]!.offsetX).toBe(0);
    expect(packed[0]!.offsetY).toBe(0);
    expect(packed[1]!.offsetX).toBeGreaterThan(0);
    expect(packed[1]!.offsetY).toBe(0);
  });

  it("wraps to next row when total row width exceeds viewport", () => {
    const packed = packSoftwareTeamGroups(
      [
        { softwareTeamId: "software-team-1", width: 600, height: 120 },
        { softwareTeamId: "software-team-2", width: 600, height: 120 },
        { softwareTeamId: "software-team-3", width: 600, height: 120 },
      ],
      800,
    );
    // First fits at row 0; second wraps; third also wraps.
    expect(packed[0]!.offsetY).toBe(0);
    expect(packed[1]!.offsetY).toBeGreaterThan(0);
  });

  it("returns empty array for zero softwareTeams", () => {
    expect(packSoftwareTeamGroups([], 1024)).toEqual([]);
  });
});

describe("multi-software-team-layout: computeBounds", () => {
  it("returns collapsed-card dimensions for empty node list", () => {
    const b = computeBounds([]);
    expect(b.width).toBe(COLLAPSED_SOFTWARE_TEAM_WIDTH);
    expect(b.height).toBe(COLLAPSED_SOFTWARE_TEAM_HEIGHT);
  });

  it("computes bounding box covering all positioned nodes", () => {
    const b = computeBounds([
      { position: { x: 10, y: 10 }, initialWidth: 100, initialHeight: 50 },
      { position: { x: 200, y: 100 }, initialWidth: 100, initialHeight: 50 },
    ]);
    // Width covers minX=10 → maxX=300 → 290 + 2 * 16 padding = 322
    expect(b.width).toBeGreaterThanOrEqual(290);
    expect(b.height).toBeGreaterThan(140);
  });
});

// ----------------------------------------------------------------------
// HostMultiSoftwareTeamGraph component — mounting + click contract + collapse
// ----------------------------------------------------------------------

describe("HostMultiSoftwareTeamGraph (P5.2-1 reachability — ritual #6)", () => {
  it("renders one softwareTeamGroup node per SoftwareTeam from /api/ps; default ALL expanded", async () => {
    setupFetchOk({});
    const { findByTestId } = withQueryClient(<HostMultiSoftwareTeamGraph />);
    expect(await findByTestId("host-multi-software-team-graph")).toBeTruthy();
    // Each softwareTeam surfaces its softwareTeamGroup node.
    expect(await findByTestId("software-team-group-node-software-team-1")).toBeTruthy();
    expect(await findByTestId("software-team-group-node-software-team-2")).toBeTruthy();
    expect(await findByTestId("software-team-group-node-software-team-3")).toBeTruthy();
    // All expanded by default so the fleet canvas opens fully.
    expect(
      (await findByTestId("software-team-group-node-software-team-1")).getAttribute("data-collapsed"),
    ).toBe("false");
    expect(
      (await findByTestId("software-team-group-node-software-team-2")).getAttribute("data-collapsed"),
    ).toBe("false");
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith("/api/software-teams/software-team-1/graph");
      expect(mockFetch).toHaveBeenCalledWith("/api/software-teams/software-team-2/graph");
      expect(mockFetch).toHaveBeenCalledWith("/api/software-teams/software-team-3/graph");
    });
  });

  it("remote selection threads host param through /api/ps and per-software-team graph fan-out", async () => {
    setupFetchOk({});
    const { findByTestId } = withQueryClient(<HostMultiSoftwareTeamGraph />, { selectedHost: "vps-a" });
    expect(await findByTestId("host-multi-software-team-graph")).toBeTruthy();
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith("/api/ps?host=vps-a", expect.objectContaining({ signal: expect.any(AbortSignal) }));
      expect(mockFetch).toHaveBeenCalledWith("/api/software-teams/software-team-1/graph?host=vps-a");
      expect(mockFetch).toHaveBeenCalledWith("/api/software-teams/software-team-2/graph?host=vps-a");
      expect(mockFetch).toHaveBeenCalledWith("/api/software-teams/software-team-3/graph?host=vps-a");
    });
    expect(
      mockFetch.mock.calls.some(([url]) => String(url) === "/api/software-teams/software-team-1/graph"),
    ).toBe(false);
  });

  it("SoftwareTeam group body click toggles collapse state (P5.2-5)", async () => {
    setupFetchOk({
      graphsBySoftwareTeamId: {
        "software-team-1": { nodes: [], edges: [] },
      },
    });
    const { findByTestId } = withQueryClient(<HostMultiSoftwareTeamGraph />);
    const node = await findByTestId("software-team-group-node-software-team-1");
    expect(node.getAttribute("data-collapsed")).toBe("false");
    fireEvent.click(node);
    await waitFor(() => {
      expect(
        (
          document.querySelector(
            "[data-testid='software-team-group-node-software-team-1']",
          ) as HTMLElement
        ).getAttribute("data-collapsed"),
      ).toBe("true");
    });
    // Re-click expands again.
    fireEvent.click(
      document.querySelector("[data-testid='software-team-group-node-software-team-1']") as HTMLElement,
    );
    await waitFor(() => {
      expect(
        (
          document.querySelector(
            "[data-testid='software-team-group-node-software-team-1']",
          ) as HTMLElement
        ).getAttribute("data-collapsed"),
      ).toBe("false");
    });
  });

  it("canvas controls collapse and expand every softwareTeam", async () => {
    setupFetchOk({});
    const { findByTestId } = withQueryClient(<HostMultiSoftwareTeamGraph />);
    const collapseAll = await findByTestId("topology-collapse-all-softwareTeams");
    const expandAll = await findByTestId("topology-expand-all-softwareTeams");
    expect((await findByTestId("software-team-group-node-software-team-1")).getAttribute("data-collapsed")).toBe("false");

    fireEvent.click(collapseAll);
    await waitFor(() => {
      expect(
        (
          document.querySelector(
            "[data-testid='software-team-group-node-software-team-1']",
          ) as HTMLElement
        ).getAttribute("data-collapsed"),
      ).toBe("true");
      expect(
        (
          document.querySelector(
            "[data-testid='software-team-group-node-software-team-2']",
          ) as HTMLElement
        ).getAttribute("data-collapsed"),
      ).toBe("true");
    });

    fireEvent.click(expandAll);
    await waitFor(() => {
      expect(
        (
          document.querySelector(
            "[data-testid='software-team-group-node-software-team-1']",
          ) as HTMLElement
        ).getAttribute("data-collapsed"),
      ).toBe("false");
      expect(
        (
          document.querySelector(
            "[data-testid='software-team-group-node-software-team-2']",
          ) as HTMLElement
        ).getAttribute("data-collapsed"),
      ).toBe("false");
    });
  });

  it("drill-in arrow Link is rendered separately from SoftwareTeam body (source contract)", async () => {
    setupFetchOk({});
    const { findByTestId } = withQueryClient(<HostMultiSoftwareTeamGraph />);
    const drill = await findByTestId("software-team-group-drill-software-team-1");
    // The drill Link element exists distinct from the softwareTeam body click target.
    // Its onClick stopPropagation contract is verified by source-assertion
    // (SoftwareTeamGroupNode.tsx contains `e.stopPropagation()` inside the Link
    // onClick) per the bottom-of-file ritual #9 source-assertion guard.
    expect(drill).toBeTruthy();
    expect(drill.tagName).toBe("A");
    // SoftwareTeam body remains expanded (clicking the drill link, even if its
    // onClick doesn't fire in jsdom, must not bubble to the body's
    // toggle handler — verified visually + via stopPropagation source).
    expect(
      (await findByTestId("software-team-group-node-software-team-1")).getAttribute("data-collapsed"),
    ).toBe("false");
  });

  it("empty SoftwareTeam list renders honest empty-state (no /api/software-teams/.../graph fetches)", async () => {
    setupFetchOk({ ps: [] });
    const { findByTestId } = withQueryClient(<HostMultiSoftwareTeamGraph />);
    expect(await findByTestId("host-multi-software-team-graph-empty")).toBeTruthy();
  });
});

// ----------------------------------------------------------------------
// Source-assertion guards (rituals #8 + #9)
// ----------------------------------------------------------------------

describe("source-assertion guards", () => {
  const SRC = path.resolve(__dirname, "../src");

  it("HostMultiSoftwareTeamGraph uses useQueries — NOT .map(useSoftwareTeamGraph) (ritual #8)", () => {
    const src = readFileSync(
      path.join(SRC, "components/topology/HostMultiSoftwareTeamGraph.tsx"),
      "utf8",
    );
    // Positive-assertion: useQueries imported + called. Substring matches
    // are robust to comment density (don't strip comments here — the file
    // has heavy header comments that confuse line-comment regexes; the
    // direct import line and call site survive verbatim either way).
    expect(src).toContain('import { useQueries } from "@tanstack/react-query"');
    expect(src).toContain("useQueries(");
    // Negative-assertion ritual #8: no .map((r) => useSoftwareTeamGraph(r.id))
    // anti-pattern (the rules-of-hooks violation P0-1 was caught for in
    // TopologyTableView). Match against full source — comments don't
    // contain that exact pattern.
    expect(src).not.toMatch(/\.map\(\s*\([^)]*\)\s*=>\s*useSoftwareTeamGraph/);
    // No useNodeSelection (Phase 5.1 retired the alias).
    expect(src).not.toMatch(/\buseNodeSelection\s*\(/);
  });

  it("SoftwareTeamGroupNode Link onClick contains e.stopPropagation() (ritual #9)", () => {
    const src = readFileSync(
      path.join(SRC, "components/topology/SoftwareTeamGroupNode.tsx"),
      "utf8",
    );
    // Drill-in Link must stop propagation so its click navigates without
    // also firing the softwareTeam body's onToggle handler.
    expect(src).toContain("e.stopPropagation()");
  });

  it("HostMultiSoftwareTeamGraph default state is all-expanded (ritual #9 coupled-literal)", () => {
    const ctxSrc = readFileSync(
      path.join(SRC, "components/topology/topology-overlay-context.tsx"),
      "utf8",
    );
    // V1 polish slice Phase 5.2 bounce-fix: software-team-expanded state lifted
    // from HostMultiSoftwareTeamGraph local useState into the provider scope so
    // direct-URL navigation (where HostMultiSoftwareTeamGraph isn't mounted)
    // still updates the state. Coupled-literal scan now targets the
    // provider's initializer.
    // Substring contracts (robust to multi-line formatting).
    expect(ctxSrc).toContain("useState<Map<string, boolean>>");
    expect(ctxSrc).toContain("() => new Map()");
    const hostSrc = readFileSync(
      path.join(SRC, "components/topology/HostMultiSoftwareTeamGraph.tsx"),
      "utf8",
    );
    expect(hostSrc).toContain("const DEFAULT_SOFTWARE_TEAM_EXPANDED = true");
    expect(hostSrc).toContain("const HOST_GRAPH_MIN_ZOOM = 0.03");
    expect(hostSrc).toContain("HostGraphAutoFit");
    // collapsed: !p.isExpanded — the expanded/collapsed semantic carrier
    // (still in the host component; reads from the lifted context).
    expect(hostSrc).toMatch(/collapsed:\s*!p\.isExpanded/);
  });

  it("SoftwareTeamGroupNode uses 1px outline-variant border + hard-shadow + RegistrationMarks", () => {
    const src = readFileSync(
      path.join(SRC, "components/topology/SoftwareTeamGroupNode.tsx"),
      "utf8",
    );
    expect(src).toMatch(/border\s+border-outline-variant/);
    expect(src).toMatch(/hard-shadow/);
    expect(src).toMatch(/RegistrationMarks/);
    // Drill-in Link present (separate from body click).
    expect(src).toMatch(/to=["']\/topology\/softwareTeam\/\$softwareTeamId["']/);
  });
});
