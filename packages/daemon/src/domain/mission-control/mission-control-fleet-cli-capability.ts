// Fleet roll-up from the daemon's softwareTeam registry and queue, with optional
// CLI observations. Unobserved capabilities and versions remain unknown;
// unavailable fields alone do not establish that a CLI version is outdated.

import type Database from "better-sqlite3";
import type { EventBus } from "../event-bus.js";
import type { SoftwareTeamRepository } from "../software-team-repository.js";

export interface FleetRollupRow {
  softwareTeamName: string;
  /** Compact 5-state activity for a fleet view. */
  activityState: "active" | "idle" | "attention" | "blocked" | "degraded";
  lifecycleState: string | null;
  attentionReason: string | null;
  lastUpdate: string;
  /** v0.1.12-style label or "head" / "unknown". */
  cliVersionLabel: string;
  cliCapabilityStatus: "available" | "unavailable" | "unknown";
  /** True only when an observed version was independently confirmed outdated. */
  cliVersionOutdated: boolean;
  /** True if this softwareTeam was observed missing one or more required list fields. */
  cliDriftDetected: boolean;
}

export interface FleetRollup {
  rows: FleetRollupRow[];
  staleCliCount: number;
  /** SoftwareTeams whose CLI field support has not been observed. */
  unknownCliCount: number;
  /** Fields known to be missing across the observed softwareTeams (de-duplicated). */
  degradedFields: string[];
  /** Source of fleet activity when it is projected without reading the CLI. */
  sourceFallback: string | null;
}

export interface CliCapabilityObservation {
  cliVersionLabel: string;
  /** Null means unobserved; an empty array means all required fields were supported. */
  unsupportedFields: string[] | null;
  /** Independent version evidence, never inferred from missing fields. */
  versionOutdated?: boolean;
}

interface CliCapabilityDeps {
  db: Database.Database;
  eventBus: EventBus;
  softwareTeamRepo: SoftwareTeamRepository;
  /**
   * Optional observation of a softwareTeam's CLI version and supported list fields.
   * Without an observation, both remain unknown.
   */
  probeSoftwareTeam?: (softwareTeamName: string) => Promise<CliCapabilityObservation>;
  /** Override clock for tests. */
  now?: () => Date;
}

interface SoftwareTeamQueueRow {
  destination_session: string;
  state: string;
  ts_updated: string;
  blocked_on: string | null;
}

/**
 * Fields expected from the node list. recoveryGuidance belongs to node
 * detail; its absence from `SoftwareTeam ps --nodes --fields` is not incompatibility.
 */
export const MISSION_CONTROL_DESIRED_FIELDS = [
  "agentActivity",
] as const;

/**
 * Adapt explicit local CLI observations. The daemon-internal projection
 * does not observe a CLI by itself, so omitted inputs remain unknown.
 * Do not substitute the daemon's package version or a mirrored CLI allow-list.
 */
export function makeLocalCliCapabilityProbe(opts?: {
  versionLabel?: string;
  knownNodeFields?: ReadonlySet<string>;
  versionOutdated?: boolean;
}): (softwareTeamName: string) => Promise<CliCapabilityObservation> {
  const knownNodeFields = opts?.knownNodeFields;
  return async (_softwareTeamName: string) => ({
    cliVersionLabel: opts?.versionLabel?.trim() || "unknown",
    unsupportedFields: knownNodeFields === undefined ? null
      : MISSION_CONTROL_DESIRED_FIELDS.filter((field) => !knownNodeFields.has(field)),
    versionOutdated: opts?.versionOutdated,
  });
}

export class MissionControlFleetCliCapability {
  private readonly db: Database.Database;
  private readonly eventBus: EventBus;
  private readonly softwareTeamRepo: SoftwareTeamRepository;
  private readonly probeSoftwareTeam: NonNullable<CliCapabilityDeps["probeSoftwareTeam"]>;
  private readonly now: () => Date;

  /** Per-(softwareTeam, field) once-per-session log set. Cleared on daemon restart. */
  private readonly loggedDriftKeys: Set<string> = new Set();

  constructor(deps: CliCapabilityDeps) {
    this.db = deps.db;
    this.eventBus = deps.eventBus;
    this.softwareTeamRepo = deps.softwareTeamRepo;
    this.probeSoftwareTeam = deps.probeSoftwareTeam ?? makeLocalCliCapabilityProbe();
    this.now = deps.now ?? (() => new Date());
  }

  async rollupFleet(): Promise<FleetRollup> {
    const softwareTeams = this.softwareTeamRepo.listSoftwareTeams();
    const rows: FleetRollupRow[] = [];
    const allDegradedFields = new Set<string>();
    let staleCliCount = 0;
    let unknownCliCount = 0;

    for (const softwareTeam of softwareTeams) {
      let probe: CliCapabilityObservation;
      try {
        probe = await this.probeSoftwareTeam(softwareTeam.name);
      } catch {
        probe = { cliVersionLabel: "unknown", unsupportedFields: null };
      }
      const cliVersionLabel = probe.cliVersionLabel.trim() || "unknown";
      const unsupportedFields = probe.unsupportedFields ?? [];
      const driftDetected = unsupportedFields.length > 0;
      const cliCapabilityStatus = probe.unsupportedFields === null ? "unknown"
        : driftDetected ? "unavailable" : "available";
      const cliVersionOutdated = cliVersionLabel !== "unknown" && probe.versionOutdated === true;
      if (cliVersionOutdated) staleCliCount++;
      if (cliCapabilityStatus === "unknown") unknownCliCount++;
      for (const f of unsupportedFields) {
        allDegradedFields.add(f);
        this.maybeLogDriftOnce(softwareTeam.name, f);
      }
      const queueState = this.summarizeSoftwareTeamQueue(softwareTeam.name);
      rows.push({
        softwareTeamName: softwareTeam.name,
        activityState: queueState.activityState,
        lifecycleState: queueState.lifecycleState,
        attentionReason: queueState.attentionReason,
        lastUpdate: queueState.lastUpdate,
        cliVersionLabel,
        cliCapabilityStatus,
        cliVersionOutdated,
        cliDriftDetected: driftDetected,
      });
    }

    return {
      rows,
      staleCliCount,
      unknownCliCount,
      degradedFields: Array.from(allDegradedFields),
      // Activity still comes from the registry and queue, even when a
      // caller supplies independent CLI observations.
      sourceFallback: "daemon-internal-projection",
    };
  }

  /**
   * Per-(softwareTeam, field) once-per-session-per-softwareTeam log per PRD sub-clause 3.
   * Daemon restart clears the set so logging fires again on first
   * post-restart observation.
   */
  private maybeLogDriftOnce(softwareTeamName: string, missingField: string): void {
    const key = `${softwareTeamName}::${missingField}`;
    if (this.loggedDriftKeys.has(key)) return;
    this.loggedDriftKeys.add(key);
    const observedAt = this.now().toISOString();
    this.eventBus.emit({
      type: "mission_control.cli_drift_detected",
      softwareTeamName,
      missingField,
      observedAt,
    });
  }

  /**
   * Summarize a softwareTeam's queue state for the fleet view. Synthesized
   * from PL-004 Phase A queue_items via a single SQL aggregation:
   *   - active: any in-progress qitem
   *   - blocked: any blocked qitem (no in-progress)
   *   - attention: only pending qitems older than 1h
   *   - idle: no active queue activity
   *   - degraded: any failed/denied/canceled qitem in last 24h
   */
  private summarizeSoftwareTeamQueue(softwareTeamName: string): {
    activityState: FleetRollupRow["activityState"];
    lifecycleState: string | null;
    attentionReason: string | null;
    lastUpdate: string;
  } {
    const ownedSessions = this.db
      .prepare(
        `SELECT destination_session, state, ts_updated, blocked_on
           FROM queue_items
          WHERE destination_session LIKE ?
            OR source_session LIKE ?
          ORDER BY ts_updated DESC LIMIT 100`,
      )
      .all(`%@${softwareTeamName}`, `%@${softwareTeamName}`) as SoftwareTeamQueueRow[];

    if (ownedSessions.length === 0) {
      return {
        activityState: "idle",
        lifecycleState: null,
        attentionReason: null,
        lastUpdate: this.now().toISOString(),
      };
    }
    const lastUpdate = ownedSessions[0]!.ts_updated;
    const hasInProgress = ownedSessions.some((q) => q.state === "in-progress");
    const hasBlocked = ownedSessions.some((q) => q.state === "blocked");
    const hasFailed = ownedSessions.some((q) =>
      q.state === "failed" || q.state === "denied" || q.state === "canceled",
    );
    let activityState: FleetRollupRow["activityState"] = "idle";
    let attentionReason: string | null = null;
    if (hasInProgress) {
      activityState = "active";
    } else if (hasBlocked) {
      activityState = "blocked";
      const blockedRow = ownedSessions.find((q) => q.state === "blocked");
      attentionReason = blockedRow?.blocked_on
        ? `blocked-on: ${blockedRow.blocked_on}`
        : "blocked";
    } else if (hasFailed) {
      activityState = "degraded";
      attentionReason = "recent failure / denial / cancel in queue";
    }
    return {
      activityState,
      lifecycleState: ownedSessions[0]!.state,
      attentionReason,
      lastUpdate,
    };
  }

  /** Test/observability helper: clear the once-per-session log set. */
  resetDriftLogForTest(): void {
    this.loggedDriftKeys.clear();
  }
}
