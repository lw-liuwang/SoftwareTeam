// OPR.0.4.6.2 (FR-5) — TerminalLauncher. The view-library builder + layout math
// are unit-tested purely (the load-bearing logic); the interactive open-flow +
// pixel fidelity are covered by VM proof leg 9 (built-UI screenshots vs the 5
// locked frames + a real launch), so this file does not fight the Radix dialog
// in jsdom.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { NodeInventoryEntry } from "../src/hooks/useNodeInventory.js";

// ── Mocks for the closed-dialog render test (the pure-fn tests need none). ──
// Node data is inlined INSIDE the factory: vitest hoists vi.mock above the file
// body, so a factory must not reference an outer const.
vi.mock("../src/hooks/useHosts.js", () => ({ useSelectedHostId: () => "local" }));
vi.mock("../src/hooks/useNodeInventory.js", () => ({
  useNodeInventory: () => ({
    data: [
      { softwareTeamId: "00000000-0000-4000-8000-000000000042", softwareTeamName: "v-softwareteam-build", logicalId: "orch.lead", canonicalSessionName: "orch-lead@acme-build", nodeKind: "agent", podNamespace: "orch", agentActivity: { state: "running" } },
      { softwareTeamId: "00000000-0000-4000-8000-000000000042", softwareTeamName: "v-softwareteam-build", logicalId: "dev.d1", canonicalSessionName: "dev-d1@acme-build", nodeKind: "agent", podNamespace: "dev", agentActivity: { state: "idle" } },
      { softwareTeamId: "00000000-0000-4000-8000-000000000042", softwareTeamName: "v-softwareteam-build", logicalId: "infra.daemon", canonicalSessionName: "infra@acme-build", nodeKind: "infrastructure", podNamespace: null },
    ],
  }),
}));
vi.mock("../src/hooks/useSlices.js", () => ({
  useSlices: () => ({ data: { slices: [{ name: "02-ride", missionId: "release-0.4.6", displayName: "02 ride" }] } }),
}));
vi.mock("../src/hooks/useTerminalViews.js", () => ({
  useTerminalViews: () => ({ data: { saved: [{ id: "watchtower", name: "Watchtower", members: [{ seat: "lead@acme-ops", readOnly: true }] }], softwareTeams: ["acme-build"] } }),
}));
vi.mock("../src/hooks/useReviewAgents.js", () => ({ useReviewAgents: () => ({ data: undefined }) }));
vi.mock("../src/components/mission-control/missionControlAuth.js", () => ({ terminalAuthHeaders: () => ({}) }));

import {
  TerminalLauncher,
  buildLauncherViews,
  suggestLayout,
  describeOpenResult,
  type OpenViewResult,
} from "../src/components/topology/TerminalLauncher.js";

const node = (partial: Partial<NodeInventoryEntry>): NodeInventoryEntry =>
  ({
    softwareTeamId: "software-team-1",
    softwareTeamName: "acme",
    nodeKind: "agent",
    canonicalSessionName: null,
    logicalId: "x",
    podNamespace: null,
    ...partial,
  } as unknown as NodeInventoryEntry);

afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
});

describe("buildLauncherViews — the view library", () => {
  const slices = [{ name: "02-ride", missionId: "release-0.4.6", displayName: "02 ride" }];
  const saved = [{ id: "watchtower", name: "Watchtower", members: [{ seat: "a@r", readOnly: true }, { seat: "b@r", readOnly: true }] }];

  it("puts the SoftwareTeam first, interactive, with all agent seats (infra excluded)", () => {
    const views = buildLauncherViews({
      nodes: [node({ logicalId: "orch.lead", canonicalSessionName: "orch-lead@acme", podNamespace: "orch" }), node({ nodeKind: "infrastructure", canonicalSessionName: "infra@acme" })],
      softwareTeamId: "software-team-1",
      softwareTeamName: "acme",
      slices: [],
      savedViews: [],
    });
    expect(views[0]).toMatchObject({ id: "software-team:software-team-1", kind: "softwareTeam", label: "acme" });
    expect(views[0]!.crossSoftwareTeam).toBeUndefined(); // a softwareTeam view is interactive
    expect(views[0]!.seats).toHaveLength(1); // infra excluded
  });

  it.each([null, ""])(
    "resolves a missing caller name from the matching node and never labels the SoftwareTeam with its UUID (%j)",
    (softwareTeamName) => {
      const softwareTeamId = "00000000-0000-4000-8000-000000000042";
      const views = buildLauncherViews({
        nodes: [node({ softwareTeamId, softwareTeamName: "v-softwareteam-build" })],
        softwareTeamId,
        softwareTeamName,
        slices: [],
        savedViews: [],
      });

      expect(views[0]!.label).toBe("v-softwareteam-build");
      expect(views[0]!.label).not.toContain(softwareTeamId);
    },
  );

  it("keeps an explicit nonblank caller name ahead of the node fallback", () => {
    const softwareTeamId = "00000000-0000-4000-8000-000000000042";
    const views = buildLauncherViews({
      nodes: [node({ softwareTeamId, softwareTeamName: "node-name" })],
      softwareTeamId,
      softwareTeamName: "summary-name",
      slices: [],
      savedViews: [],
    });

    expect(views[0]!.label).toBe("summary-name");
  });

  it("uses the exact honest unavailable label for mismatched or blank node names", () => {
    const softwareTeamId = "00000000-0000-4000-8000-000000000042";
    const views = buildLauncherViews({
      nodes: [
        node({ softwareTeamId: "00000000-0000-4000-8000-000000000099", softwareTeamName: "another-software-team" }),
        node({ softwareTeamId, softwareTeamName: "   " }),
      ],
      softwareTeamId,
      softwareTeamName: " ",
      slices: [],
      savedViews: [],
    });

    expect(views[0]!.label).toBe("SoftwareTeam name unavailable");
  });

  it("groups agents into pod views by podNamespace and names absent seats", () => {
    const views = buildLauncherViews({
      nodes: [
        node({ logicalId: "dev.d1", canonicalSessionName: "dev-d1@acme", podNamespace: "dev" }),
        node({ logicalId: "dev.d2", canonicalSessionName: null, podNamespace: "dev" }),
        node({ logicalId: "orch.lead", canonicalSessionName: "orch-lead@acme", podNamespace: "orch" }),
      ],
      softwareTeamId: "software-team-1",
      slices: [],
      savedViews: [],
    });
    const dev = views.find((v) => v.id === "pod:software-team-1/dev");
    expect(dev).toBeTruthy();
    expect(dev!.seats).toHaveLength(2);
    expect(dev!.seats!.filter((s) => s.live)).toHaveLength(1); // d2 has no session → absent
    expect(dev!.seats!.find((s) => !s.live)!.reason).toBe("not launched");
    expect(views.some((v) => v.id === "pod:software-team-1/orch")).toBe(true);
  });

  it("adds derived mission + slice views (seats null, read-only by construction)", () => {
    const views = buildLauncherViews({ nodes: [], softwareTeamId: "software-team-1", slices, savedViews: [] });
    const mission = views.find((v) => v.id === "mission:release-0.4.6");
    const slice = views.find((v) => v.id === "slice:02-ride");
    expect(mission).toMatchObject({ kind: "mission", seats: null, crossSoftwareTeam: true });
    expect(slice).toMatchObject({ kind: "slice", seats: null, crossSoftwareTeam: true });
  });

  it("marks a fully read-only saved view as read-only (crossSoftwareTeam)", () => {
    const views = buildLauncherViews({ nodes: [], softwareTeamId: "software-team-1", slices: [], savedViews: saved });
    expect(views.find((v) => v.id === "watchtower")).toMatchObject({ kind: "saved", crossSoftwareTeam: true });
  });

  it("a saved view with an interactive member is NOT read-only", () => {
    const mixed = [{ id: "mix", name: "Mix", members: [{ seat: "a@r", readOnly: true }, { seat: "b@r" }] }];
    const views = buildLauncherViews({ nodes: [], softwareTeamId: "software-team-1", slices: [], savedViews: mixed });
    expect(views.find((v) => v.id === "mix")!.crossSoftwareTeam).toBe(false);
  });
});

describe("suggestLayout — grid math + paging cap", () => {
  it("caps shown panes at 9 and reports the overflow", () => {
    expect(suggestLayout(12)).toMatchObject({ shown: 9, cols: 3, rows: 3, paged: 3 });
  });
  it("no paging under the cap", () => {
    expect(suggestLayout(4)).toMatchObject({ shown: 4, cols: 2, rows: 2, paged: 0 });
  });
  it("one pane is a 1×1 grid", () => {
    expect(suggestLayout(1)).toMatchObject({ shown: 1, cols: 1, rows: 1, paged: 0 });
  });
});

describe("describeOpenResult — Guard G2: a 200 body is authoritative, not auto-green", () => {
  const base = (over: Partial<OpenViewResult>): OpenViewResult => ({
    provider: "herdr", ok: true, opened: [], absent: [], degraded: [], pages: 0, ...over,
  });

  it("200 provider-failure (ok:false, opened:[], code herdr_unavailable) → NOT success", () => {
    const d = describeOpenResult(base({ ok: false, opened: [], code: "herdr_unavailable", error: "no binary" }));
    expect(d.ok).toBe(false);
    expect(d.headline).toContain("No tiles opened");
    expect(d.headline).toContain("herdr_unavailable");
    expect(d.headline).toContain("no binary");
  });

  it("200 zero-pane with absent/degraded → failure, seats NAMED with reasons (not a count)", () => {
    const d = describeOpenResult(
      base({
        ok: false,
        opened: [],
        absent: [{ seat: "a@r", host: null, reason: "not alive" }],
        degraded: [{ seat: "b@r", host: "front-door", reason: "host front-door is http-registered; tiles need ssh" }],
      }),
    );
    expect(d.ok).toBe(false);
    expect(d.disclosure).toContain("a@r: not alive");
    expect(d.disclosure).toContain("b@r (front-door): host front-door is http-registered; tiles need ssh");
  });

  it("200 partial success (>=1 opened) → success PLUS named absent/degraded disclosure", () => {
    const d = describeOpenResult(
      base({ ok: true, opened: ["x@r"], absent: [{ seat: "y@r", host: null, reason: "not alive" }] }),
    );
    expect(d.ok).toBe(true);
    expect(d.headline).toBe("Opened 1 in herdr");
    expect(d.disclosure).toContain("y@r: not alive");
  });
});

describe("TerminalLauncher — mounts with its live hooks (collapsed)", () => {
  it("renders the collapsed trigger button", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    render(
      <QueryClientProvider client={qc}>
        <TerminalLauncher softwareTeamId="software-team-1" softwareTeamName="acme-build" />
      </QueryClientProvider>,
    );
    const btn = screen.getByTestId("terminal-launcher-button");
    expect(btn.textContent).toContain("Open in terminal");
  });

  it("uses one resolved canonical label in the deep-linked header and SoftwareTeam row without exposing the UUID", () => {
    const softwareTeamId = "00000000-0000-4000-8000-000000000042";
    window.history.replaceState(
      {},
      "",
      `/topology/softwareTeam/${softwareTeamId}?launcher=open&provider=cmux&view=${encodeURIComponent(`software-team:${softwareTeamId}`)}`,
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });

    render(
      <QueryClientProvider client={qc}>
        <TerminalLauncher softwareTeamId={softwareTeamId} softwareTeamName={null} />
      </QueryClientProvider>,
    );

    const dialog = screen.getByTestId("terminal-launcher-dialog");
    const softwareTeamRow = screen.getByTestId(`launcher-view-software-team:${softwareTeamId}`);
    expect(dialog.textContent).toContain("v-softwareteam-build · topology");
    expect(softwareTeamRow.textContent).toContain("v-softwareteam-build");
    expect(dialog.textContent).not.toContain(softwareTeamId);
  });

  it("keeps the deep-linked dialog inside a one-rem viewport inset with vertically reachable content", () => {
    window.history.replaceState({}, "", "/topology/softwareTeam/software-team-1?launcher=open");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });

    render(
      <QueryClientProvider client={qc}>
        <TerminalLauncher softwareTeamId="software-team-1" softwareTeamName="acme-build" />
      </QueryClientProvider>,
    );

    const classes = screen.getByTestId("terminal-launcher-dialog").className;
    expect(classes).toContain("w-[calc(100vw-2rem)]");
    expect(classes).toContain("max-h-[calc(100vh-2rem)]");
    expect(classes).toContain("overflow-y-auto");
    expect(classes).not.toContain("overflow-hidden");
  });
});
