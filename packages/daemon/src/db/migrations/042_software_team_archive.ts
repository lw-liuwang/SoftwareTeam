import type { Migration } from "../migrate.js";

/**
 * OPR.0.3.3.19 - softwareTeam archive affordance.
 *
 * Adds a soft, reversible archive flag to the local `softwareTeams` row. `archived_at`
 * is NULL for an active softwareTeam and an ISO timestamp once archived. This is a
 * visibility/retention flag, NOT a lifecycle state - lifecycle stays a derived
 * runtime/recovery projection. Default daemon reads exclude archived softwareTeams;
 * explicit include/archived-only modes opt in. Mirrors the shipped stream-items
 * `archived_at` precedent (023_stream_items).
 *
 * Append-only: ADD COLUMN + index only. No software-teams-row restructure/rebuild/drop;
 * existing softwareTeam rows are untouched (STEERING: DB migrations don't destroy data).
 */
export const softwareTeamArchiveSchema: Migration = {
  name: "042_software_team_archive.sql",
  sql: `
    ALTER TABLE software_teams ADD COLUMN archived_at TEXT;
    CREATE INDEX IF NOT EXISTS idx_software_teams_archived ON software_teams(archived_at);
  `,
};
