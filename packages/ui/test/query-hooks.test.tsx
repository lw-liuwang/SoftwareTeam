import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { usePsEntries } from "../src/hooks/usePsEntries.js";
import { useSoftwareTeamSummary } from "../src/hooks/useSoftwareTeamSummary.js";
import { useArchivedSoftwareTeams } from "../src/hooks/useArchivedSoftwareTeams.js";
import { useSoftwareTeamGraph } from "../src/hooks/useSoftwareTeamGraph.js";
import { useSnapshots } from "../src/hooks/useSnapshots.js";
import { useCreateSnapshot, useRestoreSnapshot, useImportSoftwareTeam } from "../src/hooks/mutations.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

let qc: QueryClient;

beforeEach(() => {
  mockFetch.mockReset();
  qc = createTestQueryClient();
});

afterEach(() => { cleanup(); });

function Wrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

// Test harness for useSoftwareTeamSummary
function SummaryHarness() {
  const { data, isPending, error } = useSoftwareTeamSummary();
  if (isPending) return <div data-testid="state">pending</div>;
  if (error) return <div data-testid="state">error: {error.message}</div>;
  return <div data-testid="state">data: {data?.length}</div>;
}

// OPR.0.3.3.19 - harness for useArchivedSoftwareTeams (archived-only section feed).
function ArchivedHarness({ enabled }: { enabled?: boolean }) {
  const { data, isPending, error } = useArchivedSoftwareTeams({ enabled });
  if (error) return <div data-testid="state">error: {error.message}</div>;
  if (isPending) return <div data-testid="state">pending</div>;
  return <div data-testid="state">archived: {data?.length}</div>;
}

// Test harness for useSoftwareTeamGraph
function GraphHarness({ softwareTeamId }: { softwareTeamId: string }) {
  const { data, isPending, error } = useSoftwareTeamGraph(softwareTeamId);
  if (isPending) return <div data-testid="state">pending</div>;
  if (error) return <div data-testid="state">error: {error.message}</div>;
  return <div data-testid="state">nodes: {data?.nodes.length}</div>;
}

// Test harness for useSnapshots
function SnapshotsHarness({ softwareTeamId }: { softwareTeamId: string }) {
  const { data, isPending, error } = useSnapshots(softwareTeamId);
  if (isPending) return <div data-testid="state">pending</div>;
  if (error) return <div data-testid="state">error: {error.message}</div>;
  return <div data-testid="state">snaps: {data?.length}</div>;
}

// Mutation test harnesses
function CreateSnapshotHarness({ softwareTeamId }: { softwareTeamId: string }) {
  const mutation = useCreateSnapshot(softwareTeamId);
  return (
    <div>
      <button data-testid="create" onClick={() => mutation.mutate()}>Create</button>
      <span data-testid="status">{mutation.isPending ? "pending" : mutation.isSuccess ? "success" : "idle"}</span>
    </div>
  );
}

function RestoreHarness({ softwareTeamId }: { softwareTeamId: string }) {
  const mutation = useRestoreSnapshot(softwareTeamId);
  return (
    <div>
      <button data-testid="restore" onClick={() => mutation.mutate("snap-1")}>Restore</button>
      <span data-testid="status">{mutation.isPending ? "pending" : mutation.isSuccess ? "success" : "idle"}</span>
    </div>
  );
}

function ImportHarness() {
  const mutation = useImportSoftwareTeam();
  return (
    <div>
      <button data-testid="import" onClick={() => mutation.mutate("yaml content")}>Import</button>
      <span data-testid="status">{mutation.isPending ? "pending" : mutation.isSuccess ? "success" : "idle"}</span>
    </div>
  );
}

describe("TanStack Query hooks", () => {
  // Test 1: QueryClientProvider wraps app — component can useQuery
  it("component can use useQuery within QueryClientProvider", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => [] });
    render(<Wrapper><SummaryHarness /></Wrapper>);
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("data: 0"));
  });

  // Test 2: useSoftwareTeamSummary returns summary data
  it("useSoftwareTeamSummary returns summary data with loading/success", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [{ id: "r1", name: "alpha", nodeCount: 3, latestSnapshotAt: null, latestSnapshotId: null }],
    });
    render(<Wrapper><SummaryHarness /></Wrapper>);

    // Initially pending
    expect(screen.getByTestId("state").textContent).toBe("pending");

    // Then data
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("data: 1"));
  });

  // OPR.0.3.3.19: useArchivedSoftwareTeams hits the archived-only endpoint.
  it("useArchivedSoftwareTeams fetches /api/software-teams/summary?archived=only", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [{ id: "r-arc", name: "tidy-me", nodeCount: 2, latestSnapshotAt: null, latestSnapshotId: null }],
    });
    render(<Wrapper><ArchivedHarness /></Wrapper>);
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("archived: 1"));
    expect(mockFetch).toHaveBeenCalledWith("/api/software-teams/summary?archived=only");
  });

  // OPR.0.3.3.19: lazy fan-out - disabled query never fetches (collapsed
  // Archive section costs nothing).
  it("useArchivedSoftwareTeams does not fetch when disabled", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => [] });
    render(<Wrapper><ArchivedHarness enabled={false} /></Wrapper>);
    // Give react-query a tick; the query must stay idle (no fetch).
    await waitFor(() => expect(screen.getByTestId("state")).toBeTruthy());
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // Test 3: useSoftwareTeamGraph returns graph data
  it("useSoftwareTeamGraph returns graph data for specific softwareTeamId", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ nodes: [{ id: "n1" }, { id: "n2" }], edges: [] }),
    });
    render(<Wrapper><GraphHarness softwareTeamId="r1" /></Wrapper>);

    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("nodes: 2"));
    expect(mockFetch).toHaveBeenCalledWith("/api/software-teams/r1/graph");
  });

  // Test 4: useSnapshots returns snapshot list
  it("useSnapshots returns snapshot list for softwareTeamId", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [{ id: "s1" }, { id: "s2" }, { id: "s3" }],
    });
    render(<Wrapper><SnapshotsHarness softwareTeamId="r1" /></Wrapper>);

    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("snaps: 3"));
    expect(mockFetch).toHaveBeenCalledWith("/api/software-teams/r1/snapshots");
  });

  // Test 5: SSE event triggers graph invalidation — covered in software-team-events.test.tsx

  // Test 6: useCreateSnapshot mutation invalidates snapshot list
  it("useCreateSnapshot invalidates snapshot query on success", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ id: "snap-new" }) });
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    render(<Wrapper><CreateSnapshotHarness softwareTeamId="r1" /></Wrapper>);
    act(() => { screen.getByTestId("create").click(); });

    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("success"));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["softwareTeam", "r1", "snapshots"] });
  });

  // Test 7: useRestoreSnapshot mutation invalidates softwareTeam data
  it("useRestoreSnapshot invalidates SoftwareTeam query on success", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ nodes: [] }) });
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    render(<Wrapper><RestoreHarness softwareTeamId="r1" /></Wrapper>);
    act(() => { screen.getByTestId("restore").click(); });

    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("success"));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["softwareTeam", "r1"] });
  });

  // Test 8: Error state propagates from failed query
  it("error state propagates from failed query", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });
    render(<Wrapper><SummaryHarness /></Wrapper>);

    await waitFor(() => expect(screen.getByTestId("state").textContent).toContain("error"));
  });

  // Test 9: useCreateSnapshot invalidates BOTH snapshots AND summary
  it("useCreateSnapshot invalidates both snapshots and summary queries", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ id: "snap-new" }) });
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    render(<Wrapper><CreateSnapshotHarness softwareTeamId="r1" /></Wrapper>);
    act(() => { screen.getByTestId("create").click(); });

    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("success"));

    const calls = invalidateSpy.mock.calls.map((c) => JSON.stringify(c[0]));
    expect(calls).toContain(JSON.stringify({ queryKey: ["softwareTeam", "r1", "snapshots"] }));
    expect(calls).toContain(JSON.stringify({ queryKey: ["softwareTeams", "summary"] }));
  });

  // Test 10: useImportSoftwareTeam invalidates summary query after successful instantiate
  it("useImportSoftwareTeam invalidates summary query on success", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ softwareTeamId: "new-software-team", specName: "test", nodes: [] }),
    });
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    render(<Wrapper><ImportHarness /></Wrapper>);
    act(() => { screen.getByTestId("import").click(); });

    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("success"));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["softwareTeams", "summary"] });
  });

  // slice-04 qitem-20260721000001-ps-stall-driver — U2 (regression pin; genuine RED
  // at the test-only gate, green now): both the ps and default-summary queryFns
  // forward the TanStack AbortSignal to fetch, and cancelQueries aborts it. Pre-fix,
  // both queryFns called fetch(url) with no signal.
  function PsSummaryHarness() {
    usePsEntries();
    useSoftwareTeamSummary();
    return <div data-testid="ps-summary">mounted</div>;
  }

  it("U2 regression: usePsEntries + useSoftwareTeamSummary forward the AbortSignal to fetch and honor cancel", async () => {
    mockFetch.mockImplementation(() => new Promise(() => {})); // never resolves -> queries stay pending
    render(<Wrapper><PsSummaryHarness /></Wrapper>);

    await waitFor(() => {
      expect(mockFetch.mock.calls.some((c) => String(c[0]).includes("/api/ps"))).toBe(true);
      expect(mockFetch.mock.calls.some((c) => String(c[0]).includes("/api/software-teams/summary"))).toBe(true);
    });

    const psCall = mockFetch.mock.calls.find((c) => String(c[0]).includes("/api/ps"));
    const sumCall = mockFetch.mock.calls.find((c) => String(c[0]).includes("/api/software-teams/summary"));
    const psSignal = (psCall?.[1] as { signal?: AbortSignal } | undefined)?.signal;
    const sumSignal = (sumCall?.[1] as { signal?: AbortSignal } | undefined)?.signal;

    // Genuine RED at the test-only gate; regression now. Pre-fix, fetch was called with no options/signal.
    expect(psSignal).toBeInstanceOf(AbortSignal);
    expect(sumSignal).toBeInstanceOf(AbortSignal);

    await act(async () => { await qc.cancelQueries(); });
    expect(psSignal?.aborted).toBe(true);
    expect(sumSignal?.aborted).toBe(true);
  });
});
