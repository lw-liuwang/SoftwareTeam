import type { Migration } from "../migrate.js";

export const softwareTeamNonInterruptiveSchema: Migration = {
  name: "095_software_team_non_interruptive.sql",
  sql: "ALTER TABLE software_teams ADD COLUMN non_interruptive INTEGER NOT NULL DEFAULT 0 CHECK (non_interruptive IN (0, 1));",
};
