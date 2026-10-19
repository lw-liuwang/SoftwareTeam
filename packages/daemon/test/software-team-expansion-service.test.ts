import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { SoftwareTeamExpansionService } from "../src/domain/software-team-expansion-service.js";
import type { ExpansionRequest } from "../src/domain/types.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";

describe("SoftwareTeamExpansionService", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;
  let service: SoftwareTeamExpansionService;

  beforeEach(() => {
    db = createFullTestDb();
    setup = createTestApp(db);
    service = new SoftwareTeamExpansionService({
      db,
      softwareTeamRepo: setup.softwareTeamRepo,
      eventBus: setup.eventBus,
      nodeLauncher: setup.nodeLauncher,
      podInstantiator: setup.podInstantiator,
      sessionRegistry: setup.sessionRegistry,
    });
  });

  afterEach(() => { db.close(); });

  function seedSoftwareTeam(name = "test-software-team") {
    return setup.softwareTeamRepo.createSoftwareTeam(name);
  }

  function terminalPodFragment(id = "infra", memberId = "server"): ExpansionRequest["pod"] {
    return {
      id,
      label: "Infrastructure",
      members: [
        { id: memberId, runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" },
      ],
      edges: [],
    };
  }

  // T1: Expansion with valid pod creates pod + nodes
  it("creates pod and nodes for a valid expansion", async () => {
    const softwareTeam = seedSoftwareTeam();
    const result = await service.expand({ softwareTeamId: softwareTeam.id, pod: terminalPodFragment() });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe("ok");
    expect(result.podNamespace).toBe("infra");
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]!.logicalId).toBe("infra.server");
    expect(result.nodes[0]!.status).toBe("launched");

    // Verify in DB
    const updatedSoftwareTeam = setup.softwareTeamRepo.getSoftwareTeam(softwareTeam.id);
    expect(updatedSoftwareTeam!.nodes.some((n) => n.logicalId === "infra.server")).toBe(true);
  });

  it("accepts labels and summaries with YAML-significant characters", async () => {
    const softwareTeam = seedSoftwareTeam();
    const result = await service.expand({
      softwareTeamId: softwareTeam.id,
      pod: {
        id: "ops",
        label: 'Ops: "Research"',
        summary: "Owns: queues, alerts, and runbooks",
        members: [
          {
            id: "agent",
            runtime: "terminal",
            agentRef: "builtin:terminal",
            profile: "none",
            cwd: '/tmp/"quoted":path',
            label: 'Worker: "A"',
          },
        ],
        edges: [],
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe("ok");

    const podRow = db.prepare("SELECT namespace, label, summary FROM pods WHERE software_team_id = ? AND namespace = ?").get(
      softwareTeam.id,
      "ops",
    ) as { namespace: string; label: string; summary: string | null } | undefined;
    expect(podRow?.label).toBe('Ops: "Research"');
    expect(podRow?.summary).toBe("Owns: queues, alerts, and runbooks");

    const node = setup.softwareTeamRepo.getSoftwareTeam(softwareTeam.id)?.nodes.find((candidate) => candidate.logicalId === "ops.agent");
    expect(node?.label).toBe('Worker: "A"');
  });

  // T2: Nonexistent softwareTeam -> error
  it("returns error for nonexistent softwareTeam", async () => {
    const result = await service.expand({ softwareTeamId: "nonexistent", pod: terminalPodFragment() });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("software_team_not_found");
  });

  // T3: Duplicate pod namespace -> error, softwareTeam unchanged
  it("rejects duplicate pod namespace", async () => {
    const softwareTeam = seedSoftwareTeam();
    // First expansion succeeds
    await service.expand({ softwareTeamId: softwareTeam.id, pod: terminalPodFragment("infra") });
    // Second with same namespace should fail
    const result = await service.expand({ softwareTeamId: softwareTeam.id, pod: terminalPodFragment("infra", "server2") });
    expect(result.ok).toBe(false);
  });

  // T4: Duplicate logical ID -> error
  it("rejects duplicate logical ID", async () => {
    const softwareTeam = seedSoftwareTeam();
    // Add a node with logicalId "infra.server" directly
    await service.expand({ softwareTeamId: softwareTeam.id, pod: terminalPodFragment("infra", "server") });
    // Try another pod with a member that creates "infra2.server" — different namespace, should work
    const result = await service.expand({ softwareTeamId: softwareTeam.id, pod: terminalPodFragment("infra2", "server") });
    expect(result.ok).toBe(true);
  });

  // T5: Cross-pod edge to existing node
  it("creates cross-pod edges to existing nodes", async () => {
    const softwareTeam = seedSoftwareTeam();
    // Create first pod
    await service.expand({ softwareTeamId: softwareTeam.id, pod: terminalPodFragment("orch", "lead") });

    // Expand with cross-pod edge
    const result = await service.expand({
      softwareTeamId: softwareTeam.id,
      pod: terminalPodFragment("dev", "impl"),
      crossPodEdges: [{ kind: "delegates_to", from: "orch.lead", to: "dev.impl" }],
    });

    expect(result.ok).toBe(true);

    // Verify edge in DB
    const updatedSoftwareTeam = setup.softwareTeamRepo.getSoftwareTeam(softwareTeam.id);
    const edges = updatedSoftwareTeam!.edges;
    expect(edges.some((e) => e.kind === "delegates_to")).toBe(true);
  });

  // T6: Cross-pod edge to nonexistent node -> error
  it("rejects cross-pod edge to nonexistent node", async () => {
    const softwareTeam = seedSoftwareTeam();
    const result = await service.expand({
      softwareTeamId: softwareTeam.id,
      pod: terminalPodFragment("dev", "impl"),
      crossPodEdges: [{ kind: "delegates_to", from: "nonexistent.node", to: "dev.impl" }],
    });
    expect(result.ok).toBe(false);
  });

  // T7: Node launch failure (1 of 2 nodes) -> partial with retry targets
  it("returns partial result when some but not all nodes fail", async () => {
    const softwareTeam = seedSoftwareTeam();
    // Mock: first createSession fails, second succeeds
    const tmux = setup.tmuxAdapter as unknown as Record<string, ReturnType<typeof vi.fn>>;
    tmux.createSession.mockResolvedValueOnce({ ok: false, code: "unknown", message: "tmux not available" });

    const twoPod: ExpansionRequest["pod"] = {
      id: "infra",
      label: "Infrastructure",
      members: [
        { id: "server1", runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" },
        { id: "server2", runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" },
      ],
      edges: [],
    };
    const result = await service.expand({ softwareTeamId: softwareTeam.id, pod: twoPod });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe("partial");
    expect(result.nodes.some((n) => n.status === "launched")).toBe(true);
    expect(result.nodes.some((n) => n.status === "failed")).toBe(true);
    expect(result.retryTargets.length).toBeGreaterThan(0);
  });

  // T9: Terminal node launches successfully
  it("terminal node launches with correct session", async () => {
    const softwareTeam = seedSoftwareTeam();
    const result = await service.expand({ softwareTeamId: softwareTeam.id, pod: terminalPodFragment() });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nodes[0]!.status).toBe("launched");
    expect(result.nodes[0]!.sessionName).toBeTruthy();
  });

  // T10: softwareTeam.expanded event emitted
  it("emits softwareTeam.expanded event after expansion", async () => {
    const softwareTeam = seedSoftwareTeam();
    await service.expand({ softwareTeamId: softwareTeam.id, pod: terminalPodFragment() });

    const events = db.prepare("SELECT type, payload FROM events WHERE type = 'softwareTeam.expanded'").all() as Array<{ type: string; payload: string }>;
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.softwareTeamId).toBe(softwareTeam.id);
    expect(payload.podNamespace).toBe("infra");
    expect(payload.status).toBe("ok");
  });

  // T8b: All nodes fail -> status "failed"
  it("returns failed status when all node launches fail", async () => {
    const softwareTeam = seedSoftwareTeam();
    const tmux = setup.tmuxAdapter as unknown as Record<string, ReturnType<typeof vi.fn>>;
    tmux.createSession.mockResolvedValue({ ok: false, code: "unknown", message: "tmux unavailable" });

    const result = await service.expand({ softwareTeamId: softwareTeam.id, pod: terminalPodFragment() });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe("failed");
    expect(result.nodes.every((n) => n.status === "failed")).toBe(true);
    expect(result.retryTargets).toHaveLength(1);

    // Topology still exists despite all launches failing
    const updatedSoftwareTeam = setup.softwareTeamRepo.getSoftwareTeam(softwareTeam.id);
    expect(updatedSoftwareTeam!.nodes.some((n) => n.logicalId === "infra.server")).toBe(true);
  });

  it("returns partial when startup fails after sessions are launched", async () => {
    const failingTerminalAdapter: RuntimeAdapter = {
      runtime: "terminal",
      listInstalled: async () => [],
      project: async () => ({ projected: [], skipped: [], failed: [] }),
      deliverStartup: async () => ({ delivered: 0, failed: [] }),
      launchHarness: vi.fn()
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({ ok: false, error: "terminal harness failed" }),
      checkReady: async () => ({ ready: true }),
    };

    setup = createTestApp(db, { adapters: { terminal: failingTerminalAdapter } });
    service = new SoftwareTeamExpansionService({
      db,
      softwareTeamRepo: setup.softwareTeamRepo,
      eventBus: setup.eventBus,
      nodeLauncher: setup.nodeLauncher,
      podInstantiator: setup.podInstantiator,
      sessionRegistry: setup.sessionRegistry,
    });

    const softwareTeam = seedSoftwareTeam();
    const twoPod: ExpansionRequest["pod"] = {
      id: "infra",
      label: "Infrastructure",
      members: [
        { id: "server1", runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" },
        { id: "server2", runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" },
      ],
      edges: [],
    };

    const result = await service.expand({ softwareTeamId: softwareTeam.id, pod: twoPod });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe("partial");
    expect(result.nodes.map((n) => n.status)).toEqual(["launched", "failed"]);
    expect(result.retryTargets).toEqual(["infra.server2"]);

    const sessions = setup.sessionRegistry.getSessionsForSoftwareTeam(softwareTeam.id);
    const failedSession = sessions.find((session) => session.nodeId === result.nodes[1]!.nodeId);
    expect(failedSession?.startupStatus).toBe("failed");
  });

  it("returns failed when every materialized node fails startup after launch", async () => {
    const failingTerminalAdapter: RuntimeAdapter = {
      runtime: "terminal",
      listInstalled: async () => [],
      project: async () => ({ projected: [], skipped: [], failed: [] }),
      deliverStartup: async () => ({ delivered: 0, failed: [] }),
      launchHarness: async () => ({ ok: false, error: "terminal harness failed" }),
      checkReady: async () => ({ ready: true }),
    };

    setup = createTestApp(db, { adapters: { terminal: failingTerminalAdapter } });
    service = new SoftwareTeamExpansionService({
      db,
      softwareTeamRepo: setup.softwareTeamRepo,
      eventBus: setup.eventBus,
      nodeLauncher: setup.nodeLauncher,
      podInstantiator: setup.podInstantiator,
      sessionRegistry: setup.sessionRegistry,
    });

    const softwareTeam = seedSoftwareTeam();
    const result = await service.expand({ softwareTeamId: softwareTeam.id, pod: terminalPodFragment() });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe("failed");
    expect(result.nodes[0]!.status).toBe("failed");
    expect(result.nodes[0]!.error).toContain("Harness launch failed");
    expect(result.retryTargets).toEqual(["infra.server"]);

    const sessions = setup.sessionRegistry.getSessionsForSoftwareTeam(softwareTeam.id);
    expect(sessions[0]?.startupStatus).toBe("failed");
  });

  // T11: No softwareTeam.imported event emitted (suppressed)
  it("does not emit softwareTeam.imported event during expansion", async () => {
    const softwareTeam = seedSoftwareTeam();
    await service.expand({ softwareTeamId: softwareTeam.id, pod: terminalPodFragment() });

    const events = db.prepare("SELECT type FROM events WHERE type = 'softwareTeam.imported'").all() as Array<{ type: string }>;
    expect(events).toHaveLength(0);
  });

  // Agent Starter v1 vertical M1 R2 — expansion pass-through. An expansion
  // request must carry `starterRef` through the same route that already carries
  // `sessionSource`: ExpansionPodFragment.members has the `starterRef?` field and
  // the structured expansion spec emits snake-case `starter_ref` on the member.
  // Strategy (OPR.0.3.3.24): spy on podInstantiator.materializeStructured to
  // capture the structured spec OBJECT it receives, and assert the member carries
  // `starter_ref` and the starter name (the synthetic-YAML round-trip is gone).
  it("preserves starterRef across expansion into the structured materialize spec (R2)", async () => {
    const softwareTeam = seedSoftwareTeam();
    const materializeSpy = vi.spyOn(setup.podInstantiator, "materializeStructured");
    const podWithStarter: ExpansionRequest["pod"] = {
      id: "infra",
      label: "Infrastructure",
      members: [
        {
          id: "server",
          runtime: "claude-code",
          agentRef: "local:agents/server",
          profile: "default",
          cwd: "/tmp",
          starterRef: { name: "softwareteam-builder-base--claude-code" },
        },
      ],
      edges: [],
    };
    await service.expand({ softwareTeamId: softwareTeam.id, pod: podWithStarter });

    expect(materializeSpy).toHaveBeenCalled();
    // OPR.0.3.3.24: expand passes a structured spec OBJECT (no synthetic YAML).
    // starterRef flows through as snake-case starter_ref on the member.
    const specObject = materializeSpy.mock.calls[0]![0] as { pods: Array<{ members: Array<Record<string, unknown>> }> };
    const member = specObject.pods[0]!.members[0]!;
    expect(member["starter_ref"]).toBeDefined();
    expect((member["starter_ref"] as { name: string }).name).toBe("softwareteam-builder-base--claude-code");

    materializeSpy.mockRestore();
  });

  it("absent starterRef does not leak starter_ref into the structured spec (negative regression)", async () => {
    const softwareTeam = seedSoftwareTeam();
    const materializeSpy = vi.spyOn(setup.podInstantiator, "materializeStructured");
    await service.expand({ softwareTeamId: softwareTeam.id, pod: terminalPodFragment() });

    const specObject = materializeSpy.mock.calls[0]![0] as { pods: Array<{ members: Array<Record<string, unknown>> }> };
    expect(specObject.pods[0]!.members[0]!["starter_ref"]).toBeUndefined();
    materializeSpy.mockRestore();
  });

  // OPR.0.5.6.3 — session_source.ref.version rides the fragment→spec map.
  // SessionSourceAgentImageSpec.ref carries `version?: string` (optional
  // version selector, defaults to "1" at consumption), and the schema
  // validates + normalizes it. Dropping it here silently expands a
  // version-pinned member at the DEFAULT image version — the FAC1
  // never-silently-drop rule applied to the whole session_source block.
  it("preserves session_source ref.version across expansion into the structured materialize spec", async () => {
    const softwareTeam = seedSoftwareTeam();
    const materializeSpy = vi.spyOn(setup.podInstantiator, "materializeStructured");
    const podWithPinnedImage: ExpansionRequest["pod"] = {
      id: "infra",
      label: "Infrastructure",
      members: [
        {
          id: "server",
          runtime: "claude-code",
          agentRef: "local:agents/server",
          profile: "default",
          cwd: "/tmp",
          sessionSource: { mode: "agent_image", ref: { kind: "image_name", value: "builder-base", version: "3" } },
        },
      ],
      edges: [],
    };
    await service.expand({ softwareTeamId: softwareTeam.id, pod: podWithPinnedImage });

    expect(materializeSpy).toHaveBeenCalled();
    const specObject = materializeSpy.mock.calls[0]![0] as { pods: Array<{ members: Array<Record<string, unknown>> }> };
    const sessionSource = specObject.pods[0]!.members[0]!["session_source"] as { mode: string; ref: Record<string, unknown> };
    expect(sessionSource).toBeDefined();
    expect(sessionSource.ref["value"]).toBe("builder-base");
    // The pin itself: the version selector survives the mapping.
    expect(sessionSource.ref["version"]).toBe("3");
    materializeSpy.mockRestore();
  });

  // OPR.0.5.6.3 no-behavior-widening pin: an UNPINNED session_source maps to
  // exactly { mode, ref: { kind, value } } — no version key materializes from
  // nowhere, and the carried fields are unchanged.
  it("unpinned session_source maps to the exact prior shape (no version key, no widening)", async () => {
    const softwareTeam = seedSoftwareTeam();
    const materializeSpy = vi.spyOn(setup.podInstantiator, "materializeStructured");
    const podWithFork: ExpansionRequest["pod"] = {
      id: "infra",
      label: "Infrastructure",
      members: [
        {
          id: "server",
          runtime: "claude-code",
          agentRef: "local:agents/server",
          profile: "default",
          cwd: "/tmp",
          sessionSource: { mode: "fork", ref: { kind: "native_id", value: "sess-abc" } },
        },
      ],
      edges: [],
    };
    await service.expand({ softwareTeamId: softwareTeam.id, pod: podWithFork });

    const specObject = materializeSpy.mock.calls[0]![0] as { pods: Array<{ members: Array<Record<string, unknown>> }> };
    const sessionSource = specObject.pods[0]!.members[0]!["session_source"];
    expect(sessionSource).toEqual({ mode: "fork", ref: { kind: "native_id", value: "sess-abc" } });
    materializeSpy.mockRestore();
  });
});
