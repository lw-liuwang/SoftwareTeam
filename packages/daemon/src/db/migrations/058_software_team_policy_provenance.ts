import type { Migration } from "../migrate.js";

/**
 * OPR.0.4.8.3 Seam B (Guard NOT-CLEAR at 9e94c274, finding 1): additive restart-stable
 * provenance for the SOFTWARE_TEAM-level resolved permission-policy attachment. The raw softwareTeam ref
 * (migration 056) alone is not restart-complete for a RELATIVE custom policy: organic
 * claim/self-attach seats have no node provenance, structured add-member runs under a
 * DIFFERENT operation root, and restore/successor must never resolve a persisted relative
 * ref against an unrelated cwd. Columns mirror the node-level 057 set:
 *   software_team_policy_origin / software_team_policy_resolved_target / software_team_policy_declaring_dir /
 *   software_team_policy_launch_posture
 * declaring_dir = the ORIGINAL declaring SoftwareTeamSpec directory (the materialize softwareTeamRoot).
 * Additive only; NULLs = no software-team-level policy attached.
 */
export const softwareTeamPolicyProvenanceSchema: Migration = {
  name: "058_software_team_policy_provenance.sql",
  sql: `
    ALTER TABLE software_teams ADD COLUMN software_team_policy_origin TEXT;
    ALTER TABLE software_teams ADD COLUMN software_team_policy_resolved_target TEXT;
    ALTER TABLE software_teams ADD COLUMN software_team_policy_declaring_dir TEXT;
    ALTER TABLE software_teams ADD COLUMN software_team_policy_launch_posture TEXT;
  `,
};
