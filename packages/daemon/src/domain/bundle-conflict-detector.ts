/**
 * Bundle conflict detector (Item 3 / slice-05 Checkpoint 4.1).
 *
 * Pure function. Compares a bundle's declared identifiers against the daemon's
 * current state and returns a structured conflict report. Callers (route
 * handlers in Checkpoint 4.2) provide the daemon state (listSoftwareTeams() etc.); the
 * detector itself has no daemon dependencies — fully unit-testable.
 *
 * Fails CLOSED: the conflict list is the source of truth. Missing or ambiguous
 * input is treated as no-conflict-detectable, NOT as bypass — Items 4.2+ will
 * surface ambiguity as a conflict where appropriate. This commit ships the
 * software-team-name collision check only; agent / port / managed-app / sibling-primitive
 * checks land in Checkpoint 4.3 + 4.4.
 *
 * Extends, does NOT replace, the existing 409 "install already in progress"
 * guard at /api/bundles/install (concurrency lock) per PRD Item 3 §
 * "extends, does NOT replace".
 */

/** A software-team-name collision: bundle declares a softwareTeam name that a currently-running softwareTeam already uses. */
export interface SoftwareTeamNameCollision {
  kind: "software_team_name_collision";
  /** Name declared by the bundle's softwareTeam spec. */
  bundleSoftwareTeamName: string;
  /** Identity of the running softwareTeam that holds the same name. */
  collisionWith: { softwareTeamId: string; softwareTeamName: string };
  /** Human-readable summary suitable for the 3-part error description line. */
  description: string;
  /** Operator-actionable resolutions (3-part error what-to-do line). */
  resolutions: string[];
}

/** Discriminated union over all conflict kinds. Extends in Checkpoint 4.3+. */
export type BundleConflict = SoftwareTeamNameCollision;

/** Result of a conflict check. */
export interface ConflictReport {
  conflicts: BundleConflict[];
  hasConflicts: boolean;
}

/** Input to detectBundleConflicts. Pure data; no daemon handles. */
export interface DetectConflictsInput {
  /** SoftwareTeam name declared in the bundle's softwareTeam spec (software-team.yaml `name:` field). */
  bundleSoftwareTeamName: string;
  /** Snapshot of currently-running softwareTeams from softwareTeamRepo.listSoftwareTeams(). */
  runningSoftwareTeams: Array<{ softwareTeamId: string; name: string }>;
}

/**
 * Run the conflict checks for an install candidate. Returns the full conflict
 * list (Checkpoint 4.2 returns it via /install --plan; --apply blocks on
 * non-empty unless --force).
 */
export function detectBundleConflicts(input: DetectConflictsInput): ConflictReport {
  const conflicts: BundleConflict[] = [];

  // SoftwareTeam-name collision: bundle declares a name a running softwareTeam already holds.
  // O(n) scan over runningSoftwareTeams — acceptable for the seat-scale softwareTeam counts the
  // daemon manages (tens, not thousands).
  if (input.bundleSoftwareTeamName && input.bundleSoftwareTeamName.length > 0) {
    for (const softwareTeam of input.runningSoftwareTeams) {
      if (softwareTeam.name === input.bundleSoftwareTeamName) {
        conflicts.push({
          kind: "software_team_name_collision",
          bundleSoftwareTeamName: input.bundleSoftwareTeamName,
          collisionWith: { softwareTeamId: softwareTeam.softwareTeamId, softwareTeamName: softwareTeam.name },
          description: `bundle declares SoftwareTeam name '${input.bundleSoftwareTeamName}' but a running SoftwareTeam with this name already exists (softwareTeamId: ${softwareTeam.softwareTeamId})`,
          resolutions: [
            `use the existing team (SoftwareTeam ps --software-team '${softwareTeam.name}' --nodes)`,
            `stop the running SoftwareTeam first (SoftwareTeam down '${softwareTeam.name}') and retry this install to replace the stopped team; the earlier generation is archived`,
            "cancel the install and keep the existing team; --target chooses a directory, not a new SoftwareTeam name",
          ],
        });
        break;
      }
    }
  }

  return { conflicts, hasConflicts: conflicts.length > 0 };
}
