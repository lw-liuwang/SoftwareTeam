import type Database from "better-sqlite3";
import { resolveActiveOccupantRow } from "./active-occupant.js";
import { resolve } from "node:path";
import { ulid } from "ulid";
import { deriveComposeProjectName } from "./compose-project-name.js";
import type { ClaudeManagedBlockFile } from "./managed-blocks.js";
import { mergeSeatEnv, parseStoredSeatEnv, type SeatEnv } from "./seat-env.js";
import type {
  SoftwareTeam,
  Node,
  Edge,
  Binding,
  NodeWithBinding,
  SoftwareTeamWithRelations,
  SoftwareTeamServicesRecord,
  SoftwareTeamServicesRecordInput,
  Snapshot,
  SnapshotData,
  SessionSourceSpec,
} from "./types.js";

/**
 * Free helper: returns the latest snapshot for a softwareTeam whose data carries non-null
 * `resume_token` for at least one persisted session, or null otherwise.
 *
 * Used by node-inventory and ps-projection to derive `lifecycleState=recoverable`
 * post-L1 cold-start. Distinct from `findLatestAutoPreDown`, which filters by kind.
 */
interface SnapshotRow { id: string; software_team_id: string; kind: string; status: string; data: string; created_at: string }

/** Shared row → usable-Snapshot mapping (single source of truth for the parse +
 *  the ≥1-resume-token usability rule), used by both the single-softwareTeam and the
 *  FS-1 W1.2 all-softwareTeams batched reads so their semantics are byte-identical. */
function snapshotFromRowIfUsable(row: SnapshotRow): Snapshot | null {
  let data: SnapshotData;
  try {
    data = JSON.parse(row.data) as SnapshotData;
  } catch {
    return null;
  }

  // OPR.0.5.7.1 — usability is OCCUPANT truth, not any-historical-row truth:
  // a snapshot is usable iff at least one node RESOLVES to an active occupant
  // carrying a token (the same four-way ladder execution consumes). A
  // present-null/missing-key/dangling relation never counts — a historical
  // token on a non-occupant row must not read as recoverable.
  const sessions = data.sessions ?? [];
  const nodeIds = [...new Set(sessions.map((s) => s.nodeId))];
  const hasResolvedOccupantToken = nodeIds.some((nodeId) => {
    const resolution = resolveActiveOccupantRow(sessions, data.activeSessionIdByNode, nodeId);
    return resolution.kind === "resolved"
      && typeof resolution.session.resumeToken === "string"
      && resolution.session.resumeToken.length > 0;
  });
  if (!hasResolvedOccupantToken) return null;

  return {
    id: row.id,
    softwareTeamId: row.software_team_id,
    kind: row.kind,
    status: row.status,
    data,
    createdAt: row.created_at,
  };
}

export function findLatestUsableSnapshot(db: Database.Database, softwareTeamId: string): Snapshot | null {
  const row = db.prepare(
    "SELECT * FROM snapshots WHERE software_team_id = ? ORDER BY created_at DESC, id DESC LIMIT 1"
  ).get(softwareTeamId) as SnapshotRow | undefined;
  if (!row) return null;
  return snapshotFromRowIfUsable(row);
}

/**
 * FS-1 W1.2 — the all-softwareTeams batched form of `findLatestUsableSnapshot`: the
 * latest snapshot per softwareTeam in ONE query (same `created_at DESC, id DESC` order),
 * each mapped through the shared `snapshotFromRowIfUsable`. SoftwareTeams with no usable
 * snapshot are simply absent from the map (callers default to null). Rides the
 * arch-D1.1 sibling-audit `snapshots(software_team_id, created_at)` index candidate.
 */
export function findLatestUsableSnapshotsForAllSoftwareTeams(db: Database.Database): Map<string, Snapshot> {
  const rows = db.prepare(`
    SELECT s.* FROM snapshots s
    WHERE s.id = (
      SELECT s2.id FROM snapshots s2 WHERE s2.software_team_id = s.software_team_id
      ORDER BY s2.created_at DESC, s2.id DESC LIMIT 1
    )
  `).all() as SnapshotRow[];
  const out = new Map<string, Snapshot>();
  for (const row of rows) {
    const snap = snapshotFromRowIfUsable(row);
    if (snap) out.set(row.software_team_id, snap);
  }
  return out;
}

/**
 * OPR.0.3.3.19 - softwareTeam archive read filter. Default daemon reads EXCLUDE archived
 * softwareTeams; explicit modes opt in. Mirrors the stream-items `--include-archived`
 * precedent (stream-store.list).
 */
export interface SoftwareTeamArchiveFilter {
  /** include both active and archived softwareTeams */
  includeArchived?: boolean;
  /** return ONLY archived softwareTeams */
  archivedOnly?: boolean;
}

/**
 * SQL condition fragment for the archive filter on a column (e.g. "archived_at"
 * or the aliased "r.archived_at"). Returns null when no filter applies
 * (includeArchived = include everything). Default (no filter) excludes archived.
 */
export function archiveWhereClause(col: string, filter?: SoftwareTeamArchiveFilter): string | null {
  if (filter?.archivedOnly) return `${col} IS NOT NULL`;
  if (filter?.includeArchived) return null;
  return `${col} IS NULL`;
}

interface NodeOptions {
  role?: string;
  runtime?: string;
  model?: string;
  effort?: string;
  codexConfigProfile?: string;
  /** OPR.0.4.8.3 Seam B: per-seat permission_policy REF (builtin:<name> or spec-relative path). */
  permissionPolicy?: string;
  /** The member's declared launch environment (spec `env:`); not merged with the softwareTeam's. */
  env?: SeatEnv;
  cwd?: string;
  surfaceHint?: string;
  workspace?: string;
  restorePolicy?: string;
  packageRefs?: string[];
  podId?: string;
  agentRef?: string;
  profile?: string;
  label?: string;
  sessionSource?: SessionSourceSpec;
  resolvedSpecName?: string;
  resolvedSpecVersion?: string;
  resolvedSpecHash?: string;
}

export class SoftwareTeamRepository {
  readonly db: Database.Database;
  /** OPR.0.5.6.24 — born-armed (advisor-ruled birth-property principle):
   *  protection arms in the same act that creates the softwareTeam. Wired at startup;
   *  optional so repo construction stays dependency-free. */
  onSoftwareTeamCreated?: (softwareTeam: SoftwareTeam) => void;
  constructor(db: Database.Database) {
    this.db = db;
  }

  createSoftwareTeam(name: string, installRoot?: string): SoftwareTeam {
    const id = ulid();
    if (installRoot !== undefined) {
      this.db.prepare("INSERT INTO software_teams (id, name, install_root) VALUES (?, ?, ?)")
        .run(id, name, installRoot);
    } else {
      this.db.prepare("INSERT INTO software_teams (id, name) VALUES (?, ?)").run(id, name);
    }

    const softwareTeam = this.rowToSoftwareTeam(
      this.db.prepare("SELECT * FROM software_teams WHERE id = ?").get(id) as SoftwareTeamRow
    );
    this.onSoftwareTeamCreated?.(softwareTeam);
    return softwareTeam;
  }

  /** Canonical bundle materialization folder, independent of seats' working directories. */
  getSoftwareTeamInstallRoot(softwareTeamId: string): string | null {
    const row = this.db.prepare("SELECT * FROM software_teams WHERE id = ?").get(softwareTeamId) as
      { install_root?: string | null } | undefined;
    return row?.install_root ?? null;
  }

  /**
   * PL-007 Workspace Primitive — persist the typed workspace block on the
   * softwareTeams row. Stored as JSON in `workspace_json` (migration 038). Pass
   * null to clear. Older test fixtures that bypass the canonical migration
   * list don't have the column; setter is a no-op in that case (the
   * caller's contract is "best-effort persistence"). Whoami / node-inventory
   * read this column to surface the softwareTeam's workspace block alongside cwd.
   */
  setSoftwareTeamWorkspace(softwareTeamId: string, workspace: import("./types.js").WorkspaceSpec | null): void {
    if (!this.hasSoftwareTeamColumn("workspace_json")) return;
    const json = workspace ? JSON.stringify(workspace) : null;
    this.db.prepare("UPDATE software_teams SET workspace_json = ?, updated_at = ? WHERE id = ?")
      .run(json, new Date().toISOString(), softwareTeamId);
  }

  /** PL-007 — read the persisted workspace block for a softwareTeam. */
  getSoftwareTeamWorkspace(softwareTeamId: string): import("./types.js").WorkspaceSpec | null {
    if (!this.hasSoftwareTeamColumn("workspace_json")) return null;
    const row = this.db.prepare("SELECT workspace_json FROM software_teams WHERE id = ?")
      .get(softwareTeamId) as { workspace_json: string | null } | undefined;
    if (!row || !row.workspace_json) return null;
    try {
      return JSON.parse(row.workspace_json) as import("./types.js").WorkspaceSpec;
    } catch {
      return null;
    }
  }

  setSoftwareTeamNonInterruptive(softwareTeamId: string, enabled: boolean): void {
    if (!this.hasSoftwareTeamColumn("non_interruptive")) return;
    this.db.prepare("UPDATE software_teams SET non_interruptive = ?, updated_at = ? WHERE id = ?")
      .run(enabled ? 1 : 0, new Date().toISOString(), softwareTeamId);
  }

  getSoftwareTeamNonInterruptive(softwareTeamId: string): boolean {
    if (!this.hasSoftwareTeamColumn("non_interruptive")) return false;
    const row = this.db.prepare("SELECT non_interruptive FROM software_teams WHERE id = ?")
      .get(softwareTeamId) as { non_interruptive: number } | undefined;
    return row?.non_interruptive === 1;
  }

  /** Persist the software-team-level `env:` block from the spec, or null to clear. */
  setSoftwareTeamEnv(softwareTeamId: string, env: SeatEnv | null): void {
    if (!this.hasSoftwareTeamColumn("env_json")) return;
    this.db.prepare("UPDATE software_teams SET env_json = ?, updated_at = ? WHERE id = ?")
      .run(env ? JSON.stringify(env) : null, new Date().toISOString(), softwareTeamId);
  }

  getSoftwareTeamEnv(softwareTeamId: string): SeatEnv | null {
    if (!this.hasSoftwareTeamColumn("env_json")) return null;
    const row = this.db.prepare("SELECT env_json FROM software_teams WHERE id = ?")
      .get(softwareTeamId) as { env_json: string | null } | undefined;
    return parseStoredSeatEnv(row?.env_json);
  }

  /** What a seat's process gets: its softwareTeam's `env:` with the member's own `env:` over it. A launch,
   *  a restore and a handover successor all read this, so they cannot disagree. */
  getEffectiveSeatEnv(nodeId: string): SeatEnv {
    if (!this.hasNodeColumn("env_json")) return {};
    const row = this.db.prepare("SELECT software_team_id, env_json FROM nodes WHERE id = ?")
      .get(nodeId) as { software_team_id: string; env_json: string | null } | undefined;
    if (!row) return {};
    return mergeSeatEnv(this.getSoftwareTeamEnv(row.software_team_id), parseStoredSeatEnv(row.env_json));
  }

  /** OPR.0.4.8.3 Seam B — persist a softwareTeam's attached permission_policy REF (builtin:<name> or a
   *  spec-relative custom path), or null to clear. Mirrors setSoftwareTeamWorkspace (migration 056). */
  setSoftwareTeamPermissionPolicy(softwareTeamId: string, permissionPolicy: string | null): void {
    if (!this.hasSoftwareTeamColumn("permission_policy")) return;
    this.db.prepare("UPDATE software_teams SET permission_policy = ?, updated_at = ? WHERE id = ?")
      .run(permissionPolicy ?? null, new Date().toISOString(), softwareTeamId);
  }

  /** OPR.0.4.8.3 Seam B — read the persisted software-team-level permission_policy REF (null when none). */
  getSoftwareTeamPermissionPolicy(softwareTeamId: string): string | null {
    if (!this.hasSoftwareTeamColumn("permission_policy")) return null;
    const row = this.db.prepare("SELECT permission_policy FROM software_teams WHERE id = ?")
      .get(softwareTeamId) as { permission_policy: string | null } | undefined;
    return row?.permission_policy ?? null;
  }

  /** #25 — persist the softwareTeam's selected Claude managed-block file (migration 085), or null for
   *  the CLAUDE.md default. Mirrors setSoftwareTeamPermissionPolicy. */
  setSoftwareTeamClaudeManagedBlockFile(softwareTeamId: string, file: ClaudeManagedBlockFile | null): void {
    if (!this.hasSoftwareTeamColumn("claude_managed_block_file")) return;
    this.db.prepare("UPDATE software_teams SET claude_managed_block_file = ?, updated_at = ? WHERE id = ?")
      .run(file ?? null, new Date().toISOString(), softwareTeamId);
  }

  /** #25 — the softwareTeam's selected Claude managed-block file, or null when it uses the default. */
  getSoftwareTeamClaudeManagedBlockFile(softwareTeamId: string): ClaudeManagedBlockFile | null {
    if (!this.hasSoftwareTeamColumn("claude_managed_block_file")) return null;
    const row = this.db.prepare("SELECT claude_managed_block_file FROM software_teams WHERE id = ?")
      .get(softwareTeamId) as { claude_managed_block_file: ClaudeManagedBlockFile | null } | undefined;
    return row?.claude_managed_block_file ?? null;
  }

  /** Seam B Guard-F1 — persist the SOFTWARE_TEAM-level resolved attachment provenance (migration 058).
   *  declaringDir = the ORIGINAL declaring SoftwareTeamSpec dir; consumers must never re-resolve the
   *  raw relative ref against an unrelated operation root. No-op on pre-058 fixture DBs. */
  setSoftwareTeamPolicyProvenance(
    softwareTeamId: string,
    provenance: {
      origin: "builtin" | "custom" | "deliberate_none";
      resolvedTarget: string | null;
      declaringDir: string | null;
      launchPosture: "floor" | "full_bypass" | "auto";
    },
  ): void {
    if (!this.hasSoftwareTeamColumn("software_team_policy_launch_posture")) return;
    this.db.prepare(
      "UPDATE software_teams SET software_team_policy_origin = ?, software_team_policy_resolved_target = ?, software_team_policy_declaring_dir = ?, software_team_policy_launch_posture = ?, updated_at = ? WHERE id = ?",
    ).run(provenance.origin, provenance.resolvedTarget, provenance.declaringDir, provenance.launchPosture, new Date().toISOString(), softwareTeamId);
  }

  /** Seam B Guard-F1 — read the software-team-level resolved attachment provenance (null when none). */
  getSoftwareTeamPolicyProvenance(softwareTeamId: string): {
    origin: "builtin" | "custom" | "deliberate_none";
    resolvedTarget: string | null;
    declaringDir: string | null;
    launchPosture: "floor" | "full_bypass" | "auto";
    /** the raw softwareTeam ref (056) alongside, for re-validation */
    softwareTeamRef: string | null;
  } | null {
    if (!this.hasSoftwareTeamColumn("software_team_policy_launch_posture")) return null;
    const row = this.db.prepare(
      "SELECT permission_policy, software_team_policy_origin, software_team_policy_resolved_target, software_team_policy_declaring_dir, software_team_policy_launch_posture FROM software_teams WHERE id = ?",
    ).get(softwareTeamId) as {
      permission_policy: string | null;
      software_team_policy_origin: string | null;
      software_team_policy_resolved_target: string | null;
      software_team_policy_declaring_dir: string | null;
      software_team_policy_launch_posture: string | null;
    } | undefined;
    if (!row || row.software_team_policy_origin == null || row.software_team_policy_launch_posture == null) return null;
    return {
      origin: row.software_team_policy_origin as "builtin" | "custom" | "deliberate_none",
      resolvedTarget: row.software_team_policy_resolved_target,
      declaringDir: row.software_team_policy_declaring_dir,
      launchPosture: row.software_team_policy_launch_posture as "floor" | "full_bypass" | "auto",
      softwareTeamRef: row.permission_policy,
    };
  }

  /** OPR.0.4.8.3 Seam B (R2, dev-guard ruling) — persist a node's RESOLVED policy attachment
   *  provenance (restart-stable: origin + resolved target + declaring dir + launch posture).
   *  Builtins carry resolvedTarget=null until the packaging leg's canonical path is ruled
   *  (PM lane c76c7153) — never a `builtin:<name>` echo. No-op on pre-057 fixture DBs. */
  setNodePolicyProvenance(
    nodeId: string,
    provenance: {
      origin: "builtin" | "custom" | "deliberate_none";
      resolvedTarget: string | null;
      declaringDir: string | null;
      launchPosture: "floor" | "full_bypass" | "auto";
    },
  ): void {
    if (!this.hasNodeColumn("policy_launch_posture")) return;
    this.db.prepare(
      "UPDATE nodes SET policy_origin = ?, policy_resolved_target = ?, policy_declaring_dir = ?, policy_launch_posture = ? WHERE id = ?",
    ).run(provenance.origin, provenance.resolvedTarget, provenance.declaringDir, provenance.launchPosture, nodeId);
  }

  /** Re-point an EXISTING seat's own permission_policy REF (`softwareTeam policy apply --seat`); the caller
   *  writes its resolved provenance through setNodePolicyProvenance in the same transaction. Restore,
   *  resume and launches that read the stored seat use that provenance. A later launch from a spec that
   *  declares a policy rewrites the provenance but not this ref, so the two can then differ: this ref
   *  is what `softwareTeam export` emits, not necessarily the policy the seat launched with. */
  setNodePermissionPolicy(nodeId: string, permissionPolicy: string): void {
    if (!this.hasNodeColumn("permission_policy")) return;
    this.db.prepare("UPDATE nodes SET permission_policy = ? WHERE id = ?").run(permissionPolicy, nodeId);
  }

  /** Seam B (R2) — read a node's persisted policy provenance; null when none attached
   *  (or pre-057 DB). Restore consumers re-derive posture from this without the spec. */
  getNodePolicyProvenance(nodeId: string): {
    origin: "builtin" | "custom" | "deliberate_none";
    resolvedTarget: string | null;
    declaringDir: string | null;
    launchPosture: "floor" | "full_bypass" | "auto";
    /** The node's own raw ref (member-level; null when the attachment came from the softwareTeam). */
    nodeRef: string | null;
  } | null {
    if (!this.hasNodeColumn("policy_launch_posture")) return null;
    const row = this.db.prepare(
      "SELECT permission_policy, policy_origin, policy_resolved_target, policy_declaring_dir, policy_launch_posture FROM nodes WHERE id = ?",
    ).get(nodeId) as {
      permission_policy: string | null;
      policy_origin: string | null;
      policy_resolved_target: string | null;
      policy_declaring_dir: string | null;
      policy_launch_posture: string | null;
    } | undefined;
    if (!row || row.policy_origin == null || row.policy_launch_posture == null) return null;
    return {
      origin: row.policy_origin as "builtin" | "custom" | "deliberate_none",
      resolvedTarget: row.policy_resolved_target,
      declaringDir: row.policy_declaring_dir,
      launchPosture: row.policy_launch_posture as "floor" | "full_bypass" | "auto",
      nodeRef: row.permission_policy,
    };
  }

  /** PL-007 — defensive column probe on software_teams (migration 038's
   *  workspace_json is absent in legacy test fixtures). */
  private hasSoftwareTeamColumn(columnName: string): boolean {
    try {
      return this.db.prepare("PRAGMA table_info(software_teams)").all()
        .some((row) => (row as { name?: string }).name === columnName);
    } catch {
      return false;
    }
  }

  addNode(softwareTeamId: string, logicalId: string, opts?: NodeOptions): Node {
    // Same-softwareTeam guard for podId
    if (opts?.podId) {
      const pod = this.db.prepare("SELECT software_team_id FROM pods WHERE id = ?").get(opts.podId) as { software_team_id: string } | undefined;
      if (!pod) throw new Error(`Pod not found: ${opts.podId}`);
      if (pod.software_team_id !== softwareTeamId) throw new Error("Pod belongs to a different softwareTeam");
    }

    const id = ulid();
    if (this.hasNodeColumn("codex_config_profile") && this.hasNodeColumn("permission_policy")) {
      // OPR.0.4.8.3 Seam B: both ALTER-added optional columns present (migrations 022 + 055; 055
      // runs after 022, so a permission_policy column implies a codex_config_profile column).
      this.db
        .prepare(
          `INSERT INTO nodes (id, software_team_id, logical_id, role, runtime, model, codex_config_profile, permission_policy, cwd, surface_hint, workspace, restore_policy, package_refs,
           pod_id, agent_ref, profile, label, resolved_spec_name, resolved_spec_version, resolved_spec_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          softwareTeamId,
          logicalId,
          opts?.role ?? null,
          opts?.runtime ?? null,
          opts?.model ?? null,
          opts?.codexConfigProfile ?? null,
          opts?.permissionPolicy ?? null,
          opts?.cwd ?? null,
          opts?.surfaceHint ?? null,
          opts?.workspace ?? null,
          opts?.restorePolicy ?? null,
          opts?.packageRefs ? JSON.stringify(opts.packageRefs) : null,
          opts?.podId ?? null,
          opts?.agentRef ?? null,
          opts?.profile ?? null,
          opts?.label ?? null,
          opts?.resolvedSpecName ?? null,
          opts?.resolvedSpecVersion ?? null,
          opts?.resolvedSpecHash ?? null,
        );
    } else if (this.hasNodeColumn("codex_config_profile")) {
      this.db
        .prepare(
          `INSERT INTO nodes (id, software_team_id, logical_id, role, runtime, model, codex_config_profile, cwd, surface_hint, workspace, restore_policy, package_refs,
           pod_id, agent_ref, profile, label, resolved_spec_name, resolved_spec_version, resolved_spec_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          softwareTeamId,
          logicalId,
          opts?.role ?? null,
          opts?.runtime ?? null,
          opts?.model ?? null,
          opts?.codexConfigProfile ?? null,
          opts?.cwd ?? null,
          opts?.surfaceHint ?? null,
          opts?.workspace ?? null,
          opts?.restorePolicy ?? null,
          opts?.packageRefs ? JSON.stringify(opts.packageRefs) : null,
          opts?.podId ?? null,
          opts?.agentRef ?? null,
          opts?.profile ?? null,
          opts?.label ?? null,
          opts?.resolvedSpecName ?? null,
          opts?.resolvedSpecVersion ?? null,
          opts?.resolvedSpecHash ?? null,
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO nodes (id, software_team_id, logical_id, role, runtime, model, cwd, surface_hint, workspace, restore_policy, package_refs,
           pod_id, agent_ref, profile, label, resolved_spec_name, resolved_spec_version, resolved_spec_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          softwareTeamId,
          logicalId,
          opts?.role ?? null,
          opts?.runtime ?? null,
          opts?.model ?? null,
          opts?.cwd ?? null,
          opts?.surfaceHint ?? null,
          opts?.workspace ?? null,
          opts?.restorePolicy ?? null,
          opts?.packageRefs ? JSON.stringify(opts.packageRefs) : null,
          opts?.podId ?? null,
          opts?.agentRef ?? null,
          opts?.profile ?? null,
          opts?.label ?? null,
          opts?.resolvedSpecName ?? null,
          opts?.resolvedSpecVersion ?? null,
          opts?.resolvedSpecHash ?? null,
        );
    }

    if (opts?.sessionSource && this.hasNodeColumn("session_source_json")) {
      this.db.prepare("UPDATE nodes SET session_source_json = ? WHERE id = ?")
        .run(JSON.stringify(opts.sessionSource), id);
    }

    if (opts?.effort && this.hasNodeColumn("effort")) {
      this.db.prepare("UPDATE nodes SET effort = ? WHERE id = ?")
        .run(opts.effort, id);
    }

    if (opts?.env && this.hasNodeColumn("env_json")) {
      this.db.prepare("UPDATE nodes SET env_json = ? WHERE id = ?")
        .run(JSON.stringify(opts.env), id);
    }

    return this.rowToNode(
      this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as NodeRow
    );
  }

  /** S5 (OPR.0.5.4.7) — the first supported nodes.model write (the inventory was insert-only;
   *  KI-5.3-9). Every managed resume/successor launch reads node.model at call time, so this
   *  UPDATE is the complete persistence half of set-model. Returns whether a row changed. */
  setNodeModel(nodeId: string, model: string): boolean {
    const result = this.db
      .prepare("UPDATE nodes SET model = ? WHERE id = ?")
      .run(model, nodeId);
    return result.changes > 0;
  }

  setNodeEffort(nodeId: string, effort: string): boolean {
    if (!this.hasNodeColumn("effort")) return false;
    const result = this.db
      .prepare("UPDATE nodes SET effort = ? WHERE id = ?")
      .run(effort, nodeId);
    return result.changes > 0;
  }

  /** OPR.0.7.0.7: write or clear (null) a seat's explicit effort choice. Returns false when
   *  the column isn't available or no row matched, so a caller never reports a change from it. */
  setNodeEffortChoice(nodeId: string, choice: string | null): boolean {
    if (!this.hasNodeColumn("effort_choice")) return false;
    return this.db.prepare("UPDATE nodes SET effort_choice = ? WHERE id = ?")
      .run(choice, nodeId).changes > 0;
  }

  clearNodeEffort(nodeId: string): boolean {
    if (!this.hasNodeColumn("effort")) return false;
    const result = this.db
      .prepare("UPDATE nodes SET effort = NULL WHERE id = ?")
      .run(nodeId);
    return result.changes > 0;
  }

  addEdge(softwareTeamId: string, sourceId: string, targetId: string, kind: string): Edge {
    const id = ulid();
    this.db
      .prepare(
        "INSERT INTO edges (id, software_team_id, source_id, target_id, kind) VALUES (?, ?, ?, ?, ?)"
      )
      .run(id, softwareTeamId, sourceId, targetId, kind);

    return this.rowToEdge(
      this.db.prepare("SELECT * FROM edges WHERE id = ?").get(id) as EdgeRow
    );
  }

  getSoftwareTeam(softwareTeamId: string): SoftwareTeamWithRelations | null {
    const softwareTeamRow = this.db
      .prepare("SELECT * FROM software_teams WHERE id = ?")
      .get(softwareTeamId) as SoftwareTeamRow | undefined;

    if (!softwareTeamRow) return null;

    const nodeRows = this.db
      .prepare("SELECT * FROM nodes WHERE software_team_id = ? ORDER BY created_at")
      .all(softwareTeamId) as NodeRow[];

    const edgeRows = this.db
      .prepare("SELECT * FROM edges WHERE software_team_id = ?")
      .all(softwareTeamId) as EdgeRow[];

    const nodes: NodeWithBinding[] = nodeRows.map((row) => {
      const bindingRow = this.db
        .prepare("SELECT * FROM bindings WHERE node_id = ?")
        .get(row.id) as BindingRow | undefined;

      return {
        ...this.rowToNode(row),
        binding: bindingRow ? this.rowToBinding(bindingRow) : null,
      };
    });

    return {
      softwareTeam: this.rowToSoftwareTeam(softwareTeamRow),
      nodes,
      edges: edgeRows.map((r) => this.rowToEdge(r)),
    };
  }

  listSoftwareTeams(filter?: SoftwareTeamArchiveFilter, observe?: import("./request-phase-observer.js").QueryObservation): SoftwareTeam[] {
    const cond = archiveWhereClause("archived_at", filter);
    const where = cond ? `WHERE ${cond}` : "";
    let rows: SoftwareTeamRow[];
    try { observe?.("begin"); } catch { /* Best-effort measurement only. */ }
    try {
      rows = this.db.prepare(`SELECT * FROM software_teams ${where} ORDER BY created_at`).all() as SoftwareTeamRow[];
    } catch (error) {
      try { observe?.("end", true); } catch { /* Preserve the actual query error. */ }
      throw error;
    }
    try { observe?.("end", false); } catch { /* Preserve the query result. */ }
    return rows.map((r) => this.rowToSoftwareTeam(r));
  }

  /**
   * Returns the latest snapshot for this softwareTeam with at least one non-null resume token,
   * or null if no usable snapshot exists. Used by the lifecycle projection to derive
   * `recoverable` state.
   */
  findLatestUsableSnapshot(softwareTeamId: string): Snapshot | null {
    return findLatestUsableSnapshot(this.db, softwareTeamId);
  }

  findSoftwareTeamsByName(name: string): SoftwareTeam[] {
    const rows = this.db
      .prepare("SELECT * FROM software_teams WHERE name = ? ORDER BY created_at")
      .all(name) as SoftwareTeamRow[];
    return rows.map((r) => this.rowToSoftwareTeam(r));
  }

  /** #174: seat-ref resolution sees only unarchived softwareTeams, as default reads do since migration 042. */
  findUnarchivedSoftwareTeamsByName(name: string): SoftwareTeam[] {
    const archived = this.hasSoftwareTeamColumn("archived_at") ? " AND archived_at IS NULL" : "";
    const rows = this.db
      .prepare(`SELECT * FROM software_teams WHERE name = ?${archived} ORDER BY created_at`)
      .all(name) as SoftwareTeamRow[];
    return rows.map((r) => this.rowToSoftwareTeam(r));
  }

  getSoftwareTeamSummaries(filter?: SoftwareTeamArchiveFilter): Array<{ id: string; name: string; nodeCount: number; latestSnapshotAt: string | null; latestSnapshotId: string | null; hasServices: boolean; archivedAt: string | null }> {
    const cond = archiveWhereClause("r.archived_at", filter);
    const where = cond ? `WHERE ${cond}` : "";
    const rows = this.db.prepare(`
      SELECT
        r.id,
        r.name,
        r.archived_at AS archived_at,
        (SELECT COUNT(*) FROM nodes n WHERE n.software_team_id = r.id) AS node_count,
        EXISTS(SELECT 1 FROM software_team_services rs WHERE rs.software_team_id = r.id) AS has_services,
        ls.id AS latest_snapshot_id,
        ls.created_at AS latest_snapshot_at
      FROM software_teams r
      LEFT JOIN snapshots ls ON ls.id = (
        SELECT s2.id FROM snapshots s2
        WHERE s2.software_team_id = r.id
        ORDER BY s2.created_at DESC, s2.id DESC
        LIMIT 1
      )
      ${where}
      ORDER BY r.created_at
    `).all() as Array<{ id: string; name: string; archived_at: string | null; node_count: number; has_services: number; latest_snapshot_id: string | null; latest_snapshot_at: string | null }>;

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      nodeCount: r.node_count,
      hasServices: r.has_services === 1,
      latestSnapshotAt: r.latest_snapshot_at,
      latestSnapshotId: r.latest_snapshot_id,
      archivedAt: r.archived_at,
    }));
  }

  /**
   * OPR.0.3.3.19 - soft-archive a softwareTeam: sets `archived_at`. The softwareTeams row,
   * topology rows, and snapshots are all RETAINED (this is NOT the delete
   * path - contrast deleteSoftwareTeam). Returns false if the softwareTeam was already archived.
   */
  archiveSoftwareTeam(softwareTeamId: string): boolean {
    const result = this.db
      .prepare("UPDATE software_teams SET archived_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND archived_at IS NULL")
      .run(softwareTeamId);
    return result.changes > 0;
  }

  /** OPR.0.3.3.19 - reverse archive: clears `archived_at`. Returns false if not archived. */
  unarchiveSoftwareTeam(softwareTeamId: string): boolean {
    const result = this.db
      .prepare("UPDATE software_teams SET archived_at = NULL, updated_at = datetime('now') WHERE id = ? AND archived_at IS NOT NULL")
      .run(softwareTeamId);
    return result.changes > 0;
  }

  deleteSoftwareTeam(softwareTeamId: string): void {
    this.db.prepare("DELETE FROM software_teams WHERE id = ?").run(softwareTeamId);
  }

  deleteNode(nodeId: string): void {
    this.db.prepare("DELETE FROM nodes WHERE id = ?").run(nodeId);
  }

  setServicesRecord(softwareTeamId: string, record: SoftwareTeamServicesRecordInput): SoftwareTeamServicesRecord {
    const now = new Date().toISOString();
    const composeFile = resolve(record.softwareTeamRoot, record.composeFile);
    const softwareTeam = this.db.prepare("SELECT 1 AS present FROM software_teams WHERE id = ?").get(softwareTeamId);
    if (!softwareTeam) throw new Error(`SoftwareTeam not found: ${softwareTeamId}`);
    // Keep the fallback aligned with bootstrap's unique, stable software-team-ID default.
    const projectName = record.projectName ?? this.getServicesRecord(softwareTeamId)?.projectName ?? deriveComposeProjectName(softwareTeamId);
    this.db.prepare(`
      INSERT INTO software_team_services (
        software_team_id,
        kind,
        spec_json,
        software_team_root,
        compose_file,
        project_name,
        latest_receipt_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(software_team_id) DO UPDATE SET
        kind = excluded.kind,
        spec_json = excluded.spec_json,
        software_team_root = excluded.software_team_root,
        compose_file = excluded.compose_file,
        project_name = excluded.project_name,
        latest_receipt_json = excluded.latest_receipt_json,
        updated_at = excluded.updated_at
    `).run(
      softwareTeamId,
      record.kind,
      record.specJson,
      record.softwareTeamRoot,
      composeFile,
      projectName,
      record.latestReceiptJson ?? null,
      now,
      now,
    );

    const stored = this.db.prepare("SELECT * FROM software_team_services WHERE software_team_id = ?").get(softwareTeamId) as SoftwareTeamServicesRow | undefined;
    if (!stored) throw new Error(`Failed to persist services record for softwareTeam ${softwareTeamId}`);
    return this.rowToServicesRecord(stored);
  }

  /** A retained generation must not tear down a live generation's project. */
  getLiveServicesSuccessor(softwareTeamId: string, projectName: string): { id: string; name: string } | null {
    if (!this.hasSoftwareTeamColumn("archived_at")) return null;
    return this.db.prepare(`
      SELECT r.id, r.name FROM software_team_services s JOIN software_teams r ON r.id = s.software_team_id
      JOIN software_teams predecessor ON predecessor.id = ?
      WHERE s.project_name = ? AND r.id != predecessor.id
        AND predecessor.archived_at IS NOT NULL AND r.archived_at IS NULL
        AND r.name = predecessor.name
      ORDER BY r.created_at DESC LIMIT 1
    `).get(softwareTeamId, projectName) as { id: string; name: string } | undefined ?? null;
  }

  getServicesRecord(softwareTeamId: string): SoftwareTeamServicesRecord | null {
    const row = this.db.prepare("SELECT * FROM software_team_services WHERE software_team_id = ?").get(softwareTeamId) as SoftwareTeamServicesRow | undefined;
    return row ? this.rowToServicesRecord(row) : null;
  }

  updateServicesReceipt(softwareTeamId: string, latestReceiptJson: string | null): SoftwareTeamServicesRecord | null {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE software_team_services
      SET latest_receipt_json = ?, updated_at = ?
      WHERE software_team_id = ?
    `).run(latestReceiptJson, now, softwareTeamId);

    if (result.changes === 0) return null;
    return this.getServicesRecord(softwareTeamId);
  }

  // -- Row-to-domain mappers --

  private rowToSoftwareTeam(row: SoftwareTeamRow): SoftwareTeam {
    return {
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private rowToNode(row: NodeRow): Node {
    return {
      id: row.id,
      softwareTeamId: row.software_team_id,
      logicalId: row.logical_id,
      role: row.role,
      runtime: row.runtime,
      model: row.model,
      effort: row.effort ?? null,
      effortChoice: row.effort_choice ?? null,
      codexConfigProfile: row.codex_config_profile ?? null,
      permissionPolicy: row.permission_policy ?? null,
      env: parseStoredSeatEnv(row.env_json),
      cwd: row.cwd,
      surfaceHint: row.surface_hint ?? null,
      workspace: row.workspace ?? null,
      restorePolicy: row.restore_policy ?? null,
      packageRefs: row.package_refs ? JSON.parse(row.package_refs) as string[] : [],
      podId: row.pod_id ?? null,
      agentRef: row.agent_ref ?? null,
      profile: row.profile ?? null,
      label: row.label ?? null,
      sessionSource: row.session_source_json
        ? JSON.parse(row.session_source_json) as SessionSourceSpec
        : null,
      resolvedSpecName: row.resolved_spec_name ?? null,
      resolvedSpecVersion: row.resolved_spec_version ?? null,
      resolvedSpecHash: row.resolved_spec_hash ?? null,
      occupantLifecycle: row.occupant_lifecycle as Node["occupantLifecycle"] ?? null,
      continuityOutcome: row.continuity_outcome as Node["continuityOutcome"] ?? null,
      handoverResult: row.handover_result as Node["handoverResult"] ?? null,
      previousOccupant: row.previous_occupant ?? null,
      handoverAt: row.handover_at ?? null,
      createdAt: row.created_at,
    };
  }

  private rowToEdge(row: EdgeRow): Edge {
    return {
      id: row.id,
      softwareTeamId: row.software_team_id,
      sourceId: row.source_id,
      targetId: row.target_id,
      kind: row.kind,
      createdAt: row.created_at,
    };
  }

  private rowToBinding(row: BindingRow): Binding {
    return {
      id: row.id,
      nodeId: row.node_id,
      attachmentType: (row.attachment_type as Binding["attachmentType"]) ?? "tmux",
      tmuxSession: row.tmux_session,
      tmuxWindow: row.tmux_window,
      tmuxPane: row.tmux_pane,
      externalSessionName: row.external_session_name ?? null,
      cmuxWorkspace: row.cmux_workspace,
      cmuxSurface: row.cmux_surface,
      updatedAt: row.updated_at,
    };
  }

  private rowToServicesRecord(row: SoftwareTeamServicesRow): SoftwareTeamServicesRecord {
    return {
      softwareTeamId: row.software_team_id,
      kind: row.kind as "compose",
      specJson: row.spec_json,
      softwareTeamRoot: row.software_team_root,
      composeFile: row.compose_file,
      projectName: row.project_name,
      latestReceiptJson: row.latest_receipt_json ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private hasNodeColumn(columnName: string): boolean {
    return this.db.prepare("PRAGMA table_info(nodes)").all()
      .some((row) => (row as { name?: string }).name === columnName);
  }
}

// -- Raw DB row types (snake_case) --

interface SoftwareTeamRow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

interface NodeRow {
  id: string;
  software_team_id: string;
  logical_id: string;
  role: string | null;
  runtime: string | null;
  model: string | null;
  effort?: string | null;
  effort_choice?: string | null;
  codex_config_profile?: string | null;
  permission_policy?: string | null;
  env_json?: string | null;
  cwd: string | null;
  surface_hint: string | null;
  workspace: string | null;
  restore_policy: string | null;
  package_refs: string | null;
  pod_id: string | null;
  agent_ref: string | null;
  profile: string | null;
  label: string | null;
  session_source_json?: string | null;
  resolved_spec_name: string | null;
  resolved_spec_version: string | null;
  resolved_spec_hash: string | null;
  occupant_lifecycle: string | null;
  continuity_outcome: string | null;
  handover_result: string | null;
  previous_occupant: string | null;
  handover_at: string | null;
  created_at: string;
}

interface EdgeRow {
  id: string;
  software_team_id: string;
  source_id: string;
  target_id: string;
  kind: string;
  created_at: string;
}

interface BindingRow {
  id: string;
  node_id: string;
  attachment_type: string | null;
  tmux_session: string | null;
  tmux_window: string | null;
  tmux_pane: string | null;
  external_session_name: string | null;
  cmux_workspace: string | null;
  cmux_surface: string | null;
  updated_at: string;
}

interface SoftwareTeamServicesRow {
  software_team_id: string;
  kind: string;
  spec_json: string;
  software_team_root: string;
  compose_file: string;
  project_name: string;
  latest_receipt_json: string | null;
  created_at: string;
  updated_at: string;
}
