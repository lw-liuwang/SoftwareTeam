import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Hono } from "hono";
import type Database from "better-sqlite3";
import type { SoftwareTeamRepository } from "../src/domain/software-team-repository.js";
import type { SessionRegistry } from "../src/domain/session-registry.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

function countSessions(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) as c FROM sessions").get() as { c: number }).c;
}

describe("OPR.0.4.3.22 — software-team-status + launch-plan routes", () => {
  let db: Database.Database;
  let app: Hono;
  let repo: SoftwareTeamRepository;
  let sessionRegistry: SessionRegistry;

  beforeEach(() => {
    db = createFullTestDb();
    const setup = createTestApp(db);
    app = setup.app;
    repo = setup.softwareTeamRepo;
    sessionRegistry = setup.sessionRegistry;
  });

  afterEach(() => {
    db.close();
  });

  it("GET /api/software-teams/:id/status → 404 for an unknown softwareTeam", async () => {
    const res = await app.request("/api/software-teams/nope/status");
    expect(res.status).toBe(404);
  });

  it("GET /api/software-teams/:id/status → composed status object with a src provenance array", async () => {
    const softwareTeam = repo.createSoftwareTeam("r-status");
    repo.addNode(softwareTeam.id, "dev", { role: "dev" });

    const res = await app.request(`/api/software-teams/${softwareTeam.id}/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.softwareTeamId).toBe(softwareTeam.id);
    expect(body.softwareTeamName).toBe("r-status");
    expect(["up", "partial", "down", "blocked", "unknown"]).toContain(body.status);
    // Composed, not inferred — the source signals are visible in the response.
    expect(Array.isArray(body.src)).toBe(true);
    expect(body.src.some((s: string) => s.startsWith("ps:"))).toBe(true);
    expect(Array.isArray(body.perSeat)).toBe(true);
    // A never-launched softwareTeam has no running seats → not up.
    expect(body.status).not.toBe("up");
  });

  it("POST /api/software-teams/:id/launch-plan is READ-ONLY: returns mutated:false and creates ZERO sessions", async () => {
    const softwareTeam = repo.createSoftwareTeam("r-plan");
    repo.addNode(softwareTeam.id, "dev", { role: "dev" });

    const before = countSessions(db);
    const res = await app.request(`/api/software-teams/${softwareTeam.id}/launch-plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("plan");
    expect(body.mutated).toBe(false);
    expect(Array.isArray(body.nodes)).toBe(true);
    // The read-only contract: no session was created / killed / replaced.
    expect(countSessions(db)).toBe(before);
  });

  it("POST /api/software-teams/:id/launch-plan → 404 for an unknown softwareTeam", async () => {
    const res = await app.request("/api/software-teams/nope/launch-plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  it("POST /api/software-teams/:id/launch-plan with freshLogicalIds forecasts fresh-primed for that seat (no mutation)", async () => {
    const softwareTeam = repo.createSoftwareTeam("r-fresh");
    const node = repo.addNode(softwareTeam.id, "dev", { role: "dev" });
    const session = sessionRegistry.registerSession(node.id, "dev@r-fresh");
    sessionRegistry.updateStatus(session.id, "running");

    const before = countSessions(db);
    const res = await app.request(`/api/software-teams/${softwareTeam.id}/launch-plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ freshLogicalIds: ["dev"] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mutated).toBe(false);
    const dev = body.nodes.find((n: { logicalId: string }) => n.logicalId === "dev");
    expect(dev.intendedAction).toBe("fresh-primed");
    expect(countSessions(db)).toBe(before);
  });
});
