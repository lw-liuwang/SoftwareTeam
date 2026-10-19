import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { useGlobalEvents } from "../src/hooks/useGlobalEvents.js";

// Mock EventSource
let mockEventSource: { addEventListener: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
let messageHandlers: Array<(event: { data: string }) => void> = [];

vi.stubGlobal("EventSource", class MockEventSource {
  constructor() {
    mockEventSource = {
      addEventListener: vi.fn((event: string, handler: any) => {
        if (event === "message") messageHandlers.push(handler);
      }),
      close: vi.fn(),
    };
    Object.assign(this, mockEventSource);
  }
  addEventListener = vi.fn();
  close = vi.fn();
});

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

describe("useGlobalEvents", () => {
  afterEach(() => {
    messageHandlers = [];
    cleanup();
  });

  it("subscribes to /api/events on mount", () => {
    renderHook(() => useGlobalEvents(), { wrapper: createWrapper() });
    // EventSource constructor was called
    expect(mockEventSource.addEventListener).toHaveBeenCalledWith("message", expect.any(Function));
  });

  it("invalidates SoftwareTeam node inventory on startup events", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);

    renderHook(() => useGlobalEvents(), { wrapper });

    // Simulate a startup event
    act(() => {
      for (const handler of messageHandlers) {
        handler({ data: JSON.stringify({ type: "node.startup_ready", softwareTeamId: "software-team-1", nodeId: "n1" }) });
      }
    });

    // Wait for debounce
    await new Promise((r) => setTimeout(r, 200));

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["softwareTeam", "software-team-1", "nodes"] });
  });

  it("invalidates softwareTeams summary and ps on SoftwareTeam lifecycle events", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);

    renderHook(() => useGlobalEvents(), { wrapper });

    act(() => {
      for (const handler of messageHandlers) {
        handler({ data: JSON.stringify({ type: "software-team.stopped", softwareTeamId: "software-team-1" }) });
      }
    });

    await new Promise((r) => setTimeout(r, 200));

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["softwareTeams", "summary"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["ps"] });
  });

  it("invalidates softwareTeams summary, ps, AND SoftwareTeam node inventory on restore.completed", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);

    renderHook(() => useGlobalEvents(), { wrapper });

    act(() => {
      for (const handler of messageHandlers) {
        handler({ data: JSON.stringify({ type: "restore.completed", softwareTeamId: "software-team-2" }) });
      }
    });

    await new Promise((r) => setTimeout(r, 200));

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["softwareTeams", "summary"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["ps"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["softwareTeam", "software-team-2", "nodes"] });
  });

  // OPR.0.3.3.19 (AC-7): archive/unarchive events must refetch BOTH the default
  // summary AND the archived-only summary (separate key) + ps, so a CLI /
  // other-browser archive updates a mounted UI reactively.
  it("invalidates softwareTeams summary, archived summary, ps, and SoftwareTeam nodes on software-team.archived", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);

    renderHook(() => useGlobalEvents(), { wrapper });

    act(() => {
      for (const handler of messageHandlers) {
        handler({ data: JSON.stringify({ type: "software-team.archived", softwareTeamId: "software-team-3" }) });
      }
    });

    await new Promise((r) => setTimeout(r, 200));

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["softwareTeams", "summary"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["softwareTeams", "summary", "archived"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["ps"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["softwareTeam", "software-team-3", "nodes"] });
  });

  it("invalidates softwareTeams summary, archived summary, and ps on softwareTeam.unarchived", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);

    renderHook(() => useGlobalEvents(), { wrapper });

    act(() => {
      for (const handler of messageHandlers) {
        handler({ data: JSON.stringify({ type: "softwareTeam.unarchived", softwareTeamId: "software-team-3" }) });
      }
    });

    await new Promise((r) => setTimeout(r, 200));

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["softwareTeams", "summary"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["softwareTeams", "summary", "archived"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["ps"] });
  });
});
