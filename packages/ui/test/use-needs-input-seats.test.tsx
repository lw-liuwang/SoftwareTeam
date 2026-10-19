import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useNeedsInputSeats } from "../src/hooks/useNeedsInputSeats.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

function wrapper(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

afterEach(() => {
  cleanup();
  mockFetch.mockReset();
});

describe("useNeedsInputSeats", () => {
  it("keeps later needs-input seats when one SoftwareTeam nodes request rejects", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url === "/api/ps") {
        return new Response(JSON.stringify([
          { softwareTeamId: "software-team-stale" },
          { softwareTeamId: "product-team" },
        ]));
      }
      if (url === "/api/software-teams/software-team-stale/nodes") {
        throw new Error("resource exhausted");
      }
      if (url === "/api/software-teams/product-team/nodes?full=true") {
        return new Response(JSON.stringify([
          {
            softwareTeamId: "product-team",
            softwareTeamName: "product-team",
            logicalId: "orch1.lead",
            canonicalSessionName: "orch1-lead@product-team",
            terminalActive: false,
            agentActivity: {
              state: "needs_input",
              reason: "selection_prompt",
              evidenceSource: "pane_heuristic",
              sampledAt: "2026-06-19T09:35:29.847Z",
              fallback: true,
            },
          },
        ]));
      }
      return new Response("[]");
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useNeedsInputSeats(), { wrapper: wrapper(client) });

    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(result.current.data![0]).toMatchObject({
      logicalId: "orch1.lead",
      sessionName: "orch1-lead@product-team",
      source: "pane_heuristic",
      softwareTeamId: "product-team",
    });
  });
});
