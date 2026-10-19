import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { activityRoutes } from "../src/routes/activity.js";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";

// WAVE O FIX R1 — B2 (R2 verdict 508e383d): `softwareTeam parked` claimed SoftwareTeam scope while folding
// EVERY running softwareTeam in the daemon. R2's effect discriminator, preserved: one idle seat in
// software-team-a, one idle seat in software-team-b, an obligation only in software-team-b — the caller from software-team-a must
// see ONLY software-team-a and NOT-PARKED. Real sqlite, real route, real oracle; only the queue's
// obligation face is faked (per-destination).

const DDL = `
CREATE TABLE software_teams (id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE nodes (id TEXT PRIMARY KEY, software_team_id TEXT NOT NULL);
CREATE TABLE sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, node_id TEXT NOT NULL, session_name TEXT, status TEXT);
`;

describe("Wave-O B2 — parked diagnosis is SOFTWARE_TEAM-SCOPED with the scope named", () => {
  let db: Database.Database;
  let svc: SeatActivityService;
  let app: Hono;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(DDL);
    db.prepare("INSERT INTO software_teams (id, name) VALUES (?, ?)").run("software-team-a-id", "software-team-a");
    db.prepare("INSERT INTO software_teams (id, name) VALUES (?, ?)").run("software-team-b-id", "software-team-b");
    db.prepare("INSERT INTO nodes (id, software_team_id) VALUES (?, ?)").run("node-a", "software-team-a-id");
    db.prepare("INSERT INTO nodes (id, software_team_id) VALUES (?, ?)").run("node-b", "software-team-b-id");
    db.prepare("INSERT INTO sessions (node_id, session_name, status) VALUES (?, ?, ?)").run("node-a", "dev-a@software-team-a", "running");
    db.prepare("INSERT INTO sessions (node_id, session_name, status) VALUES (?, ?, ?)").run("node-b", "dev-b@software-team-b", "running");

    const clock = { now: 9_000_000 };
    svc = new SeatActivityService({
      tmux: { readPaneLastActivity: async () => null },
      defaultWindowSeconds: 3,
      now: () => new Date(clock.now),
    });
    for (const [node, session] of [["node-a", "dev-a@software-team-a"], ["node-b", "dev-b@software-team-b"]] as const) {
      svc.declareRungInventory({ seatNodeId: node, sessionName: session }, {
        adapterId: "tmux-generic", runtime: "tmux-generic",
        rungs: [{ rung: "window-sampling", lifecycleCoverage: "full", initialTrust: "authoritative" }],
      });
      svc.reportEvidence({
        seatNodeId: node, sessionName: session, rung: "window-sampling",
        sourceId: "tmux:window-activity", seq: 1, observedAt: new Date(clock.now).toISOString(),
        activity: "idle-at-prompt",
      });
    }

    // The obligation face: ONLY dev-b@software-team-b owes work.
    const queueRepo = {
      list: (opts: { destinationSession?: string }) =>
        opts.destinationSession === "dev-b@software-team-b"
          ? [{ qitemId: "qitem-b-1", state: "pending", summary: "owed in software-team-b" }]
          : [],
    };

    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("seatActivityService" as never, svc as never);
      c.set("queueRepo" as never, queueRepo as never);
      c.set("softwareTeamRepo" as never, { db } as never);
      await next();
    });
    app.route("/api/activity", activityRoutes);
  });
  afterEach(() => db.close());

  it("R2 DISCRIMINATOR: a caller from software-team-a sees ONLY software-team-a seats and NOT-PARKED — software-team-b's obligation cannot leak in", async () => {
    const res = await app.request("/api/activity/parked", {
      headers: { "x-softwareteam-session": "dev-a@software-team-a" },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; softwareTeam: { parked: boolean | string; scope?: { softwareTeam: string; resolvedFrom: string }; seats: Array<{ sessionName: string }> } };
    const names = body.softwareTeam.seats.map((s) => s.sessionName);
    expect(names).toEqual(["dev-a@software-team-a"]); // candidate returned BOTH softwareTeams
    expect(body.softwareTeam.parked).toBe(false);    // candidate said PARKED off software-team-b's obligation
    expect(body.softwareTeam.scope).toEqual({ softwareTeam: "software-team-a", resolvedFrom: "caller-session" }); // AM-3: the scope is NAMED
  });

  it("an explicit ?softwareTeam= coordinate scopes to that softwareTeam — software-team-b IS parked on its own obligation", async () => {
    const res = await app.request("/api/activity/parked?softwareTeam=software-team-b");
    const body = await res.json() as { softwareTeam: { parked: boolean; scope?: { softwareTeam: string; resolvedFrom: string }; seats: Array<{ sessionName: string; parked: boolean | string }> } };
    expect(body.softwareTeam.seats.map((s) => s.sessionName)).toEqual(["dev-b@software-team-b"]);
    expect(body.softwareTeam.parked).toBe(true);
    expect(body.softwareTeam.scope).toEqual({ softwareTeam: "software-team-b", resolvedFrom: "query-param" });
  });

  it("NO resolvable SoftwareTeam scope refuses with teaching — never a silent fleet-wide fold", async () => {
    const res = await app.request("/api/activity/parked");
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/softwareTeam/i);      // names the missing coordinate
    expect(body.error).toMatch(/\?softwareTeam=|--software-team|session/i); // and how to pass it
  });

  it("explicit-seat semantics preserved: ?seat= carrying its @software-team coordinate self-scopes", async () => {
    const res = await app.request("/api/activity/parked?seat=dev-b%40software-team-b");
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; seat: { sessionName: string; parked: boolean | string } };
    expect(body.seat.sessionName).toBe("dev-b@software-team-b");
    expect(body.seat.parked).toBe(true);
  });

  it("an unknown SoftwareTeam coordinate teaches with the known softwareTeams", async () => {
    const res = await app.request("/api/activity/parked?softwareTeam=ghost-software-team");
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("software-team-a");
    expect(body.error).toContain("software-team-b");
  });
});
