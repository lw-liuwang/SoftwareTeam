import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { SoftwareTeamRepository } from "../src/domain/software-team-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SeatStatusService } from "../src/domain/seat-status-service.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";

describe("SeatStatusService", () => {
  let db: Database.Database;
  let softwareTeamRepo: SoftwareTeamRepository;
  let sessionRegistry: SessionRegistry;
  let service: SeatStatusService;

  beforeEach(() => {
    db = createFullTestDb();
    softwareTeamRepo = new SoftwareTeamRepository(db);
    sessionRegistry = new SessionRegistry(db);
    service = new SeatStatusService({ softwareTeamRepo });
  });

  afterEach(() => {
    db.close();
  });

  it("reports a confirmed missing current session as detached while preserving its registration", async () => {
    const { app, softwareTeamRepo: repo, sessionRegistry: registry } = createTestApp(db);
    const softwareTeam = repo.createSoftwareTeam("missing-seat");
    const node = repo.addNode(softwareTeam.id, "dev.impl", { runtime: "codex" });
    const session = registry.registerSession(node.id, "dev-impl@missing-seat");
    registry.updateStatus(session.id, "running");
    registry.updateStartupStatus(session.id, "ready");
    registry.updateBinding(node.id, { tmuxSession: session.sessionName, tmuxPane: "%1", attachmentType: "tmux" });
    const stored = db.prepare("SELECT * FROM sessions WHERE id = ?").get(session.id);
    new SeatIdentityStore(db).upsert({
      nodeId: node.id, sessionName: session.sessionName,
      verdict: "pane_missing", reason: "session_missing", evidenceSource: "tmux_session",
      evidence: { registeredPane: "%1", observedPid: null, observedCommand: null, matchedLayer: null },
      observedAt: new Date(Date.now() + 1).toISOString(),
    });
    const res = await app.request(`/api/seat/status/${encodeURIComponent(session.sessionName)}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      session_status: "detached", session_reason: "session_missing", startup_status: "ready",
      occupant_lifecycle: "unknown", current_occupant: session.sessionName,
    });
    expect(db.prepare("SELECT * FROM sessions WHERE id = ?").get(session.id)).toEqual(stored);
  });

  it("returns honest no-handover defaults for an existing active node", () => {
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("seat-software-team");
    const node = softwareTeamRepo.addNode(softwareTeam.id, "dev.impl", { runtime: "codex", cwd: "/project" });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@seat-software-team");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateStartupStatus(session.id, "ready", "2026-04-20T12:00:00Z");

    const result = service.getStatus("dev-impl@seat-software-team");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.status).toMatchObject({
      seat_ref: "dev-impl@seat-software-team",
      software_team_name: "seat-software-team",
      logical_id: "dev.impl",
      current_occupant: "dev-impl@seat-software-team",
      session_status: "running",
      startup_status: "ready",
      occupant_lifecycle: "active",
      continuity_outcome: null,
      handover_result: null,
      previous_occupant: null,
      handover_at: null,
    });
  });

  it("returns populated handover axes and provenance fields", () => {
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("seat-software-team");
    const node = softwareTeamRepo.addNode(softwareTeam.id, "dev.impl", { runtime: "claude-code" });
    sessionRegistry.registerSession(node.id, "dev-impl@seat-software-team");
    db.prepare(`
      UPDATE nodes SET
        occupant_lifecycle = 'retired',
        continuity_outcome = 'rebuilt',
        handover_result = 'partial',
        previous_occupant = 'old-impl@seat-software-team',
        handover_at = '2026-04-20T13:00:00Z'
      WHERE id = ?
    `).run(node.id);

    const result = service.getStatus("dev.impl@seat-software-team");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.status.occupant_lifecycle).toBe("retired");
    expect(result.status.continuity_outcome).toBe("rebuilt");
    expect(result.status.handover_result).toBe("partial");
    expect(result.status.previous_occupant).toBe("old-impl@seat-software-team");
    expect(result.status.handover_at).toBe("2026-04-20T13:00:00Z");
  });

  it("does not infer active lifecycle for a node with no current running session", () => {
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("seat-software-team");
    softwareTeamRepo.addNode(softwareTeam.id, "dev.impl", { runtime: "codex" });

    const result = service.getStatus("dev.impl@seat-software-team");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.status.current_occupant).toBeNull();
    expect(result.status.occupant_lifecycle).toBe("unknown");
    expect(result.status.continuity_outcome).toBeNull();
    expect(result.status.handover_result).toBeNull();
  });

  it("resolves canonical pod coordinates for never-launched, dotted-member and stopped seats", () => {
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("seat-software-team");
    const pod = new PodRepository(db).createPod(softwareTeam.id, "dev", "Development");
    softwareTeamRepo.addNode(softwareTeam.id, "dev.impl", { runtime: "terminal", podId: pod.id });
    softwareTeamRepo.addNode(softwareTeam.id, "dev.member.dot", { runtime: "terminal", podId: pod.id });
    const stopped = softwareTeamRepo.addNode(softwareTeam.id, "dev.stopped", { runtime: "terminal", podId: pod.id });
    const session = sessionRegistry.registerSession(stopped.id, "former-alias@seat-software-team");
    sessionRegistry.updateStatus(session.id, "exited");

    expect(service.getStatus("dev-impl@seat-software-team")).toMatchObject({
      ok: true,
      status: { logical_id: "dev.impl", current_occupant: null, occupant_lifecycle: "unknown" },
    });
    expect(service.getStatus("dev-member.dot@seat-software-team")).toMatchObject({
      ok: true, status: { logical_id: "dev.member.dot" },
    });
    expect(service.getStatus("dev-stopped@seat-software-team")).toMatchObject({
      ok: true, status: { logical_id: "dev.stopped", session_status: "exited" },
    });
    expect(service.getStatus("dev.impl@seat-software-team")).toMatchObject({ ok: true });
    expect(service.getStatus("dev-missing@seat-software-team")).toMatchObject({ ok: false, code: "seat_not_found" });

    const duplicate = softwareTeamRepo.createSoftwareTeam("seat-software-team");
    softwareTeamRepo.addNode(duplicate.id, "dev.impl", { runtime: "terminal" });
    expect(service.getStatus("dev-impl@seat-software-team")).toMatchObject({ ok: false, code: "seat_ambiguous" });
    db.prepare("UPDATE software_teams SET archived_at = ? WHERE id = ?").run(new Date().toISOString(), duplicate.id);
    expect(service.getStatus("dev-impl@seat-software-team")).toMatchObject({ ok: true });
  });

  it("the status route resolves an adopted seat by canonical, logical and raw session references", async () => {
    const setup = createTestApp(db);
    const softwareTeam = setup.softwareTeamRepo.createSoftwareTeam("seat-software-team");
    const pod = new PodRepository(db).createPod(softwareTeam.id, "dev", "Development");
    const node = setup.softwareTeamRepo.addNode(softwareTeam.id, "dev.impl", { runtime: "terminal", podId: pod.id });
    setup.sessionRegistry.registerClaimedSession(node.id, "adopted-private-name");

    for (const ref of ["dev-impl@seat-software-team", "dev.impl@seat-software-team", "adopted-private-name"]) {
      const response = await setup.app.request(`/api/seat/status/${encodeURIComponent(ref)}`);
      expect(response.status, ref).toBe(200);
      expect(await response.json()).toMatchObject({
        logical_id: "dev.impl", current_occupant: "adopted-private-name", session_status: "running",
      });
    }
  });

  it("returns not found for an unknown seat reference", () => {
    const result = service.getStatus("missing@seat-software-team");

    expect(result).toMatchObject({
      ok: false,
      code: "seat_not_found",
      guidance: "List seats with: SoftwareTeam ps --nodes",
    });
  });

  it("wires the daemon /api/seat/status route", async () => {
    const setup = createTestApp(db);
    const softwareTeam = setup.softwareTeamRepo.createSoftwareTeam("seat-software-team");
    const node = setup.softwareTeamRepo.addNode(softwareTeam.id, "dev.impl", { runtime: "codex" });
    const session = setup.sessionRegistry.registerSession(node.id, "dev-impl@seat-software-team");
    setup.sessionRegistry.updateStatus(session.id, "running");

    const res = await setup.app.request("/api/seat/status/dev-impl%40seat-software-team");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      seat_ref: "dev-impl@seat-software-team",
      software_team_name: "seat-software-team",
      logical_id: "dev.impl",
      occupant_lifecycle: "active",
      handover_result: null,
    });
  });
});
