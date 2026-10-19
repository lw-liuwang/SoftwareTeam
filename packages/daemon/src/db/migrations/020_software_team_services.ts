import type { Migration } from "../migrate.js";

export const softwareTeamServicesSchema: Migration = {
  name: "020_software_team_services.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS software_team_services (
      software_team_id TEXT PRIMARY KEY REFERENCES software_teams(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      spec_json TEXT NOT NULL,
      software_team_root TEXT NOT NULL,
      compose_file TEXT NOT NULL,
      project_name TEXT NOT NULL,
      latest_receipt_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `,
};
