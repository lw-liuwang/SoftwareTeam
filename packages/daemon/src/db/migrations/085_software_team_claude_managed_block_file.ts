import type { Migration } from "../migrate.js";

/**
 * #25 — softwareTeams.claude_managed_block_file column.
 *
 * Holds the software-team-level `managed_blocks.claude-code` selection (`CLAUDE.md` or
 * `CLAUDE.local.md`), written by SoftwareTeamRepository.setSoftwareTeamClaudeManagedBlockFile at
 * instantiate time. Startup delivery, teardown and export read it back, so
 * launch, restore replay, relaunch and added members write the same file.
 * Handover writes no guidance; the successor reads the existing file.
 * NULL = the CLAUDE.md default. Mirrors migration 056 (softwareTeams.permission_policy).
 */
export const softwareTeamClaudeManagedBlockFileSchema: Migration = {
  name: "085_software_team_claude_managed_block_file.sql",
  sql: `
    ALTER TABLE software_teams ADD COLUMN claude_managed_block_file TEXT;
  `,
};
