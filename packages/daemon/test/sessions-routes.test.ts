import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { CmuxAdapter } from "../src/adapters/cmux.js";
import type { CmuxTransportFactory } from "../src/adapters/cmux.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { createFullTestDb, createTestApp, mockTmuxAdapter } from "./helpers/test-app.js";

function unavailableCmux() {
  const factory: CmuxTransportFactory = async () => {
    throw Object.assign(new Error("no socket"), { code: "ENOENT" });
  };
  return new CmuxAdapter(factory, { timeoutMs: 50 });
}

function connectedCmux() {
  const factory: CmuxTransportFactory = async () => ({
    request: async (method: string) => {
      if (method === "capabilities") return { capabilities: ["surface.focus"] };
      return { ok: true };
    },
    close: () => {},
  });
  return new CmuxAdapter(factory, { timeoutMs: 1000 });
}

function failingCmux(failOn: string) {
  const calls: Array<{ method: string; params?: unknown }> = [];
  const factory: CmuxTransportFactory = async () => ({
    request: async (method: string, params?: unknown) => {
      calls.push({ method, params });
      if (method === "capabilities") return { capabilities: ["surface.focus", "surface.create", "workspace.current"] };
      if (method === failOn) throw new Error(`${failOn} failed: connection lost`);
      if (method === "workspace.current") return { workspace_id: "workspace:1" };
      if (method === "surface.create") return { created_surface_ref: "surface:99" };
      return {};
    },
    close: () => {},
  });
  const adapter = new CmuxAdapter(factory, { timeoutMs: 1000 });
  return { adapter, calls };
}

function trackingCmux() {
  const calls: Array<{ method: string; params?: unknown }> = [];
  const factory: CmuxTransportFactory = async () => ({
    request: async (method: string, params?: unknown) => {
      calls.push({ method, params });
      if (method === "capabilities") return { capabilities: ["surface.focus", "surface.create", "workspace.current"] };
      if (method === "workspace.current") return { workspace_id: "workspace:1" };
      if (method === "surface.create") return { created_surface_ref: "surface:99" };
      return {};
    },
    close: () => {},
  });
  const adapter = new CmuxAdapter(factory, { timeoutMs: 1000 });
  return { adapter, calls };
}

function staleBindingCmux() {
  const calls: Array<{ method: string; params?: unknown }> = [];
  const factory: CmuxTransportFactory = async () => ({
    request: async (method: string, params?: unknown) => {
      calls.push({ method, params });
      if (method === "capabilities") return { capabilities: ["surface.focus", "surface.create", "workspace.current"] };
      if (method === "surface.focus") {
        const surfaceId = String((params as Record<string, unknown> | undefined)?.["surfaceId"] ?? "");
        if (surfaceId === "OK surface:78 pane:2 workspace:1") {
          throw new Error("Invalid surface handle: OK surface:78 pane:2 workspace:1");
        }
        return {};
      }
      if (method === "workspace.current") return { workspace_id: "workspace:1" };
      if (method === "surface.create") return { created_surface_ref: "surface:99" };
      return {};
    },
    close: () => {},
  });
  const adapter = new CmuxAdapter(factory, { timeoutMs: 1000 });
  return { adapter, calls };
}

describe("Session routes", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createFullTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("GET /api/software-teams/:softwareTeamId/sessions -> session list", async () => {
    const { app, softwareTeamRepo, sessionRegistry } = createTestApp(db);
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("r01");
    const node = softwareTeamRepo.addNode(softwareTeam.id, "dev1-impl");
    sessionRegistry.registerSession(node.id, "r01-dev1-impl");

    const res = await app.request(`/api/software-teams/${softwareTeam.id}/sessions`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].sessionName).toBe("r01-dev1-impl");
  });


  it("POST clear-attention re-scopes a legacy attempt-zero reconciliation to the real restore attempt", async () => {
    const tmux = {
      ...mockTmuxAdapter(),
      hasSession: vi.fn(async () => true),
      listPanes: vi.fn(async () => [{ id: "%1", index: 0, cwd: "/", width: 80, height: 24, active: true }]),
      getPanePid: vi.fn(async () => 1234),
      getPaneCommand: vi.fn(async () => "claude"),
      capturePaneContent: vi.fn(async () => "Claude Code v2.1.89\n ❯ accept edits on"),
    } as unknown as TmuxAdapter;
    const { app, softwareTeamRepo, sessionRegistry, eventBus } = createTestApp(db, {
      tmux,
      listProcesses: async () => [
        { pid: 1234, ppid: 1, command: "zsh" },
        { pid: 1235, ppid: 1234, command: "claude.exe --resume tok-abc-123" },
      ],
    });
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("r90");
    const node = softwareTeamRepo.addNode(softwareTeam.id, "worker", { runtime: "claude-code" });
    const sessionName = "r90-worker";
    sessionRegistry.updateBinding(node.id, { tmuxSession: sessionName });
    const session = sessionRegistry.registerSession(node.id, sessionName);
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateStartupStatus(session.id, "ready");
    db.prepare("UPDATE sessions SET resume_type = 'claude_id', resume_token = ? WHERE id = ?")
      .run("tok-abc-123", session.id);
    const started = eventBus.emit({
      type: "restore.started",
      softwareTeamId: softwareTeam.id,
      snapshotId: "snap-1",
      intendedRoster: [{ nodeId: node.id, logicalId: "worker" }],
    });
    eventBus.emit({
      type: "restore.completed",
      softwareTeamId: softwareTeam.id,
      snapshotId: "snap-1",
      result: {
        snapshotId: "snap-1",
        preRestoreSnapshotId: null,
        softwareTeamResult: "partially_restored",
        nodes: [{ nodeId: node.id, logicalId: "worker", status: "attention_required" }],
        warnings: [],
      },
    });
    eventBus.emit({
      type: "restore.outcome_reconciled",
      softwareTeamId: softwareTeam.id,
      nodeId: node.id,
      attemptId: 0,
      from: "attention_required",
      to: "operator_recovered",
      evidence: { source: "clear_attention_evidence", kind: "fresh_activity", runtimeCwdVerified: false },
    });

    const cleared = await app.request(`/api/sessions/${encodeURIComponent(sessionName)}/clear-attention`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({
      ok: true,
      clearedBy: "evidence",
      clearedClasses: ["restore_outcome"],
      derivedEvidence: {
        source: "restore_runtime_truth",
        attemptId: started.seq,
        resumeTokenUsed: true,
      },
    });

    const status = await app.request(`/api/software-teams/${softwareTeam.id}/restore/status/${started.seq}`);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      ok: true,
      attemptId: started.seq,
      currentIntendedSetVerdict: "fully_restored",
      reconciliations: [{ nodeId: node.id, to: "operator_recovered" }],
    });
    const reconciliations = db.prepare(
      "SELECT json_extract(payload, '$.attemptId') AS attemptId FROM events WHERE type = 'restore.outcome_reconciled' ORDER BY seq",
    ).all() as Array<{ attemptId: number }>;
    expect(reconciliations.map((row) => row.attemptId)).toEqual([0, started.seq]);
  });

  it("POST .../launch -> 201 + sessionName + session + binding, binding.tmuxSession === sessionName", async () => {
    const { app, softwareTeamRepo } = createTestApp(db);
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("r01");
    softwareTeamRepo.addNode(softwareTeam.id, "dev1-impl", { role: "worker" });

    const res = await app.request(`/api/software-teams/${softwareTeam.id}/nodes/dev1-impl/launch`, {
      method: "POST",
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.sessionName).toBe("r01-dev1-impl");
    expect(body.session).toBeDefined();
    expect(body.session.sessionName).toBe("r01-dev1-impl");
    expect(body.binding).toBeDefined();
    expect(body.binding.tmuxSession).toBe("r01-dev1-impl");
    expect(body.binding.tmuxSession).toBe(body.sessionName);
  });

  it("POST .../launch already-bound -> 409", async () => {
    const { app, softwareTeamRepo, sessionRegistry } = createTestApp(db);
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("r01");
    const node = softwareTeamRepo.addNode(softwareTeam.id, "dev1-impl");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "r01-dev1-impl" });

    const res = await app.request(`/api/software-teams/${softwareTeam.id}/nodes/dev1-impl/launch`, {
      method: "POST",
    });
    expect(res.status).toBe(409);
  });

  it("POST .../launch nonexistent node -> 404", async () => {
    const { app, softwareTeamRepo } = createTestApp(db);
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("r01");

    const res = await app.request(`/api/software-teams/${softwareTeam.id}/nodes/nonexistent/launch`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });

  it("POST .../launch with ordinary SoftwareTeam name normalizes to r00-managed session name", async () => {
    const { app, softwareTeamRepo } = createTestApp(db);
    // Ordinary softwareTeam names are normalized into the managed r00- namespace.
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("badname");
    softwareTeamRepo.addNode(softwareTeam.id, "worker");

    const res = await app.request(`/api/software-teams/${softwareTeam.id}/nodes/worker/launch`, {
      method: "POST",
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.sessionName).toBe("r00-badname-worker");
    expect(body.session.sessionName).toBe("r00-badname-worker");
    expect(body.binding.tmuxSession).toBe("r00-badname-worker");
  });

  it("POST .../launch routes pod-aware nodes through launchNodeSubset (OPR.0.3.4.11)", async () => {
    const { app, softwareTeamRepo, sessionRegistry } = createTestApp(db);
    const podRepo = new PodRepository(db);
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("pod-software-team");
    const pod = podRepo.createPod(softwareTeam.id, "dev", "Development");
    const node = softwareTeamRepo.addNode(softwareTeam.id, "dev.impl", {
      runtime: "claude-code",
      podId: pod.id,
      agentRef: "local:agents/impl",
      profile: "default",
    });

    const res = await app.request(`/api/software-teams/${softwareTeam.id}/nodes/${encodeURIComponent("dev.impl")}/launch`, {
      method: "POST",
    });

    const body = await res.json();
    // Without a usable snapshot, launchNodeSubset returns no_usable_snapshot
    expect(body.ok).toBe(false);
    expect(body.code).toBe("no_usable_snapshot");
  });

  // OPR.0.4.3.28 correction — INVERT fail-closed-on-unknown. A failed tmux liveness probe is
  // NOT positive evidence of a live seat, so the launch route no longer hard-503s; it PROCEEDS
  // to launch and surfaces a non-blocking liveness_probe_unknown warning (verify-no-squat).
  it("POST .../launch does NOT 503 on tmux-probe-fail — launches with a liveness warning (OPR.0.4.3.28 inversion)", async () => {
    const tmuxMock = {
      createSession: vi.fn(async () => true),
      hasSession: vi.fn(async () => { throw new Error("tmux unavailable"); }),
      sendKeys: vi.fn(async () => {}),
      capturePaneContent: vi.fn(async () => ""),
      getPaneCommand: vi.fn(async () => null),
      getSessionStatus: vi.fn(async () => null),
      waitForReady: vi.fn(async () => true),
      listSessions: vi.fn(async () => []),
      startPipePane: vi.fn(async () => true),
      killSession: vi.fn(async () => {}),
    };
    const { app, softwareTeamRepo, sessionRegistry } = createTestApp(db, { tmux: tmuxMock as any });
    const podRepo = new PodRepository(db);
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("probe-fail-software-team");
    const pod = podRepo.createPod(softwareTeam.id, "dev", "Development");
    const node = softwareTeamRepo.addNode(softwareTeam.id, "dev.impl", {
      runtime: "claude-code",
      podId: pod.id,
      agentRef: "local:agents/impl",
      profile: "default",
    });
    // Seed a running session + usable snapshot so launchNodeSubset reaches the probe
    const session = sessionRegistry.registerSession(node.id, "dev-impl@probe-fail-software-team");
    sessionRegistry.updateStatus(session.id, "running");
    const { SnapshotRepository } = await import("../src/domain/snapshot-repository.js");
    const snapRepo = new SnapshotRepository(db);
    snapRepo.createSnapshot(softwareTeam.id, "manual", {
      softwareTeam: { id: softwareTeam.id, name: "probe-fail-software-team" },
      nodes: [{ id: node.id, logicalId: "dev.impl", softwareTeamId: softwareTeam.id, runtime: "claude-code", podId: pod.id }],
      sessions: [{ id: session.id, nodeId: node.id, sessionName: "dev-impl@probe-fail-software-team", status: "running", resumeType: "claude-native", resumeToken: "tok" }],
      edges: [],
      checkpoints: {},
    } as any);

    const res = await app.request(`/api/software-teams/${softwareTeam.id}/nodes/${encodeURIComponent("dev.impl")}/launch`, {
      method: "POST",
    });

    // No longer a hard 503 / target_liveness_unknown deny-by-default.
    expect(res.status).not.toBe(503);
    const body = await res.json();
    expect(body.code).not.toBe("target_liveness_unknown");
    // The liveness uncertainty is surfaced as a non-blocking warning, never a block.
    expect((body.warnings ?? []).some((w: string) => w.includes("liveness_probe_unknown"))).toBe(true);
  });

  it("POST .../nodes/launch-subset returns no_usable_snapshot without snapshot", async () => {
    const { app, softwareTeamRepo } = createTestApp(db);
    const podRepo = new PodRepository(db);
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("subset-software-team");
    const pod = podRepo.createPod(softwareTeam.id, "dev", "Development");
    softwareTeamRepo.addNode(softwareTeam.id, "dev.driver", { runtime: "claude-code", podId: pod.id });
    softwareTeamRepo.addNode(softwareTeam.id, "dev.guard", { runtime: "codex", podId: pod.id });

    const res = await app.request(`/api/software-teams/${softwareTeam.id}/nodes/launch-subset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seats: ["dev.driver", "dev.guard"] }),
    });

    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("no_usable_snapshot");
  });

  it("POST .../nodes/launch-subset launches multiple targets with usable snapshot (OPR.0.3.4.11)", async () => {
    // A successful fresh launch starts each harness: the route needs runtime adapters (as startup
    // wires them) and the snapshot needs each node's startup context (#107).
    const { app, softwareTeamRepo } = createTestApp(db, { wireRuntimeAdapters: true });
    const podRepo = new PodRepository(db);
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("multi-software-team");
    const pod = podRepo.createPod(softwareTeam.id, "dev", "Development");
    const n1 = softwareTeamRepo.addNode(softwareTeam.id, "dev.driver", { runtime: "claude-code", podId: pod.id });
    const n2 = softwareTeamRepo.addNode(softwareTeam.id, "dev.guard", { runtime: "codex", podId: pod.id });
    // Seed a usable snapshot
    const { SnapshotRepository } = await import("../src/domain/snapshot-repository.js");
    const snapRepo = new SnapshotRepository(db);
    snapRepo.createSnapshot(softwareTeam.id, "manual", {
      softwareTeam: { id: softwareTeam.id, name: "multi-software-team" },
      nodes: [
        { id: n1.id, logicalId: "dev.driver", softwareTeamId: softwareTeam.id, runtime: "claude-code", podId: pod.id },
        { id: n2.id, logicalId: "dev.guard", softwareTeamId: softwareTeam.id, runtime: "codex", podId: pod.id },
      ],
      sessions: [
        // Deliberate fresh (relaunch_fresh) → a genuine successful launch. FR-7: a
        // resume_if_possible seat with a token but no adapter to verify would instead
        // land awaiting-decision (covered by the next test).
        { id: "s1", nodeId: n1.id, sessionName: "dev-driver@multi-software-team", status: "running", resumeType: "claude-native", resumeToken: "t1", restorePolicy: "relaunch_fresh" },
        { id: "s2", nodeId: n2.id, sessionName: "dev-guard@multi-software-team", status: "running", resumeType: "codex-native", resumeToken: "t2", restorePolicy: "relaunch_fresh" },
      ],
      edges: [],
      checkpoints: {},
      nodeStartupContext: {
        [n1.id]: { projectionEntries: [], resolvedStartupFiles: [], startupActions: [], runtime: "claude-code" },
        [n2.id]: { projectionEntries: [], resolvedStartupFiles: [], startupActions: [], runtime: "codex" },
      },
    } as any);

    const res = await app.request(`/api/software-teams/${softwareTeam.id}/nodes/launch-subset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seats: ["dev.driver", "dev.guard"], holdReason: "test" }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.launched).toHaveLength(2);
    const launchedIds = body.launched.map((n: { logicalId: string }) => n.logicalId).sort();
    expect(launchedIds).toEqual(["dev.driver", "dev.guard"]);

    // Verify restore.subset_completed emitted with both nodes
    const events = db.prepare("SELECT payload FROM events WHERE type = 'restore.subset_completed'").all() as { payload: string }[];
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    const eventIds = payload.result.nodes.map((n: { logicalId: string }) => n.logicalId).sort();
    expect(eventIds).toEqual(["dev.driver", "dev.guard"]);
  });

  it("POST .../nodes/launch-subset plan discloses non-target effects before mutation", async () => {
    const { app, softwareTeamRepo } = createTestApp(db);
    const podRepo = new PodRepository(db);
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("plan-software-team");
    const pod = podRepo.createPod(softwareTeam.id, "dev", "Development");
    const driver = softwareTeamRepo.addNode(softwareTeam.id, "dev.driver", { runtime: "claude-code", podId: pod.id });
    const guard = softwareTeamRepo.addNode(softwareTeam.id, "dev.guard", { runtime: "codex", podId: pod.id });
    const { SnapshotRepository } = await import("../src/domain/snapshot-repository.js");
    new SnapshotRepository(db).createSnapshot(softwareTeam.id, "manual", {
      softwareTeam: { id: softwareTeam.id, name: "plan-software-team" },
      nodes: [driver, guard],
      sessions: [],
      edges: [],
      checkpoints: {},
    } as any);
    const before = {
      sessions: db.prepare("SELECT COUNT(*) AS n FROM sessions").get(),
      events: db.prepare("SELECT COUNT(*) AS n FROM events").get(),
    };

    const res = await app.request(`/api/software-teams/${softwareTeam.id}/nodes/launch-subset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seats: ["dev.driver"], holdReason: "operator hold", plan: true }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      planOnly: true,
      targetNodes: [{ logicalId: "dev.driver" }],
      nonTargetEffects: {
        mode: "detach_and_hold",
        affected: [{ logicalId: "dev.guard", reason: "operator hold" }],
      },
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual(before.sessions);
    expect(db.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual(before.events);
  });

  it("POST .../nodes/launch-subset does NOT report an awaiting-decision restore as a successful launch (FR-7)", async () => {
    const { app, softwareTeamRepo } = createTestApp(db);
    const podRepo = new PodRepository(db);
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("fr7-software-team");
    const pod = podRepo.createPod(softwareTeam.id, "dev", "Development");
    const n1 = softwareTeamRepo.addNode(softwareTeam.id, "dev.driver", { runtime: "claude-code", podId: pod.id });
    const { SnapshotRepository } = await import("../src/domain/snapshot-repository.js");
    const snapRepo = new SnapshotRepository(db);
    snapRepo.createSnapshot(softwareTeam.id, "manual", {
      softwareTeam: { id: softwareTeam.id, name: "fr7-software-team" },
      nodes: [{ id: n1.id, logicalId: "dev.driver", softwareTeamId: softwareTeam.id, runtime: "claude-code", podId: pod.id }],
      // resume_if_possible + token, but the route harness wires NO runtime adapter →
      // continuity cannot be verified → the seat lands awaiting-decision, NOT a 201.
      sessions: [{ id: "s1", nodeId: n1.id, sessionName: "dev-driver@fr7-software-team", status: "running", resumeType: "claude-native", resumeToken: "t1", restorePolicy: "resume_if_possible" }],
      edges: [],
      checkpoints: {},
    } as any);

    const res = await app.request(`/api/software-teams/${softwareTeam.id}/nodes/launch-subset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seats: ["dev.driver"] }),
    });

    // FR-7: a target with no running session must NOT be reported as a successful launch.
    expect(res.status).not.toBe(201);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.ok).toBe(false);
    const driver = body.launched.find((n: { logicalId: string; status: string }) => n.logicalId === "dev.driver");
    expect(driver.status).toBe("awaiting-decision");
  });

  it("POST .../nodes/launch-subset rejects empty seats array", async () => {
    const { app, softwareTeamRepo } = createTestApp(db);
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("empty-software-team");

    const res = await app.request(`/api/software-teams/${softwareTeam.id}/nodes/launch-subset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seats: [] }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("invalid_request");
  });

  it("POST .../focus with valid cmux binding -> calls focusSurface", async () => {
    const cmux = connectedCmux();
    await cmux.connect();
    const focusSpy = vi.spyOn(cmux, "focusSurface");
    const { app, softwareTeamRepo, sessionRegistry } = createTestApp(db, { cmux });
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("r01");
    const node = softwareTeamRepo.addNode(softwareTeam.id, "dev1-impl");
    sessionRegistry.updateBinding(node.id, { cmuxSurface: "surface-42" });

    const res = await app.request(`/api/software-teams/${softwareTeam.id}/nodes/dev1-impl/focus`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    // Prove focusSurface was actually called with the correct surface ID
    expect(focusSpy).toHaveBeenCalledOnce();
    expect(focusSpy).toHaveBeenCalledWith("surface-42");
  });

  it("POST .../focus node has no cmux surface -> 409, cmux NOT called", async () => {
    const cmux = connectedCmux();
    await cmux.connect();
    const focusSpy = vi.spyOn(cmux, "focusSurface");
    const { app, softwareTeamRepo } = createTestApp(db, { cmux });
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("r01");
    softwareTeamRepo.addNode(softwareTeam.id, "dev1-impl");

    const res = await app.request(`/api/software-teams/${softwareTeam.id}/nodes/dev1-impl/focus`, {
      method: "POST",
    });
    expect(res.status).toBe(409);
    // Prove focusSurface was NOT called
    expect(focusSpy).not.toHaveBeenCalled();
  });

  it("POST .../focus nonexistent logicalId -> 404", async () => {
    const { app, softwareTeamRepo } = createTestApp(db);
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("r01");

    const res = await app.request(`/api/software-teams/${softwareTeam.id}/nodes/nonexistent/focus`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });

  it("POST .../focus cmux unavailable -> 200 { ok: false, code: 'unavailable' }", async () => {
    const cmux = unavailableCmux();
    await cmux.connect();
    const { app, softwareTeamRepo, sessionRegistry } = createTestApp(db, { cmux });
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("r01");
    const node = softwareTeamRepo.addNode(softwareTeam.id, "dev1-impl");
    sessionRegistry.updateBinding(node.id, { cmuxSurface: "surface-42" });

    const res = await app.request(`/api/software-teams/${softwareTeam.id}/nodes/dev1-impl/focus`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("unavailable");
  });

  // -- open-cmux tests --

  it("POST .../open-cmux with existing cmuxSurface -> focused_existing, no create/send side effects", async () => {
    const { adapter: cmux, calls } = trackingCmux();
    await cmux.connect();
    const { app, softwareTeamRepo, sessionRegistry } = createTestApp(db, { cmux });
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("r01");
    const node = softwareTeamRepo.addNode(softwareTeam.id, "dev1-impl");
    sessionRegistry.registerSession(node.id, "r01-dev1-impl");
    sessionRegistry.updateBinding(node.id, { cmuxSurface: "surface:42", cmuxWorkspace: "workspace:1" });

    // Clear capability call from connect
    calls.length = 0;

    const res = await app.request(`/api/software-teams/${softwareTeam.id}/nodes/dev1-impl/open-cmux`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
    expect(body["action"]).toBe("focused_existing");

    // Only focusSurface should have been called — no create, no send, no workspace.current
    const methodNames = calls.map((c) => c.method);
    expect(methodNames).toContain("surface.focus");
    expect(methodNames).not.toContain("surface.create");
    expect(methodNames).not.toContain("surface.sendText");
    expect(methodNames).not.toContain("workspace.current");
  });

  it("POST .../open-cmux with stale existing cmuxSurface -> recreates, rebinds, and focuses new surface", async () => {
    const { adapter: cmux, calls } = staleBindingCmux();
    await cmux.connect();
    const { app, softwareTeamRepo, sessionRegistry } = createTestApp(db, { cmux });
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("r01");
    const node = softwareTeamRepo.addNode(softwareTeam.id, "dev1-impl");
    sessionRegistry.registerSession(node.id, "r01-dev1-impl");
    sessionRegistry.updateBinding(node.id, {
      attachmentType: "tmux",
      tmuxSession: "r01-dev1-impl",
      cmuxWorkspace: "workspace:old",
      cmuxSurface: "OK surface:78 pane:2 workspace:1",
    });

    calls.length = 0;

    const res = await app.request(`/api/software-teams/${softwareTeam.id}/nodes/dev1-impl/open-cmux`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
    expect(body["action"]).toBe("created_new");

    const methodNames = calls.map((c) => c.method);
    expect(methodNames.filter((name) => name === "surface.focus")).toHaveLength(2);
    expect(methodNames).toContain("workspace.current");
    expect(methodNames).toContain("surface.create");
    expect(methodNames).toContain("surface.sendText");

    const binding = sessionRegistry.getBindingForNode(node.id);
    expect(binding?.cmuxWorkspace).toBe("workspace:1");
    expect(binding?.cmuxSurface).toBe("surface:99");
  });

  it("POST .../open-cmux tmux-backed node without cmuxSurface -> created_new, binds workspace+surface, sends tmux attach", async () => {
    const { adapter: cmux, calls } = trackingCmux();
    await cmux.connect();
    const { app, softwareTeamRepo, sessionRegistry } = createTestApp(db, { cmux });
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("r01");
    const node = softwareTeamRepo.addNode(softwareTeam.id, "dev1-impl");
    sessionRegistry.registerSession(node.id, "r01-dev1-impl");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "r01-dev1-impl", attachmentType: "tmux" });

    calls.length = 0;

    const res = await app.request(`/api/software-teams/${softwareTeam.id}/nodes/dev1-impl/open-cmux`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
    expect(body["action"]).toBe("created_new");

    // Must have used currentWorkspace as anchor, NOT created a new workspace
    const methodNames = calls.map((c) => c.method);
    expect(methodNames).toContain("workspace.current");
    expect(methodNames).toContain("surface.create");
    expect(methodNames).toContain("surface.sendText");
    expect(methodNames).toContain("surface.focus");
    expect(methodNames).not.toContain("workspace.create");

    // sendText must contain tmux attach
    const sendCall = calls.find((c) => c.method === "surface.sendText");
    expect(sendCall).toBeDefined();
    const sendParams = sendCall!.params as Record<string, unknown>;
    expect(String(sendParams["text"])).toBe("tmux attach -t r01-dev1-impl\n");
    expect(sendParams["workspaceId"]).toBe("workspace:1");

    const focusCalls = calls.filter((c) => c.method === "surface.focus");
    expect(focusCalls).toHaveLength(1);
    expect((focusCalls[0]!.params as Record<string, unknown>)["workspaceId"]).toBe("workspace:1");

    // Binding must be persisted with both workspace and surface
    const binding = sessionRegistry.getBindingForNode(node.id);
    expect(binding?.cmuxWorkspace).toBe("workspace:1");
    expect(binding?.cmuxSurface).toBe("surface:99");
  });

  it("POST .../open-cmux external-cli node -> created_helper, honest helper text, no tmux attach", async () => {
    const { adapter: cmux, calls } = trackingCmux();
    await cmux.connect();
    const { app, softwareTeamRepo, sessionRegistry } = createTestApp(db, { cmux });
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("r01");
    const node = softwareTeamRepo.addNode(softwareTeam.id, "ext-node");
    sessionRegistry.registerSession(node.id, "r01-ext-node");
    sessionRegistry.updateBinding(node.id, { attachmentType: "external_cli", externalSessionName: "r01-ext-node" });

    calls.length = 0;

    const res = await app.request(`/api/software-teams/${softwareTeam.id}/nodes/ext-node/open-cmux`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
    expect(body["action"]).toBe("created_helper");

    // Helper text must include honest commands, NOT tmux attach
    const sendCall = calls.find((c) => c.method === "surface.sendText");
    expect(sendCall).toBeDefined();
    const text = String((sendCall!.params as Record<string, unknown>)["text"]);
    expect(text).not.toContain("tmux attach");
    expect(text).toContain("SoftwareTeam capture r01-ext-node");
    expect(text).toContain("SoftwareTeam transcript r01-ext-node --tail 100");
    expect(text).toContain("SoftwareTeam send r01-ext-node");
    expect(text).toContain("--verify");
  });

  it("POST .../open-cmux sendText failure -> does not report ok:true, cmuxSurface NOT persisted for tmux-backed (deferred until attach succeeds)", async () => {
    const { adapter: cmux } = failingCmux("surface.sendText");
    await cmux.connect();
    const { app, softwareTeamRepo, sessionRegistry } = createTestApp(db, { cmux });
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("r01");
    const node = softwareTeamRepo.addNode(softwareTeam.id, "dev1-impl");
    sessionRegistry.registerSession(node.id, "r01-dev1-impl");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "r01-dev1-impl", attachmentType: "tmux" });

    const res = await app.request(`/api/software-teams/${softwareTeam.id}/nodes/dev1-impl/open-cmux`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["ok"]).toBe(false);
    expect(body["error"]).toContain("connection lost");

    // OPR.0.3.4.8: cmuxSurface NOT persisted for tmux-backed nodes when attach
    // failed — deferred persistence prevents stale focused_existing on retry.
    const binding = sessionRegistry.getBindingForNode(node.id);
    expect(binding?.cmuxSurface).toBeNull();
  });

  it("POST .../open-cmux focusSurface failure after creation -> does not report ok:true", async () => {
    const { adapter: cmux } = failingCmux("surface.focus");
    await cmux.connect();
    const { app, softwareTeamRepo, sessionRegistry } = createTestApp(db, { cmux });
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("r01");
    const node = softwareTeamRepo.addNode(softwareTeam.id, "dev1-impl");
    sessionRegistry.registerSession(node.id, "r01-dev1-impl");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "r01-dev1-impl", attachmentType: "tmux" });

    const res = await app.request(`/api/software-teams/${softwareTeam.id}/nodes/dev1-impl/open-cmux`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["ok"]).toBe(false);
    expect(body["error"]).toContain("connection lost");
  });

  // NS-T08: node inventory route
  it("GET /api/software-teams/:softwareTeamId/nodes -> node inventory array", async () => {
    const { app, softwareTeamRepo, sessionRegistry } = createTestApp(db);
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("test-software-team");
    const node = softwareTeamRepo.addNode(softwareTeam.id, "dev.impl", { runtime: "claude-code" });
    sessionRegistry.registerSession(node.id, "dev-impl@test-software-team");

    const res = await app.request(`/api/software-teams/${softwareTeam.id}/nodes`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect(body[0].nodeId).toBe(node.id);
    expect(body[0].logicalId).toBe("dev.impl");
    expect(body[0].nodeKind).toBe("agent");
    expect(body[0].canonicalSessionName).toBe("dev-impl@test-software-team");
  });

  it("keeps permission observation off the fleet list and attaches it only to single-node detail", async () => {
    const diagnose = vi.fn(() => ({
      transport: { state: "healthy" as const },
      cwdRead: { state: "visible" as const },
      commandPath: { state: "available" as const },
      enforcement: { axis: "sandbox" as const, state: "aligned" as const, expected: "workspace-write", effective: "workspace-write", sourcePath: null },
      observedAt: "2026-08-08T00:00:00.000Z",
    }));
    const { app, softwareTeamRepo, sessionRegistry } = createTestApp(db, { permissionDriftObserver: { diagnose } });
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("test-software-team");
    const node = softwareTeamRepo.addNode(softwareTeam.id, "dev.impl", { runtime: "codex" });
    sessionRegistry.registerClaimedSession(node.id, "dev-impl@test-software-team");

    const list = await app.request(`/api/software-teams/${softwareTeam.id}/nodes?full=true`);
    expect(list.status).toBe(200);
    expect((await list.json())[0].permissionDrift).toBeUndefined();
    expect(diagnose).not.toHaveBeenCalled();

    const detail = await app.request(`/api/software-teams/${softwareTeam.id}/nodes/${encodeURIComponent("dev.impl")}`);
    expect(detail.status).toBe(200);
    expect((await detail.json()).permissionDrift).toMatchObject({ enforcement: { axis: "sandbox", state: "aligned" } });
    expect(diagnose).toHaveBeenCalledOnce();
    expect(diagnose).toHaveBeenCalledWith(node.id);
  });

  it("GET /api/software-teams/:softwareTeamId/nodes includes read-only agent activity evidence", async () => {
    const tmux = {
      hasSession: vi.fn(async () => true),
      capturePaneContent: vi.fn(async () => "Working on task...\n⠋ Processing files\nesc to interrupt"),
    } as unknown as TmuxAdapter;
    const { app, softwareTeamRepo, sessionRegistry } = createTestApp(db, { tmux });
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("test-software-team");
    const node = softwareTeamRepo.addNode(softwareTeam.id, "dev.impl", { runtime: "claude-code" });
    sessionRegistry.registerSession(node.id, "dev-impl@test-software-team");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-impl@test-software-team", attachmentType: "tmux" });

    // OPR.0.4.3 healthz-wedge: the per-node tmux pane-heuristic is now behind
    // ?full=true (cheap-default skips it) — request full to exercise the probe.
    const res = await app.request(`/api/software-teams/${softwareTeam.id}/nodes?full=true`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body[0].agentActivity).toMatchObject({
      state: "running",
      reason: "mid_work_pattern",
      evidenceSource: "pane_heuristic",
      fallback: true,
    });
    expect(typeof body[0].agentActivity.sampledAt).toBe("string");
    expect(tmux.capturePaneContent).toHaveBeenCalledWith("dev-impl@test-software-team", 20);
  });

  it("GET /api/software-teams/:softwareTeamId/nodes prefers fresh hook activity over pane fallback", async () => {
    const tmux = {
      hasSession: vi.fn(async () => true),
      capturePaneContent: vi.fn(async () => "› idle\n\ngpt-5.5 xhigh fast · Context [████ ]"),
    } as unknown as TmuxAdapter;
    const { app, softwareTeamRepo, sessionRegistry, agentActivityStore } = createTestApp(db, {
      tmux,
      activityHookToken: "test-token",
    });
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("test-software-team");
    const node = softwareTeamRepo.addNode(softwareTeam.id, "dev.impl", { runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@test-software-team");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-impl@test-software-team", attachmentType: "tmux" });
    agentActivityStore.recordHookEvent({
      runtime: "claude-code",
      sessionName: "dev-impl@test-software-team",
      hookEvent: "Notification",
      subtype: "permission_prompt",
      occurredAt: new Date().toISOString(),
      // W2a-1 — carry the emitting occupant generation (source-bound) so the read RESOLVES and the fresh
      // hook state is honored, rather than degrading to generation_unverifiable.
      generation: sessionRegistry.currentOccupantTenure(node.id)?.generationUuid ?? null,
    });

    const res = await app.request(`/api/software-teams/${softwareTeam.id}/nodes`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body[0].agentActivity).toMatchObject({
      state: "needs_input",
      reason: "permission_prompt",
      evidenceSource: "runtime_hook",
      fallback: false,
      rawEvent: "Notification",
      rawSubtype: "permission_prompt",
    });
    expect(tmux.capturePaneContent).not.toHaveBeenCalled();
  });

  it("GET /api/software-teams/:softwareTeamId/nodes reports stale hook evidence as unknown without pane fallback", async () => {
    const tmux = {
      hasSession: vi.fn(async () => true),
      capturePaneContent: vi.fn(async () => "Working on task...\n⠋ Processing files\nesc to interrupt"),
    } as unknown as TmuxAdapter;
    const { app, softwareTeamRepo, sessionRegistry, agentActivityStore } = createTestApp(db, {
      tmux,
      activityHookToken: "test-token",
      activityFreshnessMs: 1,
    });
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("test-software-team");
    const node = softwareTeamRepo.addNode(softwareTeam.id, "dev.impl", { runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@test-software-team");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-impl@test-software-team", attachmentType: "tmux" });
    agentActivityStore.recordHookEvent({
      runtime: "claude-code",
      sessionName: "dev-impl@test-software-team",
      hookEvent: "UserPromptSubmit",
      occurredAt: "2000-01-01T00:00:00.000Z",
      // W2a-1 — carry the emitting generation so the read RESOLVES, letting the CLOCK-staleness verdict
      // (stale_runtime_hook) fire — rather than the generation gate short-circuiting to unverifiable.
      generation: sessionRegistry.currentOccupantTenure(node.id)?.generationUuid ?? null,
    });

    const res = await app.request(`/api/software-teams/${softwareTeam.id}/nodes`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body[0].agentActivity).toMatchObject({
      state: "unknown",
      reason: "stale_runtime_hook",
      evidenceSource: "runtime_hook",
      stale: true,
    });
    expect(tmux.capturePaneContent).not.toHaveBeenCalled();
  });

  it("GET /api/software-teams/:softwareTeamId/nodes marks external CLI activity unsupported instead of idle", async () => {
    const { app, softwareTeamRepo, sessionRegistry } = createTestApp(db);
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("test-software-team");
    const node = softwareTeamRepo.addNode(softwareTeam.id, "orch.lead", { runtime: "claude-code" });
    sessionRegistry.registerClaimedSession(node.id, "orch-lead@test-software-team");
    sessionRegistry.updateBinding(node.id, {
      attachmentType: "external_cli",
      externalSessionName: "orch-lead@test-software-team",
    });

    // OPR.0.4.3 healthz-wedge: probe classification is behind ?full=true now.
    const res = await app.request(`/api/software-teams/${softwareTeam.id}/nodes?full=true`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body[0].agentActivity).toMatchObject({
      state: "unknown",
      reason: "unsupported_attachment",
      evidenceSource: "external_cli",
    });
  });

  it("GET /api/software-teams/:softwareTeamId/nodes is CHEAP by default (OPR.0.4.3 healthz-wedge) — a hook-less seat gets the unknown/no_runtime_hook placeholder and NO per-node tmux capture", async () => {
    const tmux = {
      hasSession: vi.fn(async () => true),
      capturePaneContent: vi.fn(async () => "Working on task...\nesc to interrupt"),
    } as unknown as TmuxAdapter;
    const { app, softwareTeamRepo, sessionRegistry } = createTestApp(db, { tmux });
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("test-software-team");
    const node = softwareTeamRepo.addNode(softwareTeam.id, "dev.impl", { runtime: "claude-code" });
    sessionRegistry.registerSession(node.id, "dev-impl@test-software-team");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-impl@test-software-team", attachmentType: "tmux" });

    // No ?full → cheap default.
    const res = await app.request(`/api/software-teams/${softwareTeam.id}/nodes`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body[0].agentActivity).toMatchObject({
      state: "unknown",
      reason: "no_runtime_hook",
      evidenceSource: "session_registry",
      fallback: true,
    });
    // THE cure: no per-node tmux capture on the default hot path.
    expect(tmux.capturePaneContent).not.toHaveBeenCalled();
  });

  it("POST /api/activity/hooks requires the configured local hook token", async () => {
    const { app } = createTestApp(db, { activityHookToken: "test-token" });

    const res = await app.request("/api/activity/hooks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runtime: "claude-code",
        sessionName: "dev-impl@test-software-team",
        hookEvent: "UserPromptSubmit",
      }),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("activity_hook_unauthorized");
  });

  it("POST /api/activity/hooks ingests authenticated runtime hook events", async () => {
    const { app, softwareTeamRepo, sessionRegistry } = createTestApp(db, { activityHookToken: "test-token" });
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("test-software-team");
    const node = softwareTeamRepo.addNode(softwareTeam.id, "dev.impl", { runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@test-software-team");
    sessionRegistry.updateStatus(session.id, "running");

    const res = await app.request("/api/activity/hooks", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": "Bearer test-token",
      },
      body: JSON.stringify({
        runtime: "claude-code",
        sessionName: "dev-impl@test-software-team",
        hookEvent: "PreToolUse",
        occurredAt: "2026-04-24T11:59:00.000Z",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.activity).toMatchObject({
      state: "running",
      reason: "pre_tool_use",
      evidenceSource: "runtime_hook",
    });
  });

  it("GET /api/software-teams/:softwareTeamId/nodes -> 404 for unknown softwareTeam", async () => {
    const { app } = createTestApp(db);
    const res = await app.request("/api/software-teams/nonexistent/nodes");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("not found");
  });

  // NS-T09: node detail route
  it("GET /api/software-teams/:softwareTeamId/nodes/:logicalId -> node detail", async () => {
    const { app, softwareTeamRepo, sessionRegistry } = createTestApp(db);
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("test-software-team");
    const node = softwareTeamRepo.addNode(softwareTeam.id, "dev.impl", { runtime: "claude-code" });
    sessionRegistry.registerSession(node.id, "dev-impl@test-software-team");

    const res = await app.request(`/api/software-teams/${softwareTeam.id}/nodes/${encodeURIComponent("dev.impl")}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.logicalId).toBe("dev.impl");
    expect(body.nodeKind).toBe("agent");
    expect(Array.isArray(body.startupFiles)).toBe(true);
    expect(Array.isArray(body.recentEvents)).toBe(true);
  });

  it("GET /api/software-teams/:softwareTeamId/nodes/:logicalId -> 404 for unknown node", async () => {
    const { app, softwareTeamRepo } = createTestApp(db);
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("test-software-team");
    const res = await app.request(`/api/software-teams/${softwareTeam.id}/nodes/nonexistent`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("not found");
  });

  // Task 5: node detail returns peers, edges, transcript, compactSpec
  it("node detail returns peers for other nodes in same softwareTeam", async () => {
    const { app, softwareTeamRepo, sessionRegistry } = createTestApp(db);
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("test-software-team");
    const n1 = softwareTeamRepo.addNode(softwareTeam.id, "dev.impl", { runtime: "claude-code" });
    const n2 = softwareTeamRepo.addNode(softwareTeam.id, "dev.qa", { runtime: "codex" });
    sessionRegistry.registerSession(n1.id, "dev-impl@test");
    sessionRegistry.registerSession(n2.id, "dev-qa@test");

    const res = await app.request(`/api/software-teams/${softwareTeam.id}/nodes/${encodeURIComponent("dev.impl")}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.peers).toHaveLength(1);
    expect(body.peers[0].logicalId).toBe("dev.qa");
    expect(body.peers[0].canonicalSessionName).toBe("dev-qa@test");
    expect(body.peers[0].runtime).toBe("codex");
  });

  it("node detail returns outgoing and incoming edges", async () => {
    const { app, softwareTeamRepo, sessionRegistry } = createTestApp(db);
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("test-software-team");
    const n1 = softwareTeamRepo.addNode(softwareTeam.id, "dev.impl", { runtime: "claude-code" });
    const n2 = softwareTeamRepo.addNode(softwareTeam.id, "dev.qa", { runtime: "codex" });
    sessionRegistry.registerSession(n1.id, "dev-impl@test");
    sessionRegistry.registerSession(n2.id, "dev-qa@test");
    softwareTeamRepo.addEdge(softwareTeam.id, n1.id, n2.id, "delegates_to");

    const res = await app.request(`/api/software-teams/${softwareTeam.id}/nodes/${encodeURIComponent("dev.impl")}`);
    const body = await res.json();
    expect(body.edges.outgoing).toHaveLength(1);
    expect(body.edges.outgoing[0].kind).toBe("delegates_to");
    expect(body.edges.outgoing[0].to.logicalId).toBe("dev.qa");
    expect(body.edges.incoming).toHaveLength(0);

    // Check from qa perspective
    const res2 = await app.request(`/api/software-teams/${softwareTeam.id}/nodes/${encodeURIComponent("dev.qa")}`);
    const body2 = await res2.json();
    expect(body2.edges.incoming).toHaveLength(1);
    expect(body2.edges.incoming[0].from.logicalId).toBe("dev.impl");
    expect(body2.edges.outgoing).toHaveLength(0);
  });

  it("node detail returns compact spec summary", async () => {
    const { app, softwareTeamRepo, sessionRegistry } = createTestApp(db);
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("test-software-team");
    const n1 = softwareTeamRepo.addNode(softwareTeam.id, "dev.impl", { runtime: "claude-code", profile: "default" });
    // Set resolved spec fields
    db.prepare("UPDATE nodes SET resolved_spec_name = ?, resolved_spec_version = ? WHERE id = ?")
      .run("impl-agent", "1.0.0", n1.id);
    sessionRegistry.registerSession(n1.id, "dev-impl@test");

    const res = await app.request(`/api/software-teams/${softwareTeam.id}/nodes/${encodeURIComponent("dev.impl")}`);
    const body = await res.json();
    expect(body.compactSpec).toBeDefined();
    expect(body.compactSpec.name).toBe("impl-agent");
    expect(body.compactSpec.version).toBe("1.0.0");
    expect(body.compactSpec.profile).toBe("default");
    expect(typeof body.compactSpec.skillCount).toBe("number");
    expect(typeof body.compactSpec.guidanceCount).toBe("number");
  });

  it("node detail returns transcript info (defaults to disabled without TranscriptStore)", async () => {
    const { app, softwareTeamRepo, sessionRegistry } = createTestApp(db);
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("test-software-team");
    const n1 = softwareTeamRepo.addNode(softwareTeam.id, "dev.impl", { runtime: "claude-code" });
    sessionRegistry.registerSession(n1.id, "dev-impl@test");

    const res = await app.request(`/api/software-teams/${softwareTeam.id}/nodes/${encodeURIComponent("dev.impl")}`);
    const body = await res.json();
    expect(body.transcript).toBeDefined();
    expect(body.transcript.enabled).toBe(false);
    expect(body.transcript.path).toBeNull();
    expect(body.transcript.tailCommand).toBeNull();
  });

  it("node detail returns enriched transcript info when TranscriptStore is enabled", async () => {
    const { TranscriptStore } = await import("../src/domain/transcript-store.js");
    const os = await import("node:os");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const tmpDir = path.join(os.tmpdir(), `softwareteam-test-transcript-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    const transcriptStore = new TranscriptStore(tmpDir);
    const { createApp } = await import("../src/server.js");
    const setup = createTestApp(db);
    const softwareTeam = setup.softwareTeamRepo.createSoftwareTeam("test-software-team");
    const n1 = setup.softwareTeamRepo.addNode(softwareTeam.id, "dev.impl", { runtime: "claude-code" });
    setup.sessionRegistry.registerSession(n1.id, "dev-impl@test-software-team");

    // Build a minimal app with TranscriptStore wired
    const appWithTranscript = createApp({ ...setup, transcriptStore });

    const res = await appWithTranscript.request(`/api/software-teams/${softwareTeam.id}/nodes/${encodeURIComponent("dev.impl")}`);
    const body = await res.json();
    expect(body.transcript.enabled).toBe(true);
    expect(body.transcript.path).toContain("test-software-team");
    expect(body.transcript.path).toContain("dev-impl@test-software-team");
    expect(body.transcript.tailCommand).toBe("SoftwareTeam transcript dev-impl@test-software-team --tail 100");

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- Context refresh route tests ---

  it("GET /api/software-teams/:id/nodes?refresh=true calls contextMonitor.pollOnce before projection", async () => {
    const db2 = createFullTestDb();
    const pollOnceSpy = vi.fn(async () => {});
    const setup = createTestApp(db2);
    const { createApp } = await import("../src/server.js");
    const appWithMonitor = createApp({ ...setup, contextMonitor: { pollOnce: pollOnceSpy } });
    const softwareTeam = setup.softwareTeamRepo.createSoftwareTeam("refresh-software-team");
    setup.softwareTeamRepo.addNode(softwareTeam.id, "worker", { runtime: "claude-code" });

    await appWithMonitor.request(`/api/software-teams/${softwareTeam.id}/nodes?refresh=true`);

    expect(pollOnceSpy).toHaveBeenCalledOnce();
    db2.close();
  });

  it("GET /api/software-teams/:id/nodes without refresh does not call pollOnce", async () => {
    const db2 = createFullTestDb();
    const pollOnceSpy = vi.fn(async () => {});
    const setup = createTestApp(db2);
    const { createApp } = await import("../src/server.js");
    const appWithMonitor = createApp({ ...setup, contextMonitor: { pollOnce: pollOnceSpy } });
    const softwareTeam = setup.softwareTeamRepo.createSoftwareTeam("no-refresh-software-team");
    setup.softwareTeamRepo.addNode(softwareTeam.id, "worker", { runtime: "claude-code" });

    await appWithMonitor.request(`/api/software-teams/${softwareTeam.id}/nodes`);

    expect(pollOnceSpy).not.toHaveBeenCalled();
    db2.close();
  });

  it("GET /api/software-teams/:id/nodes?refresh=true returns 502 when pollOnce throws", async () => {
    const db2 = createFullTestDb();
    const pollOnceSpy = vi.fn(async () => { throw new Error("statusline read failed"); });
    const setup = createTestApp(db2);
    const { createApp } = await import("../src/server.js");
    const appWithMonitor = createApp({ ...setup, contextMonitor: { pollOnce: pollOnceSpy } });
    const softwareTeam = setup.softwareTeamRepo.createSoftwareTeam("fail-refresh-software-team");
    setup.softwareTeamRepo.addNode(softwareTeam.id, "worker", { runtime: "claude-code" });

    const res = await appWithMonitor.request(`/api/software-teams/${softwareTeam.id}/nodes?refresh=true`);

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe("context_refresh_failed");
    expect(body.detail).toContain("statusline read failed");
    db2.close();
  });

  it("GET /api/software-teams/:id/nodes?refresh=true works when no contextMonitor is wired", async () => {
    const db2 = createFullTestDb();
    const setup = createTestApp(db2);
    const { createApp } = await import("../src/server.js");
    const appNoMonitor = createApp({ ...setup }); // no contextMonitor
    const softwareTeam = setup.softwareTeamRepo.createSoftwareTeam("no-monitor-software-team");
    setup.softwareTeamRepo.addNode(softwareTeam.id, "worker", { runtime: "claude-code" });

    const res = await appNoMonitor.request(`/api/software-teams/${softwareTeam.id}/nodes?refresh=true`);

    // Should succeed (no monitor = nothing to poll; returns stale data honestly)
    expect(res.status).toBe(200);
    db2.close();
  });
});
