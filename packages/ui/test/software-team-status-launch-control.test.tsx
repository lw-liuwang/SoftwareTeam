import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SoftwareTeamStatusCard } from "../src/components/SoftwareTeamStatusCard.js";
import { SoftwareTeamStatusControl } from "../src/components/SoftwareTeamStatusControl.js";
import { LaunchRecoveryModal } from "../src/components/LaunchRecoveryModal.js";
import { KernelStatusCard } from "../src/components/KernelStatusCard.js";
import { useStartSoftwareTeam, useLaunchSoftwareTeam } from "../src/hooks/mutations.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch as unknown as typeof fetch;

function wrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function renderWithClient(node: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
}

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({ ok: status < 400, status, json: async () => body });
}

// A mixed restore-original plan: 2 resumable + 1 missing-token (awaiting-decision)
// + 1 stale-token resumable — so the LOCK + honesty + stale-vs-missing are all provable.
const MIXED_PLAN = {
  status: "plan",
  mode: "restore",
  softwareTeamId: "rig1",
  softwareTeamName: "softwareteam-delivery",
  snapshot: null,
  wouldCaptureCurrentState: true,
  mutated: false,
  nodes: [
    { logicalId: "orch.advisor", intendedAction: "resume-original", tokenState: "present", freshRequired: false },
    { logicalId: "dev2.driver", intendedAction: "resume-original", tokenState: "stale", freshRequired: false },
    { logicalId: "dev1.guard", intendedAction: "awaiting-decision", tokenState: "missing", freshRequired: true, reason: "no token recorded" },
  ],
};

const ALL_FRESH_PLAN = {
  ...MIXED_PLAN,
  nodes: MIXED_PLAN.nodes.map((n) => ({ ...n, intendedAction: "fresh-primed" })),
};

describe("SoftwareTeamStatusCard — consumes the backend verdict in the render (19/21 lesson)", () => {
  afterEach(cleanup);

  it("renders a non-green verdict for a blocked softwareTeam (does not default to green)", () => {
    renderWithClient(
      <SoftwareTeamStatusCard
        softwareTeamId="rig1"
        softwareTeamName="softwareteam-delivery"
        status="blocked"
        seatsRunning={0}
        seatsTotal={5}
        recoverable={false}
        src={["ps: 0/5 running · lifecycle=recoverable", "restore-check: blocked"]}
        primaryLabel="Resolve & restore ▸"
      />,
    );
    const card = screen.getByTestId("software-team-status-card-rig1");
    expect(card.getAttribute("data-status")).toBe("blocked");
    const badge = screen.getByTestId("software-team-status-badge-rig1");
    expect(badge.textContent).toContain("blocked");
    // The verdict tone is the tertiary (error) tone, NOT the success/green tone.
    expect(badge.className).toContain("text-tertiary");
    expect(badge.className).not.toContain("text-success");
    // The composed provenance is visible.
    expect(screen.getByTestId("software-team-status-src-rig1").textContent).toContain("restore-check: blocked");
  });

  it("an up SoftwareTeam disables the primary and shows RUNNING", () => {
    renderWithClient(
      <SoftwareTeamStatusCard
        softwareTeamId="rig1"
        softwareTeamName="r1"
        status="up"
        seatsRunning={3}
        seatsTotal={3}
        recoverable={false}
        src={["ps: 3/3 running · lifecycle=running"]}
        primaryLabel="Restore / launch ▸"
      />,
    );
    const primary = screen.getByTestId("software-team-primary-action-rig1") as HTMLButtonElement;
    expect(primary.disabled).toBe(true);
    expect(primary.textContent).toContain("RUNNING");
  });
});

// OPR.0.4.7.1 — the topology control is a COMPACT badge + button that opens
// the launch/recovery modal; the giant inline card (obscured by the explorer
// overlay at /topology/softwareTeam/*) is gone from this surface. SoftwareTeamStatusCard itself
// is unchanged (dashboard kernel card still uses it — covered above).
describe("SoftwareTeamStatusControl — compact modal-launch button (no inline card)", () => {
  beforeEach(() => mockFetch.mockReset());
  afterEach(cleanup);

  const SOFTWARE_TEAM_STATUS_UP = {
    softwareTeamId: "r9",
    softwareTeamName: "demo",
    isKernel: false,
    status: "up",
    seatsTotal: 7,
    seatsRunning: 7,
    recoverable: false,
    perSeat: [],
    src: ["ps: 7/7 running · lifecycle=running"],
  };

  function routeFetch(status: unknown) {
    mockFetch.mockImplementation((url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/launch-plan")) return jsonResponse(MIXED_PLAN);
      if (u.includes("/status")) return jsonResponse(status);
      if (u.endsWith("/up") && init?.method === "POST") return jsonResponse({ status: "restored" });
      return jsonResponse({});
    });
  }

  it("renders compact (no software-team-status-card) with the verdict badge + seats + primary button", async () => {
    routeFetch({ ...SOFTWARE_TEAM_STATUS_UP, status: "partial", seatsRunning: 5 });
    renderWithClient(<SoftwareTeamStatusControl softwareTeamId="r9" softwareTeamName="demo" />);

    await waitFor(() => expect(screen.getByTestId("software-team-primary-action-r9")).toBeTruthy());
    // The compact contract: the giant card is GONE from this surface.
    expect(screen.queryByTestId("software-team-status-card-r9")).toBeNull();
    const control = screen.getByTestId("software-team-status-control-r9");
    expect(control.getAttribute("data-status")).toBe("partial");
    expect(screen.getByTestId("software-team-status-badge-r9").textContent).toContain("partial");
    expect(screen.getByTestId("seats-r9").textContent).toBe("5/7");
  });

  it("clicking the primary action opens LaunchRecoveryModal (plan-before-mutation fetch fires)", async () => {
    routeFetch({ ...SOFTWARE_TEAM_STATUS_UP, status: "down", seatsRunning: 0, recoverable: true });
    renderWithClient(<SoftwareTeamStatusControl softwareTeamId="r9" softwareTeamName="demo" />);

    await waitFor(() => expect(screen.getByTestId("software-team-primary-action-r9")).toBeTruthy());
    fireEvent.click(screen.getByTestId("software-team-primary-action-r9"));

    await waitFor(() => expect(screen.getByTestId("launch-recovery-modal")).toBeTruthy());
    const planCalls = mockFetch.mock.calls.map(([u]) => String(u)).filter((u) => u.includes("/launch-plan"));
    expect(planCalls.length).toBeGreaterThan(0);
  });

  it("stays a live button when status is up (opens the read-only modal, never a disabled RUNNING)", async () => {
    routeFetch(SOFTWARE_TEAM_STATUS_UP);
    renderWithClient(<SoftwareTeamStatusControl softwareTeamId="r9" softwareTeamName="demo" />);

    await waitFor(() => expect(screen.getByTestId("software-team-primary-action-r9")).toBeTruthy());
    const primary = screen.getByTestId("software-team-primary-action-r9") as HTMLButtonElement;
    expect(primary.disabled).toBe(false);
    fireEvent.click(primary);
    await waitFor(() => expect(screen.getByTestId("launch-recovery-modal")).toBeTruthy());
  });
});

describe("LaunchRecoveryModal — plan-before-mutation + the LOCK + honesty", () => {
  beforeEach(() => mockFetch.mockReset());
  afterEach(cleanup);

  it("fetches the read-only plan on open; resumable seats stay resume-original while a missing-token seat is awaiting-decision + BLOCKS restore-original", async () => {
    mockFetch.mockImplementation((rawUrl?: unknown) => {
      const url = typeof rawUrl === "string" ? rawUrl : String((rawUrl as { url?: string })?.url ?? "");
      if (url.includes("/launch-plan")) return jsonResponse(MIXED_PLAN);
      return jsonResponse({});
    });

    renderWithClient(<LaunchRecoveryModal softwareTeamId="rig1" softwareTeamName="softwareteam-delivery" open onOpenChange={() => {}} />);

    await waitFor(() => expect(screen.getByTestId("launch-plan-table")).toBeTruthy());

    // Plan-before-action: the fetch hit the read-only launch-plan route.
    expect(mockFetch.mock.calls.some((c) => String(c[0]).includes("/launch-plan"))).toBe(true);

    // The LOCK: resumable seats stay resume-original (not repainted to fresh).
    expect(screen.getByTestId("plan-verdict-orch.advisor").textContent).toContain("resume-original");
    expect(screen.getByTestId("plan-verdict-dev2.driver").textContent).toContain("resume-original");
    // The missing-token seat is awaiting-decision (NOT fresh).
    expect(screen.getByTestId("plan-verdict-dev1.guard").textContent).toContain("awaiting-decision");
    expect(screen.getByTestId("plan-verdict-dev1.guard").textContent).not.toContain("fresh");

    // stale token is DISTINCT from missing (FR-6).
    expect(screen.getByTestId("plan-token-dev2.driver").textContent).toContain("stale");
    expect(screen.getByTestId("plan-token-dev1.guard").textContent).toContain("missing");

    // restore-original is BLOCKED (honesty contract) — the primary is disabled.
    expect(screen.getByTestId("launch-blocked-banner")).toBeTruthy();
    const execute = screen.getByTestId("launch-execute") as HTMLButtonElement;
    expect(execute.disabled).toBe(true);
    expect(execute.textContent).toContain("Resolve blockers to restore");

    // No restore mutation was issued while previewing (read-only).
    expect(mockFetch.mock.calls.some((c) => String(c[0]).endsWith("/up"))).toBe(false);
  });

  it("choosing fresh re-fetches the forecast, labels it identity-changing, enables execute, and posts freshLogicalIds to /up", async () => {
    mockFetch.mockImplementation((rawUrl?: unknown, init?: RequestInit) => {
      const url = typeof rawUrl === "string" ? rawUrl : String((rawUrl as { url?: string })?.url ?? "");
      if (url.includes("/launch-plan")) {
        const body = init?.body ? JSON.parse(init.body as string) : {};
        return jsonResponse(body.freshLogicalIds ? ALL_FRESH_PLAN : MIXED_PLAN);
      }
      if (url.endsWith("/up")) return jsonResponse({ status: "restored" });
      return jsonResponse({});
    });

    renderWithClient(<LaunchRecoveryModal softwareTeamId="rig1" softwareTeamName="softwareteam-delivery" open onOpenChange={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("launch-plan-table")).toBeTruthy());

    // Switch to the fresh policy (explicit, labeled identity-changing choice).
    fireEvent.click(screen.getByTestId("launch-policy-fresh"));

    await waitFor(() => {
      const execute = screen.getByTestId("launch-execute") as HTMLButtonElement;
      expect(execute.disabled).toBe(false);
      expect(execute.textContent).toContain("Fresh-prime all seats");
    });

    // Execute → posts to /up with per-seat freshLogicalIds (never a global flip).
    fireEvent.click(screen.getByTestId("launch-execute"));
    await waitFor(() => {
      const upCall = mockFetch.mock.calls.find((c) => String(c[0]).endsWith("/up"));
      expect(upCall).toBeTruthy();
      const body = JSON.parse((upCall![1] as RequestInit).body as string);
      expect(body.freshLogicalIds).toEqual(["orch.advisor", "dev2.driver", "dev1.guard"]);
    });
  });
});

describe("KernelStatusCard — kernel-status not /healthz; consumes the kernel verdict", () => {
  beforeEach(() => mockFetch.mockReset());
  afterEach(cleanup);

  it("reads /api/kernel/status, renders a down kernel non-green, and NEVER calls /healthz", async () => {
    mockFetch.mockImplementation((rawUrl?: unknown) => {
      const url = typeof rawUrl === "string" ? rawUrl : String((rawUrl as { url?: string })?.url ?? "");
      if (url.includes("/api/kernel/status")) {
        return jsonResponse({
          kernel_state: "auth_blocked",
          agents: [{ session_name: "advisor.lead@kernel", runtime: "claude-code", startup_status: "pending" }],
          first_unready_since: null,
          variant: "software-team.yaml",
          detail: "both runtimes unauthenticated",
        });
      }
      if (url.includes("/api/software-teams/summary")) {
        return jsonResponse([{ id: "software_team_kernel", name: "kernel", nodeCount: 1, latestSnapshotAt: null, latestSnapshotId: null }]);
      }
      return jsonResponse({});
    });

    renderWithClient(<KernelStatusCard />);

    await waitFor(() => {
      const card = screen.getByTestId("kernel-status-card");
      expect(card.getAttribute("data-status")).toBe("blocked");
    });
    // The verdict is rendered (non-green) and the source cites kernel_state (not /healthz).
    expect(screen.getByTestId("software-team-status-src-software_team_kernel").textContent).toContain("kernel-status.kernel_state=auth_blocked");
    // NEVER inferred from daemon /healthz.
    expect(mockFetch.mock.calls.some((c) => String(c[0]).includes("/healthz"))).toBe(false);
  });

  it("a 503 (tracker unavailable) renders unknown, never green", async () => {
    mockFetch.mockImplementation((rawUrl?: unknown) => {
      const url = typeof rawUrl === "string" ? rawUrl : String((rawUrl as { url?: string })?.url ?? "");
      if (url.includes("/api/kernel/status")) {
        return jsonResponse({ error: "kernel_boot_tracker_unavailable", message: "not wired" }, 503);
      }
      if (url.includes("/api/software-teams/summary")) return jsonResponse([]);
      return jsonResponse({});
    });

    renderWithClient(<KernelStatusCard />);
    await waitFor(() => {
      const card = screen.getByTestId("kernel-status-card");
      expect(card.getAttribute("data-status")).toBe("unknown");
    });
  });
});

describe("mutations — no useStartSoftwareTeam regression; useLaunchSoftwareTeam carries policy", () => {
  beforeEach(() => mockFetch.mockReset());

  it("useStartSoftwareTeam still POSTs a BODYLESS /up (default restore behavior unchanged)", async () => {
    mockFetch.mockImplementation(() => jsonResponse({ status: "restored" }));
    const { result } = renderHook(() => useStartSoftwareTeam("rig1"), { wrapper: wrapper() });
    await act(async () => {
      await result.current.mutateAsync();
    });
    const upCall = mockFetch.mock.calls.find((c) => String(c[0]).endsWith("/up"));
    expect(upCall).toBeTruthy();
    const init = (upCall![1] ?? {}) as RequestInit;
    expect(init.method).toBe("POST");
    // The regression guard: useStartSoftwareTeam sends NO body.
    expect(init.body).toBeUndefined();
  });

  it("useLaunchSoftwareTeam POSTs /up WITH freshLogicalIds (the policy-carrying path, distinct from useStartSoftwareTeam)", async () => {
    mockFetch.mockImplementation(() => jsonResponse({ status: "restored" }));
    const { result } = renderHook(() => useLaunchSoftwareTeam("rig1"), { wrapper: wrapper() });
    await act(async () => {
      await result.current.mutateAsync(["a", "b"]);
    });
    const upCall = mockFetch.mock.calls.find((c) => String(c[0]).endsWith("/up"));
    expect(upCall).toBeTruthy();
    const init = (upCall![1] ?? {}) as RequestInit;
    expect(JSON.parse(init.body as string).freshLogicalIds).toEqual(["a", "b"]);
  });
});
