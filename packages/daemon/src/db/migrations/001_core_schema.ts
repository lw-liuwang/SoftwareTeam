import type { Migration } from "../migrate.js";

export const coreSchema: Migration = {
  name: "001_core_schema.sql",
  sql: `
    -- softwareTeams: top-level topology container
    CREATE TABLE software_teams (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- nodes: logical identity within a softwareTeam
    -- id = opaque DB primary key (ulid). All FKs reference this.
    -- logical_id = logical name from SoftwareTeam spec (e.g. "orchestrator"). Human-facing.
    CREATE TABLE nodes (
      id          TEXT PRIMARY KEY,
      software_team_id      TEXT NOT NULL REFERENCES software_teams(id) ON DELETE CASCADE,
      logical_id  TEXT NOT NULL,
      role        TEXT,
      runtime     TEXT,
      model       TEXT,
      cwd         TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(software_team_id, logical_id)
    );

    -- edges: relationships between nodes
    CREATE TABLE edges (
      id          TEXT PRIMARY KEY,
      software_team_id      TEXT NOT NULL REFERENCES software_teams(id) ON DELETE CASCADE,
      source_id   TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      target_id   TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      kind        TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Edge integrity: source and target must belong to the same softwareTeam.
    -- SQLite CHECK cannot cross-reference tables, so we use a trigger.
    CREATE TRIGGER edge_same_software_team_insert
    BEFORE INSERT ON edges
    BEGIN
      SELECT RAISE(ABORT, 'edge source and target must belong to the same softwareTeam')
      WHERE (SELECT software_team_id FROM nodes WHERE id = NEW.source_id)
         != (SELECT software_team_id FROM nodes WHERE id = NEW.target_id);
      SELECT RAISE(ABORT, 'edge software_team_id must match source node software_team_id')
      WHERE NEW.software_team_id != (SELECT software_team_id FROM nodes WHERE id = NEW.source_id);
    END;
  `,
};
