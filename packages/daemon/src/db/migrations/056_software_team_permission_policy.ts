import type { Migration } from "../migrate.js";

/**
 * OPR.0.4.8.3 Seam B — softwareTeams.permission_policy column.
 *
 * Adds `permission_policy TEXT` to the softwareTeams table. Holds the software-team-level
 * permission_policy REF (`builtin:<name>` or a spec-relative custom path)
 * when a softwareTeam declares one, populated by SoftwareTeamRepository.setSoftwareTeamPermissionPolicy
 * at instantiate time and read back via getSoftwareTeamPermissionPolicy (exporter /
 * discovery). NULL for softwareTeams without an attached policy (= the floor).
 * Mirrors migration 038 (softwareTeams.workspace_json).
 */
export const softwareTeamPermissionPolicySchema: Migration = {
  name: "056_software_team_permission_policy.sql",
  sql: `
    ALTER TABLE software_teams ADD COLUMN permission_policy TEXT;
  `,
};
