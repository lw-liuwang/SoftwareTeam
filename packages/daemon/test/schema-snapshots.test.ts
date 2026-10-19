import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { snapshotsSchema } from "../src/db/migrations/004_snapshots.js";

describe("004_snapshots", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, snapshotsSchema]);
    // Seed a softwareTeam for tests that need one
    db.prepare("INSERT INTO software_teams (id, name) VALUES (?, ?)").run("software-team-1", "test-software-team");
  });

  afterEach(() => {
    db.close();
  });

  it("creates snapshots table", () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='snapshots'")
      .all();
    expect(tables).toHaveLength(1);
  });

  it("can insert snapshot with JSON blob + metadata columns", () => {
    const data = JSON.stringify({ softwareTeam: {}, nodes: [], edges: [], sessions: [], checkpoints: {} });
    db.prepare(
      "INSERT INTO snapshots (id, software_team_id, kind, status, data) VALUES (?, ?, ?, ?, ?)"
    ).run("snap-1", "software-team-1", "manual", "complete", data);

    const snap = db.prepare("SELECT * FROM snapshots WHERE id = ?").get("snap-1") as {
      id: string; software_team_id: string; kind: string; status: string; data: string; created_at: string;
    };
    expect(snap.software_team_id).toBe("software-team-1");
    expect(snap.kind).toBe("manual");
    expect(snap.status).toBe("complete");
    expect(JSON.parse(snap.data)).toHaveProperty("softwareTeam");
    expect(snap.created_at).toBeDefined();
  });

  it("insert without status defaults to 'complete'", () => {
    const data = JSON.stringify({ softwareTeam: {} });
    db.prepare(
      "INSERT INTO snapshots (id, software_team_id, kind, data) VALUES (?, ?, ?, ?)"
    ).run("snap-1", "software-team-1", "manual", data);

    const snap = db.prepare("SELECT status FROM snapshots WHERE id = ?").get("snap-1") as {
      status: string;
    };
    expect(snap.status).toBe("complete");
  });

  it("query by software_team_id returns matching snapshots", () => {
    const data = "{}";
    db.prepare("INSERT INTO software_teams (id, name) VALUES (?, ?)").run("software-team-2", "other-software-team");
    db.prepare("INSERT INTO snapshots (id, software_team_id, kind, data) VALUES (?, ?, ?, ?)").run("snap-1", "software-team-1", "manual", data);
    db.prepare("INSERT INTO snapshots (id, software_team_id, kind, data) VALUES (?, ?, ?, ?)").run("snap-2", "software-team-2", "manual", data);
    db.prepare("INSERT INTO snapshots (id, software_team_id, kind, data) VALUES (?, ?, ?, ?)").run("snap-3", "software-team-1", "pre_restore", data);

    const rig1Snaps = db
      .prepare("SELECT id FROM snapshots WHERE software_team_id = ?")
      .all("software-team-1") as { id: string }[];
    expect(rig1Snaps).toHaveLength(2);
    expect(rig1Snaps.map((s) => s.id).sort()).toEqual(["snap-1", "snap-3"]);
  });

  it("query by kind filters correctly", () => {
    const data = "{}";
    db.prepare("INSERT INTO snapshots (id, software_team_id, kind, data) VALUES (?, ?, ?, ?)").run("snap-1", "software-team-1", "manual", data);
    db.prepare("INSERT INTO snapshots (id, software_team_id, kind, data) VALUES (?, ?, ?, ?)").run("snap-2", "software-team-1", "pre_restore", data);
    db.prepare("INSERT INTO snapshots (id, software_team_id, kind, data) VALUES (?, ?, ?, ?)").run("snap-3", "software-team-1", "manual", data);

    const manualSnaps = db
      .prepare("SELECT id FROM snapshots WHERE software_team_id = ? AND kind = ?")
      .all("software-team-1", "manual") as { id: string }[];
    expect(manualSnaps).toHaveLength(2);

    const preRestoreSnaps = db
      .prepare("SELECT id FROM snapshots WHERE software_team_id = ? AND kind = ?")
      .all("software-team-1", "pre_restore") as { id: string }[];
    expect(preRestoreSnaps).toHaveLength(1);
    expect(preRestoreSnaps[0]!.id).toBe("snap-2");
  });

  it("query ordered by created_at (most recent last)", () => {
    const data = "{}";
    // Insert with explicit timestamps to control order
    db.prepare("INSERT INTO snapshots (id, software_team_id, kind, data, created_at) VALUES (?, ?, ?, ?, ?)").run("snap-old", "software-team-1", "manual", data, "2026-03-23 01:00:00");
    db.prepare("INSERT INTO snapshots (id, software_team_id, kind, data, created_at) VALUES (?, ?, ?, ?, ?)").run("snap-new", "software-team-1", "manual", data, "2026-03-23 02:00:00");
    db.prepare("INSERT INTO snapshots (id, software_team_id, kind, data, created_at) VALUES (?, ?, ?, ?, ?)").run("snap-mid", "software-team-1", "manual", data, "2026-03-23 01:30:00");

    const snaps = db
      .prepare("SELECT id FROM snapshots WHERE software_team_id = ? ORDER BY created_at")
      .all("software-team-1") as { id: string }[];
    expect(snaps.map((s) => s.id)).toEqual(["snap-old", "snap-mid", "snap-new"]);
  });

  it("SoftwareTeam delete does NOT delete snapshots (plain TEXT, not FK)", () => {
    const data = "{}";
    db.prepare("INSERT INTO snapshots (id, software_team_id, kind, data) VALUES (?, ?, ?, ?)").run("snap-1", "software-team-1", "manual", data);

    db.prepare("DELETE FROM software_teams WHERE id = ?").run("software-team-1");

    const snaps = db.prepare("SELECT * FROM snapshots WHERE id = ?").get("snap-1");
    expect(snaps).toBeDefined();
  });

  it("snapshot with nonexistent software_team_id allowed (orphan refs)", () => {
    const data = "{}";
    expect(() =>
      db.prepare("INSERT INTO snapshots (id, software_team_id, kind, data) VALUES (?, ?, ?, ?)").run("snap-1", "nonexistent-software-team", "manual", data)
    ).not.toThrow();

    const snap = db.prepare("SELECT software_team_id FROM snapshots WHERE id = ?").get("snap-1") as { software_team_id: string };
    expect(snap.software_team_id).toBe("nonexistent-software-team");
  });
});
