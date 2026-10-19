import type { Migration } from "../migrate.js";

/**
 * PL-007 Workspace Primitive v0 — softwareTeams.workspace_json column.
 *
 * Adds `workspace_json TEXT` to the softwareTeams table. Holds the typed
 * SoftwareTeamSpec.workspace block as JSON when a softwareTeam declares one. Populated by
 * SoftwareTeamRepository.setSoftwareTeamWorkspace at instantiate time. Whoami /
 * node-inventory read this column to surface workspace fields alongside
 * cwd. NULL for softwareTeams without a workspace block.
 *
 * The companion queue_items.target_repo column ships in migration 039
 * so test fixtures that exercise softwareTeams without queue_items (and vice
 * versa) can apply only the half they need.
 */
export const workspacePrimitiveSchema: Migration = {
  name: "038_workspace_primitive.sql",
  sql: `
    ALTER TABLE software_teams ADD COLUMN workspace_json TEXT;
  `,
};
