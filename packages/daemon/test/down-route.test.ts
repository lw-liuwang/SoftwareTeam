import { describe, it, expect, vi } from "vitest";
import { createFullTestDb, createTestApp, mockTmuxAdapter } from "./helpers/test-app.js";
import { SoftwareTeamTeardownOrchestrator } from "../src/domain/software-team-teardown.js";
import { createApp } from "../src/server.js";

describe("POST /api/down route", () => {
  // R1: missing softwareTeamId -> 400
  it("returns 400 when softwareTeamId is missing", async () => {
    const { app } = createTestApp(createFullTestDb());
    const res = await app.request("/api/down", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/softwareTeamId/);
  });

  // R2: nonexistent softwareTeam -> 404
  it("returns 404 for nonexistent softwareTeam", async () => {
    const { app } = createTestApp(createFullTestDb());
    const res = await app.request("/api/down", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ softwareTeamId: "nonexistent-software-team" }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/not found/i);
  });

  // R3: --delete blocked by kill failure -> 409
  it("returns 409 when delete is blocked by kill failures", async () => {
    const tmux = mockTmuxAdapter();
    (tmux.killSession as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, message: "kill failed" });
    const db = createFullTestDb();
    const { app, softwareTeamRepo, sessionRegistry } = createTestApp(db, { tmux });

    const softwareTeam = softwareTeamRepo.createSoftwareTeam("test-software-team");
    const node = softwareTeamRepo.addNode(softwareTeam.id, "n1");
    const session = sessionRegistry.registerSession(node.id, "r01-dev1");
    sessionRegistry.updateStatus(session.id, "running");

    const res = await app.request("/api/down", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ softwareTeamId: softwareTeam.id, delete: true }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.deleteBlocked).toBe(true);
    expect(body.deleted).toBe(false);
  });

  // R4: same-db-handle invariant
  it("throws if teardownOrchestrator uses a different db", () => {
    const db1 = createFullTestDb();
    const { app: _ignore, ...testApp1 } = createTestApp(db1);

    // Build a valid SoftwareTeamTeardownOrchestrator on a separate db
    const db2 = createFullTestDb();
    const { teardownOrchestrator: foreignTeardown } = createTestApp(db2);

    expect(() => {
      createApp({
        ...testApp1,
        teardownOrchestrator: foreignTeardown,
      });
    }).toThrow(/teardownOrchestrator must share the same db handle/);
  });

  // R5: internal delete failure -> 500 (via route catch, not TeardownResult)
  it("returns 500 for internal delete failure (not 409)", async () => {
    const tmux = mockTmuxAdapter();
    const db = createFullTestDb();
    const { app, softwareTeamRepo, sessionRegistry } = createTestApp(db, { tmux });

    const softwareTeam = softwareTeamRepo.createSoftwareTeam("test-software-team-2");
    const node = softwareTeamRepo.addNode(softwareTeam.id, "n1");
    const session = sessionRegistry.registerSession(node.id, "r01-dev1");
    sessionRegistry.updateStatus(session.id, "running");

    // Kill succeeds but deleteSoftwareTeam throws (internal failure during atomicDelete)
    const origDelete = softwareTeamRepo.deleteSoftwareTeam.bind(softwareTeamRepo);
    softwareTeamRepo.deleteSoftwareTeam = () => { throw new Error("disk full"); };

    const res = await app.request("/api/down", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ softwareTeamId: softwareTeam.id, delete: true }),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    // Route returns TeardownResult when orchestrator catches internally
    // but this path propagates via the non-alreadyStopped branch's try-catch
    expect(body.deleted).toBe(false);
    expect(body.deleteBlocked).toBe(false);

    softwareTeamRepo.deleteSoftwareTeam = origDelete;
  });

  // R6: --delete + snapshot failure + successful delete -> 200
  it("returns 200 when delete succeeds despite snapshot warnings", async () => {
    const tmux = mockTmuxAdapter();
    const db = createFullTestDb();
    const { app, softwareTeamRepo, sessionRegistry, snapshotCapture } = createTestApp(db, { tmux });

    const softwareTeam = softwareTeamRepo.createSoftwareTeam("test-software-team-3");
    const node = softwareTeamRepo.addNode(softwareTeam.id, "n1");
    const session = sessionRegistry.registerSession(node.id, "r01-dev1");
    sessionRegistry.updateStatus(session.id, "running");

    // Sabotage snapshot to produce an error
    const origCapture = snapshotCapture.captureSnapshot.bind(snapshotCapture);
    snapshotCapture.captureSnapshot = () => { throw new Error("snapshot disk full"); };

    const res = await app.request("/api/down", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ softwareTeamId: softwareTeam.id, delete: true, snapshot: true }),
    });
    // Snapshot failure → errors[], but delete still succeeds → 200
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted).toBe(true);
    expect(body.errors.length).toBeGreaterThan(0);

    snapshotCapture.captureSnapshot = origCapture;
  });

  // NS-T06: auto-snapshot on down
  it("auto-snapshots before teardown (auto-pre-down)", async () => {
    const db = createFullTestDb();
    const { app, softwareTeamRepo, sessionRegistry } = createTestApp(db);
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("auto-snap-software-team");
    const node = softwareTeamRepo.addNode(softwareTeam.id, "impl", { runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "r01-impl");
    sessionRegistry.updateStatus(session.id, "running");

    const res = await app.request("/api/down", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ softwareTeamId: softwareTeam.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // Auto-snapshot should have been created
    expect(body.snapshotId).toBeTruthy();
    // Verify snapshot kind
    const snap = db.prepare("SELECT kind FROM snapshots WHERE id = ?").get(body.snapshotId) as { kind: string } | undefined;
    expect(snap?.kind).toBe("auto-pre-down");
    db.close();
  });

  // NS-T06: down response includes softwareTeam name for handoff
  it("response includes softwareTeamName for post-command handoff", async () => {
    const db = createFullTestDb();
    const { app, softwareTeamRepo, sessionRegistry } = createTestApp(db);
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("handoff-test");
    const node = softwareTeamRepo.addNode(softwareTeam.id, "impl");
    const session = sessionRegistry.registerSession(node.id, "r01-impl");
    sessionRegistry.updateStatus(session.id, "running");

    const res = await app.request("/api/down", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ softwareTeamId: softwareTeam.id }),
    });
    const body = await res.json();
    expect(body.softwareTeamName).toBe("handoff-test");
    db.close();
  });
});
