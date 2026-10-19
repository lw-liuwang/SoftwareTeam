import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";

describe("001_core_schema", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema]);
  });

  afterEach(() => {
    db.close();
  });

  it("creates softwareTeams, nodes, and edges tables", () => {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      )
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("software_teams");
    expect(names).toContain("nodes");
    expect(names).toContain("edges");
  });

  it("can insert a softwareTeam", () => {
    db.prepare("INSERT INTO software_teams (id, name) VALUES (?, ?)").run(
      "software-team-1",
      "test-software-team"
    );
    const softwareTeam = db.prepare("SELECT * FROM software_teams WHERE id = ?").get("software-team-1") as {
      id: string;
      name: string;
    };
    expect(softwareTeam.name).toBe("test-software-team");
  });

  it("can insert nodes referencing a softwareTeam", () => {
    db.prepare("INSERT INTO software_teams (id, name) VALUES (?, ?)").run(
      "software-team-1",
      "test-software-team"
    );
    db.prepare(
      "INSERT INTO nodes (id, software_team_id, logical_id, role, runtime) VALUES (?, ?, ?, ?, ?)"
    ).run("node-1", "software-team-1", "orchestrator", "orchestrator", "claude-code");

    const node = db
      .prepare("SELECT * FROM nodes WHERE id = ?")
      .get("node-1") as { logical_id: string; role: string };
    expect(node.logical_id).toBe("orchestrator");
    expect(node.role).toBe("orchestrator");
  });

  it("enforces FK: node must reference valid softwareTeam", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO nodes (id, software_team_id, logical_id) VALUES (?, ?, ?)"
        )
        .run("node-1", "nonexistent-software-team", "worker")
    ).toThrow();
  });

  it("enforces unique (software_team_id, logical_id)", () => {
    db.prepare("INSERT INTO software_teams (id, name) VALUES (?, ?)").run(
      "software-team-1",
      "test-software-team"
    );
    db.prepare(
      "INSERT INTO nodes (id, software_team_id, logical_id) VALUES (?, ?, ?)"
    ).run("node-1", "software-team-1", "worker");

    expect(() =>
      db
        .prepare(
          "INSERT INTO nodes (id, software_team_id, logical_id) VALUES (?, ?, ?)"
        )
        .run("node-2", "software-team-1", "worker")
    ).toThrow();
  });

  it("can insert edges referencing valid nodes", () => {
    db.prepare("INSERT INTO software_teams (id, name) VALUES (?, ?)").run(
      "software-team-1",
      "test-software-team"
    );
    db.prepare(
      "INSERT INTO nodes (id, software_team_id, logical_id) VALUES (?, ?, ?)"
    ).run("node-1", "software-team-1", "orchestrator");
    db.prepare(
      "INSERT INTO nodes (id, software_team_id, logical_id) VALUES (?, ?, ?)"
    ).run("node-2", "software-team-1", "worker");

    db.prepare(
      "INSERT INTO edges (id, software_team_id, source_id, target_id, kind) VALUES (?, ?, ?, ?, ?)"
    ).run("edge-1", "software-team-1", "node-1", "node-2", "delegates_to");

    const edge = db
      .prepare("SELECT * FROM edges WHERE id = ?")
      .get("edge-1") as { kind: string };
    expect(edge.kind).toBe("delegates_to");
  });

  it("enforces FK: edge must reference valid nodes", () => {
    db.prepare("INSERT INTO software_teams (id, name) VALUES (?, ?)").run(
      "software-team-1",
      "test-software-team"
    );
    db.prepare(
      "INSERT INTO nodes (id, software_team_id, logical_id) VALUES (?, ?, ?)"
    ).run("node-1", "software-team-1", "orchestrator");

    expect(() =>
      db
        .prepare(
          "INSERT INTO edges (id, software_team_id, source_id, target_id, kind) VALUES (?, ?, ?, ?, ?)"
        )
        .run("edge-1", "software-team-1", "node-1", "nonexistent", "delegates_to")
    ).toThrow();
  });

  it("rejects edges where source and target belong to different softwareTeams", () => {
    db.prepare("INSERT INTO software_teams (id, name) VALUES (?, ?)").run(
      "software-team-1",
      "software-team-one"
    );
    db.prepare("INSERT INTO software_teams (id, name) VALUES (?, ?)").run(
      "software-team-2",
      "software-team-two"
    );
    db.prepare(
      "INSERT INTO nodes (id, software_team_id, logical_id) VALUES (?, ?, ?)"
    ).run("node-1", "software-team-1", "worker-a");
    db.prepare(
      "INSERT INTO nodes (id, software_team_id, logical_id) VALUES (?, ?, ?)"
    ).run("node-2", "software-team-2", "worker-b");

    expect(() =>
      db
        .prepare(
          "INSERT INTO edges (id, software_team_id, source_id, target_id, kind) VALUES (?, ?, ?, ?, ?)"
        )
        .run("edge-1", "software-team-1", "node-1", "node-2", "delegates_to")
    ).toThrow(/same softwareTeam/);
  });

  it("rejects edges where software_team_id does not match source node software_team_id", () => {
    db.prepare("INSERT INTO software_teams (id, name) VALUES (?, ?)").run(
      "software-team-1",
      "software-team-one"
    );
    db.prepare("INSERT INTO software_teams (id, name) VALUES (?, ?)").run(
      "software-team-2",
      "software-team-two"
    );
    db.prepare(
      "INSERT INTO nodes (id, software_team_id, logical_id) VALUES (?, ?, ?)"
    ).run("node-1", "software-team-1", "worker-a");
    db.prepare(
      "INSERT INTO nodes (id, software_team_id, logical_id) VALUES (?, ?, ?)"
    ).run("node-2", "software-team-1", "worker-b");

    // Nodes are in software-team-1 but edge claims software-team-2
    expect(() =>
      db
        .prepare(
          "INSERT INTO edges (id, software_team_id, source_id, target_id, kind) VALUES (?, ?, ?, ?, ?)"
        )
        .run("edge-1", "software-team-2", "node-1", "node-2", "delegates_to")
    ).toThrow(/software_team_id must match/);
  });

  it("cascade deletes: deleting a SoftwareTeam removes its nodes and edges", () => {
    db.prepare("INSERT INTO software_teams (id, name) VALUES (?, ?)").run(
      "software-team-1",
      "test-software-team"
    );
    db.prepare(
      "INSERT INTO nodes (id, software_team_id, logical_id) VALUES (?, ?, ?)"
    ).run("node-1", "software-team-1", "orchestrator");
    db.prepare(
      "INSERT INTO nodes (id, software_team_id, logical_id) VALUES (?, ?, ?)"
    ).run("node-2", "software-team-1", "worker");
    db.prepare(
      "INSERT INTO edges (id, software_team_id, source_id, target_id, kind) VALUES (?, ?, ?, ?, ?)"
    ).run("edge-1", "software-team-1", "node-1", "node-2", "delegates_to");

    db.prepare("DELETE FROM software_teams WHERE id = ?").run("software-team-1");

    const nodes = db.prepare("SELECT * FROM nodes").all();
    const edges = db.prepare("SELECT * FROM edges").all();
    expect(nodes).toHaveLength(0);
    expect(edges).toHaveLength(0);
  });
});
