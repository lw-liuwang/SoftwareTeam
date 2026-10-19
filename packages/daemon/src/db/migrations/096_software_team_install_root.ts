import type { Migration } from "../migrate.js";

export const softwareTeamInstallRootSchema: Migration = {
  name: "096_software_team_install_root.sql",
  sql: "ALTER TABLE software_teams ADD COLUMN install_root TEXT;",
};
