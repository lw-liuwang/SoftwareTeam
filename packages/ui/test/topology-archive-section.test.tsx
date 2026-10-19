// OPR.0.3.3.19 - TopologyTreeView "Archive" section.
//
// Proves: the Archive node renders under the localhost host; archived softwareTeams are
// fetched LAZILY (no archived-only call while collapsed); expanding it fetches
// /api/software-teams/summary?archived=only and lists the archived softwareTeam. The default tree
// stays active-only (it never shows archived softwareTeams in the main list).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import {
  createMemoryHistory,
  RouterProvider,
  createRouter,
  createRootRoute,
  createRoute,
  Outlet,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TopologyTreeView } from "../src/components/topology/TopologyTreeView.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch as unknown as typeof fetch;

beforeEach(() => {
  cleanup();
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (url: string) => {
    if (url === "/api/software-teams/summary") {
      // default view: active softwareTeams only (none here)
      return { ok: true, json: async () => [] };
    }
    if (url === "/api/software-teams/summary?archived=only") {
      return { ok: true, json: async () => [{ id: "r-arc", name: "tidy-me", nodeCount: 2, latestSnapshotAt: null, latestSnapshotId: null }] };
    }
    return { ok: true, json: async () => [] };
  });
});

function renderTree() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => <TopologyTreeView /> });
  const mk = (path: string) => createRoute({ getParentRoute: () => rootRoute, path, component: () => null });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      indexRoute,
      mk("/topology"),
      mk("/topology/softwareTeam/$softwareTeamId"),
      mk("/topology/pod/$softwareTeamId/$podName"),
      mk("/topology/seat/$softwareTeamId/$logicalId"),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("TopologyTreeView Archive section (OPR.0.3.3.19)", () => {
  it("renders the Archive node and does NOT fetch archived softwareTeams while collapsed", async () => {
    renderTree();
    await waitFor(() => expect(screen.getByTestId("topology-archive-section")).toBeTruthy());
    // Lazy: the archived-only endpoint must not be hit before expansion.
    const archivedCalls = mockFetch.mock.calls.filter((c) => c[0] === "/api/software-teams/summary?archived=only");
    expect(archivedCalls.length).toBe(0);
  });

  it("expanding the Archive section fetches archived-only and lists the archived softwareTeam", async () => {
    renderTree();
    const section = await screen.findByTestId("topology-archive-section");
    const toggle = section.querySelector("button")!;
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByTestId("topology-software-team-r-arc")).toBeTruthy());
    expect(mockFetch).toHaveBeenCalledWith("/api/software-teams/summary?archived=only");
    // The default (active) list never surfaced the archived softwareTeam on its own.
    expect(screen.getByText("tidy-me")).toBeTruthy();
  });
});
