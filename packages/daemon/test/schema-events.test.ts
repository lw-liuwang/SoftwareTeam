import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";

describe("003_events", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema]);
    db.prepare("INSERT INTO software_teams (id, name) VALUES (?, ?)").run(
      "software-team-1",
      "test-software-team"
    );
  });

  afterEach(() => {
    db.close();
  });

  it("creates events table", () => {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='events'"
      )
      .all();
    expect(tables).toHaveLength(1);
  });

  it("can insert an event with type and JSON payload", () => {
    db.prepare(
      "INSERT INTO events (software_team_id, type, payload) VALUES (?, ?, ?)"
    ).run("software-team-1", "node.added", JSON.stringify({ logicalId: "worker" }));

    const event = db.prepare("SELECT * FROM events WHERE software_team_id = ?").get(
      "software-team-1"
    ) as { seq: number; type: string; payload: string };
    expect(event.type).toBe("node.added");
    expect(JSON.parse(event.payload)).toEqual({ logicalId: "worker" });
    expect(typeof event.seq).toBe("number");
  });

  it("seq is auto-incrementing and monotonic", () => {
    db.prepare(
      "INSERT INTO events (software_team_id, type, payload) VALUES (?, ?, ?)"
    ).run("software-team-1", "event.a", "{}");
    db.prepare(
      "INSERT INTO events (software_team_id, type, payload) VALUES (?, ?, ?)"
    ).run("software-team-1", "event.b", "{}");
    db.prepare(
      "INSERT INTO events (software_team_id, type, payload) VALUES (?, ?, ?)"
    ).run("software-team-1", "event.c", "{}");

    const events = db
      .prepare("SELECT seq FROM events ORDER BY seq")
      .all() as { seq: number }[];
    expect(events).toHaveLength(3);
    expect(events[0]!.seq).toBeLessThan(events[1]!.seq);
    expect(events[1]!.seq).toBeLessThan(events[2]!.seq);
  });

  it("primary invariant: query WHERE seq > N returns correct replay set", () => {
    for (let i = 0; i < 5; i++) {
      db.prepare(
        "INSERT INTO events (software_team_id, type, payload) VALUES (?, ?, ?)"
      ).run("software-team-1", `event.${i}`, JSON.stringify({ index: i }));
    }

    const allEvents = db
      .prepare("SELECT seq FROM events ORDER BY seq")
      .all() as { seq: number }[];
    const seq2 = allEvents[1]!.seq; // second event

    // Replay after seq2: should get events 3, 4, 5 (indices 2, 3, 4)
    const replay = db
      .prepare(
        "SELECT seq, type, payload FROM events WHERE software_team_id = ? AND seq > ? ORDER BY seq"
      )
      .all("software-team-1", seq2) as { seq: number; type: string; payload: string }[];

    expect(replay).toHaveLength(3);
    expect(JSON.parse(replay[0]!.payload)).toEqual({ index: 2 });
    expect(JSON.parse(replay[1]!.payload)).toEqual({ index: 3 });
    expect(JSON.parse(replay[2]!.payload)).toEqual({ index: 4 });

    // Monotonic order
    expect(replay[0]!.seq).toBeLessThan(replay[1]!.seq);
    expect(replay[1]!.seq).toBeLessThan(replay[2]!.seq);
  });

  it("query by software_team_id filters correctly", () => {
    db.prepare("INSERT INTO software_teams (id, name) VALUES (?, ?)").run(
      "software-team-2",
      "other-software-team"
    );
    db.prepare(
      "INSERT INTO events (software_team_id, type, payload) VALUES (?, ?, ?)"
    ).run("software-team-1", "event.a", "{}");
    db.prepare(
      "INSERT INTO events (software_team_id, type, payload) VALUES (?, ?, ?)"
    ).run("software-team-2", "event.b", "{}");
    db.prepare(
      "INSERT INTO events (software_team_id, type, payload) VALUES (?, ?, ?)"
    ).run("software-team-1", "event.c", "{}");

    const rig1Events = db
      .prepare("SELECT * FROM events WHERE software_team_id = ? ORDER BY seq")
      .all("software-team-1") as { type: string }[];
    expect(rig1Events).toHaveLength(2);
    expect(rig1Events[0]!.type).toBe("event.a");
    expect(rig1Events[1]!.type).toBe("event.c");
  });

  it("node_id is nullable — software-team-level events work", () => {
    db.prepare(
      "INSERT INTO events (software_team_id, type, payload) VALUES (?, ?, ?)"
    ).run("software-team-1", "software-team.created", "{}");

    const event = db.prepare("SELECT node_id FROM events WHERE seq = 1").get() as {
      node_id: string | null;
    };
    expect(event.node_id).toBeNull();
  });

  // -- Explicit contract: events.node_id is intentionally NOT an FK.
  // -- Events are an append-only log. They must survive node deletion.
  // -- See 003_events.ts for the design rationale.

  it("allows event with node_id referencing a nonexistent node (orphan refs intentional)", () => {
    // node_id is plain TEXT, not an FK — orphan refs are allowed by design
    // because the event log records history, not current state
    expect(() =>
      db
        .prepare(
          "INSERT INTO events (software_team_id, node_id, type, payload) VALUES (?, ?, ?, ?)"
        )
        .run("software-team-1", "nonexistent-node", "node.added", "{}")
    ).not.toThrow();

    const event = db
      .prepare("SELECT node_id FROM events WHERE node_id = ?")
      .get("nonexistent-node") as { node_id: string };
    expect(event.node_id).toBe("nonexistent-node");
  });

  it("events survive node deletion (append-only history preserved)", () => {
    // Create a node, emit events for it, delete the node — events must remain
    db.prepare(
      "INSERT INTO nodes (id, software_team_id, logical_id) VALUES (?, ?, ?)"
    ).run("node-1", "software-team-1", "worker");

    db.prepare(
      "INSERT INTO events (software_team_id, node_id, type, payload) VALUES (?, ?, ?, ?)"
    ).run("software-team-1", "node-1", "node.added", '{"logicalId":"worker"}');
    db.prepare(
      "INSERT INTO events (software_team_id, node_id, type, payload) VALUES (?, ?, ?, ?)"
    ).run("software-team-1", "node-1", "session.status_changed", '{"status":"running"}');

    // Delete the node
    db.prepare("DELETE FROM nodes WHERE id = ?").run("node-1");

    // Events must still exist with their original node_id intact
    const events = db
      .prepare("SELECT node_id, type FROM events WHERE node_id = ? ORDER BY seq")
      .all("node-1") as { node_id: string; type: string }[];
    expect(events).toHaveLength(2);
    expect(events[0]!.node_id).toBe("node-1");
    expect(events[0]!.type).toBe("node.added");
    expect(events[1]!.node_id).toBe("node-1");
    expect(events[1]!.type).toBe("session.status_changed");
  });

  it("events survive SoftwareTeam deletion (audit trail preserved)", () => {
    db.prepare(
      "INSERT INTO events (software_team_id, type, payload) VALUES (?, ?, ?)"
    ).run("software-team-1", "event.a", "{}");
    db.prepare(
      "INSERT INTO events (software_team_id, type, payload) VALUES (?, ?, ?)"
    ).run("software-team-1", "event.b", "{}");

    db.prepare("DELETE FROM software_teams WHERE id = ?").run("software-team-1");

    // Events must still exist with original software_team_id intact
    const events = db
      .prepare("SELECT software_team_id, type FROM events ORDER BY seq")
      .all() as { software_team_id: string; type: string }[];
    expect(events).toHaveLength(2);
    expect(events[0]!.software_team_id).toBe("software-team-1");
    expect(events[1]!.software_team_id).toBe("software-team-1");
  });

  it("allows event with software_team_id referencing nonexistent softwareTeam (orphan refs)", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO events (software_team_id, type, payload) VALUES (?, ?, ?)"
        )
        .run("nonexistent-software-team", "software-team.created", "{}")
    ).not.toThrow();

    const event = db
      .prepare("SELECT software_team_id FROM events WHERE software_team_id = ?")
      .get("nonexistent-software-team") as { software_team_id: string };
    expect(event.software_team_id).toBe("nonexistent-software-team");
  });
});
