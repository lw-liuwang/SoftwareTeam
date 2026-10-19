import type Database from "better-sqlite3";
import {
  deriveActiveOccupantsByNode,
  deriveActiveSessionIdByNode,
  deriveRehydrateOccupantsByNode,
  deriveRehydrateSessionIdByNode,
} from "./active-occupant.js";
import type { SoftwareTeamRepository } from "./software-team-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { EventBus } from "./event-bus.js";
import type { SnapshotRepository } from "./snapshot-repository.js";
import type { PersistedEvent } from "./types.js";
import type { CheckpointStore } from "./checkpoint-store.js";
import type { Snapshot, SnapshotData } from "./types.js";
import { SoftwareTeamNotFoundError } from "./errors.js";
import { readFreshOccupantRelations } from "./fresh-occupant-relation.js";

interface SnapshotCaptureDeps {
  db: Database.Database;
  softwareTeamRepo: SoftwareTeamRepository;
  sessionRegistry: SessionRegistry;
  eventBus: EventBus;
  snapshotRepo: SnapshotRepository;
  checkpointStore: CheckpointStore;
}

export class SnapshotCapture {
  readonly db: Database.Database;
  private softwareTeamRepo: SoftwareTeamRepository;
  private sessionRegistry: SessionRegistry;
  private eventBus: EventBus;
  private snapshotRepo: SnapshotRepository;
  private checkpointStore: CheckpointStore;

  constructor(deps: SnapshotCaptureDeps) {
    if (deps.db !== deps.softwareTeamRepo.db) {
      throw new Error("SnapshotCapture: softwareTeamRepo must share the same db handle");
    }
    if (deps.db !== deps.sessionRegistry.db) {
      throw new Error("SnapshotCapture: sessionRegistry must share the same db handle");
    }
    if (deps.db !== deps.eventBus.db) {
      throw new Error("SnapshotCapture: eventBus must share the same db handle");
    }
    if (deps.db !== deps.snapshotRepo.db) {
      throw new Error("SnapshotCapture: snapshotRepo must share the same db handle");
    }
    if (deps.db !== deps.checkpointStore.db) {
      throw new Error("SnapshotCapture: checkpointStore must share the same db handle");
    }

    this.db = deps.db;
    this.softwareTeamRepo = deps.softwareTeamRepo;
    this.sessionRegistry = deps.sessionRegistry;
    this.eventBus = deps.eventBus;
    this.snapshotRepo = deps.snapshotRepo;
    this.checkpointStore = deps.checkpointStore;
  }

  captureSnapshot(softwareTeamId: string, kind: string, opts?: { intendedNodeIds?: string[] }): Snapshot {
    // 1. Get softwareTeam with nodes, edges, bindings
    const softwareTeam = this.softwareTeamRepo.getSoftwareTeam(softwareTeamId);
    if (!softwareTeam) {
      throw new SoftwareTeamNotFoundError(softwareTeamId);
    }

    // 2. Get sessions with resume metadata
    const sessions = this.sessionRegistry.getSessionsForSoftwareTeam(softwareTeamId);

    // 2b. OPR.0.5.7.1 D1 — capture the ACTIVE-OCCUPANT relation explicitly,
    // through the ONE shared derivation (active-occupant.ts) that the live
    // no-snapshot preview also uses, so the sibling paths cannot drift.
    const recorded = kind === "auto-rehydrate" ? readFreshOccupantRelations(this.db, softwareTeamId) : {};
    const activeSessionIdByNode = kind === "auto-rehydrate"
      ? deriveRehydrateSessionIdByNode(sessions, softwareTeam.nodes.map((n) => n.id), recorded)
      : deriveActiveSessionIdByNode(sessions, softwareTeam.nodes.map((n) => n.id));
    const activeOccupantsByNode = kind === "auto-rehydrate"
      ? deriveRehydrateOccupantsByNode(sessions, softwareTeam.nodes.map((n) => n.id), recorded)
      : deriveActiveOccupantsByNode(sessions, softwareTeam.nodes.map((n) => n.id));

    const requestedRoster = opts?.intendedNodeIds;
    const materializedRoster = requestedRoster ? null : this.materializedRoster(softwareTeamId);
    const intendedNodeIds = requestedRoster ?? materializedRoster ?? softwareTeam.nodes.map((node) => node.id);
    const allNodeIds = new Set(softwareTeam.nodes.map((node) => node.id));
    if (
      new Set(intendedNodeIds).size !== intendedNodeIds.length
      || intendedNodeIds.some((nodeId) => !allNodeIds.has(nodeId))
    ) {
      throw new Error("Snapshot intended roster must contain unique node ids belonging to the target softwareTeam");
    }

    // 3. Get checkpoints as map (latest per node)
    const checkpoints = this.checkpointStore.getCheckpointsForSoftwareTeam(softwareTeamId);

    // 4. Get pods + continuity state + startup context
    const podRows = this.db.prepare("SELECT * FROM pods WHERE software_team_id = ?")
      .all(softwareTeamId) as Array<{ id: string; software_team_id: string; namespace: string; label: string; summary: string | null; continuity_policy_json: string | null; created_at: string }>;
    const podIds = podRows.map((p) => p.id);
    const continuityRows = podIds.length > 0
      ? this.db.prepare(`SELECT * FROM continuity_state WHERE pod_id IN (${podIds.map(() => "?").join(",")})`)
          .all(...podIds) as Array<{ pod_id: string; node_id: string; status: string; artifacts_json: string | null; last_sync_at: string | null; updated_at: string }>
      : [];

    const nodeStartupContext: Record<string, import("./types.js").NodeStartupSnapshot | null> = {};
    for (const node of softwareTeam.nodes) {
      const ctx = this.db.prepare("SELECT * FROM node_startup_context WHERE node_id = ?")
        .get(node.id) as { projection_entries_json: string; resolved_files_json: string; startup_actions_json: string; runtime: string } | undefined;
      nodeStartupContext[node.id] = ctx ? {
        projectionEntries: JSON.parse(ctx.projection_entries_json),
        resolvedStartupFiles: JSON.parse(ctx.resolved_files_json),
        startupActions: JSON.parse(ctx.startup_actions_json),
        runtime: ctx.runtime,
      } : null;
    }

    // 4b. Get env receipt from services record if services exist
    const servicesRecord = this.softwareTeamRepo.getServicesRecord(softwareTeamId);
    let envReceipt: import("./types.js").EnvReceipt | null = null;
    if (servicesRecord?.latestReceiptJson) {
      try {
        envReceipt = JSON.parse(servicesRecord.latestReceiptJson);
      } catch { /* receipt_only — no checkpoint available */ }
    }

    // 5. Assemble SnapshotData
    const data: SnapshotData = {
      softwareTeam: softwareTeam.softwareTeam,
      nodes: softwareTeam.nodes,
      edges: softwareTeam.edges,
      sessions,
      activeSessionIdByNode,
      activeOccupantsByNode,
      topologyRoster: {
        version: 1,
        source: requestedRoster
          ? "operator_explicit"
          : materializedRoster
            ? "materialized_topology"
            : "legacy_current_nodes",
        intendedNodeIds,
      },
      checkpoints,
      pods: podRows.map((p) => ({ id: p.id, softwareTeamId: p.software_team_id, namespace: p.namespace, label: p.label, summary: p.summary, continuityPolicyJson: p.continuity_policy_json, createdAt: p.created_at })),
      continuityStates: continuityRows.map((r) => ({ podId: r.pod_id, nodeId: r.node_id, status: r.status as "healthy" | "degraded" | "restoring", artifactsJson: r.artifacts_json, lastSyncAt: r.last_sync_at, updatedAt: r.updated_at })),
      nodeStartupContext,
      envReceipt,
    };

    // 5. Atomic: persist snapshot + event in one transaction
    const txn = this.db.transaction(() => {
      const snapshot = this.snapshotRepo.createSnapshot(softwareTeamId, kind, data);
      const persistedEvent = this.eventBus.persistWithinTransaction({
        type: "snapshot.created",
        softwareTeamId,
        snapshotId: snapshot.id,
        kind,
      });
      return { snapshot, persistedEvent };
    });

    const { snapshot, persistedEvent } = txn();

    // 6. Notify subscribers after commit (best-effort)
    this.eventBus.notifySubscribers(persistedEvent);

    return snapshot;
  }

  private materializedRoster(softwareTeamId: string): string[] | null {
    const row = this.db.prepare(
      "SELECT payload FROM events WHERE software_team_id = ? AND type = 'topology.roster_recorded' ORDER BY seq DESC LIMIT 1",
    ).get(softwareTeamId) as { payload: string } | undefined;
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.payload) as { intendedNodeIds?: unknown };
      if (!Array.isArray(parsed.intendedNodeIds) || !parsed.intendedNodeIds.every((id) => typeof id === "string")) {
        throw new Error("latest topology roster event has no string intendedNodeIds array");
      }
      return parsed.intendedNodeIds;
    } catch (error) {
      throw new Error(`Cannot capture snapshot from malformed authoritative topology roster: ${(error as Error).message}`);
    }
  }
}
