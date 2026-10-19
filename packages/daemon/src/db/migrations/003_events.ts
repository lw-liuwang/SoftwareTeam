import type { Migration } from "../migrate.js";

export const eventsSchema: Migration = {
  name: "003_events.sql",
  sql: `
    CREATE TABLE events (
      seq         INTEGER PRIMARY KEY AUTOINCREMENT,
      -- INTENTIONALLY NOT AN FK to softwareTeams(id).
      -- Events are an append-only history log. They must survive SoftwareTeam deletion
      -- so the full timeline is preserved for replay and audit.
      software_team_id      TEXT,
      -- INTENTIONALLY NOT AN FK to nodes(id).
      -- Same rationale: events must survive node deletion.
      node_id     TEXT,
      type        TEXT NOT NULL,
      payload     TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Primary query pattern: "all events for softwareTeam X after sequence N" (SSE replay)
    CREATE INDEX idx_events_software_team_seq ON events(software_team_id, seq);
  `,
};
