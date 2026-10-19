import type { SoftwareTeamRepository } from "./software-team-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { PodRepository } from "./pod-repository.js";
import type {
  LegacySoftwareTeamSpec, LegacySoftwareTeamSpecNode, LegacySoftwareTeamSpecEdge,
  SoftwareTeamSpec, SoftwareTeamSpecPod, SoftwareTeamSpecPodMember, SoftwareTeamSpecPodEdge, SoftwareTeamSpecCrossPodEdge,
} from "./types.js";
import { SoftwareTeamNotFoundError } from "./errors.js";

interface SoftwareTeamSpecExporterDeps {
  softwareTeamRepo: SoftwareTeamRepository;
  sessionRegistry: SessionRegistry;
  podRepo?: PodRepository;
}

export class SoftwareTeamSpecExporter {
  readonly db: import("better-sqlite3").Database;
  private softwareTeamRepo: SoftwareTeamRepository;
  private sessionRegistry: SessionRegistry;
  private podRepo: PodRepository | null;

  constructor(deps: SoftwareTeamSpecExporterDeps) {
    if (deps.softwareTeamRepo.db !== deps.sessionRegistry.db) {
      throw new Error("SoftwareTeamSpecExporter: softwareTeamRepo and sessionRegistry must share the same db handle");
    }
    if (deps.podRepo && deps.softwareTeamRepo.db !== deps.podRepo.db) {
      throw new Error("SoftwareTeamSpecExporter: podRepo must share the same db handle");
    }
    this.db = deps.softwareTeamRepo.db;
    this.softwareTeamRepo = deps.softwareTeamRepo;
    this.sessionRegistry = deps.sessionRegistry;
    this.podRepo = deps.podRepo ?? null;
  }

  exportSoftwareTeam(softwareTeamId: string): LegacySoftwareTeamSpec | SoftwareTeamSpec {
    const softwareTeam = this.softwareTeamRepo.getSoftwareTeam(softwareTeamId);
    if (!softwareTeam) {
      throw new SoftwareTeamNotFoundError(softwareTeamId);
    }

    // Detect pod-aware: any node has a non-null podId, or pods exist explicitly.
    const isPodAware = softwareTeam.nodes.some((n) => n.podId != null) || (this.podRepo?.getPodsForSoftwareTeam(softwareTeamId).length ?? 0) > 0;

    if (isPodAware && this.podRepo) {
      return this.exportPodAware(softwareTeamId, softwareTeam);
    }

    return this.exportLegacy(softwareTeamId, softwareTeam);
  }

  private exportLegacy(softwareTeamId: string, softwareTeam: import("./types.js").SoftwareTeamWithRelations): LegacySoftwareTeamSpec {
    // Get all sessions for restorePolicy lookup
    const sessions = this.sessionRegistry.getSessionsForSoftwareTeam(softwareTeamId);

    // Build a map: nodeId (DB PK) -> logical_id
    const idToLogical = new Map(softwareTeam.nodes.map((n) => [n.id, n.logicalId]));

    const nodes: LegacySoftwareTeamSpecNode[] = softwareTeam.nodes.map((node) => {
      // Find latest session's restorePolicy for this node
      const nodeSessions = sessions
        .filter((s) => s.nodeId === node.id)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      const latestSession = nodeSessions.length > 0
        ? nodeSessions[nodeSessions.length - 1]!
        : null;

      const restorePolicy = latestSession?.restorePolicy
        ?? node.restorePolicy
        ?? undefined;

      if (!node.runtime) {
        throw new Error(`Cannot export node '${node.logicalId}': runtime is required but missing`);
      }

      const specNode: LegacySoftwareTeamSpecNode = {
        id: node.logicalId,
        runtime: node.runtime,
      };

      if (node.role) specNode.role = node.role;
      if (node.model) specNode.model = node.model;
      if (node.effort) specNode.effort = node.effort;
      if (node.cwd) specNode.cwd = node.cwd;
      if (node.surfaceHint) specNode.surfaceHint = node.surfaceHint;
      if (node.workspace) specNode.workspace = node.workspace;
      if (restorePolicy) specNode.restorePolicy = restorePolicy;
      if (node.packageRefs && node.packageRefs.length > 0) specNode.packageRefs = node.packageRefs;

      return specNode;
    });

    const edges: LegacySoftwareTeamSpecEdge[] = softwareTeam.edges.map((edge) => {
      const from = idToLogical.get(edge.sourceId);
      if (!from) {
        throw new Error(`Cannot export edge: unmapped source node ID '${edge.sourceId}'`);
      }
      const to = idToLogical.get(edge.targetId);
      if (!to) {
        throw new Error(`Cannot export edge: unmapped target node ID '${edge.targetId}'`);
      }
      return { from, to, kind: edge.kind };
    });

    return {
      schemaVersion: 1,
      name: softwareTeam.softwareTeam.name,
      version: "0.1.0",
      nodes,
      edges,
    };
  }

  private exportPodAware(softwareTeamId: string, softwareTeam: import("./types.js").SoftwareTeamWithRelations): SoftwareTeamSpec {
    const pods = this.podRepo!.getPodsForSoftwareTeam(softwareTeamId);
    const sessions = this.sessionRegistry.getSessionsForSoftwareTeam(softwareTeamId);

    // Build maps for lookups
    // logicalId is "podSpecId.memberLocalId" — extract both parts
    const idToLogical = new Map(softwareTeam.nodes.map((n) => [n.id, n.logicalId]));
    const idToMemberLocal = new Map(softwareTeam.nodes.map((n) => [n.id, n.logicalId.includes(".") ? n.logicalId.split(".").slice(1).join(".") : n.logicalId]));
    const idToNode = new Map(softwareTeam.nodes.map((n) => [n.id, n]));
    const nodeIdToPodId = new Map(softwareTeam.nodes.map((n) => [n.id, n.podId]));

    // Group nodes by podId
    const nodesByPod = new Map<string, typeof softwareTeam.nodes>();
    for (const node of softwareTeam.nodes) {
      if (node.podId) {
        const list = nodesByPod.get(node.podId) ?? [];
        list.push(node);
        nodesByPod.set(node.podId, list);
      }
    }

    // Helper: get restorePolicy for a node
    const getRestorePolicy = (nodeId: string): string | undefined => {
      const nodeSessions = sessions
        .filter((s) => s.nodeId === nodeId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      const latest = nodeSessions.length > 0 ? nodeSessions[nodeSessions.length - 1]! : null;
      return latest?.restorePolicy ?? idToNode.get(nodeId)?.restorePolicy ?? undefined;
    };

    // Build pod specs
    const podSpecs: SoftwareTeamSpecPod[] = pods.map((pod) => {
      const podNodes = nodesByPod.get(pod.id) ?? [];
      const memberNodeIds = new Set(podNodes.map((n) => n.id));

      const members: SoftwareTeamSpecPodMember[] = podNodes.map((node) => {
        if (!node.runtime) {
          throw new Error(`Cannot export node '${node.logicalId}': runtime is required but missing`);
        }
        const member: SoftwareTeamSpecPodMember = {
          id: idToMemberLocal.get(node.id) ?? node.logicalId,
          agentRef: node.agentRef ?? "",
          profile: node.profile ?? "default",
          runtime: node.runtime,
          cwd: node.cwd ?? ".",
        };
        if (node.label) member.label = node.label;
        if (node.codexConfigProfile) member.codexConfigProfile = node.codexConfigProfile;
        if (node.model) member.model = node.model;
        if (node.effort) member.effort = node.effort;
        // OPR.0.4.6.FAC1: a declared seat role exports with the pod
        // member (round-trip fidelity — export→import keeps the role).
        if (node.role) member.role = node.role;
        // OPR.0.4.8.3 Seam B: the seat's RAW permission_policy ref round-trips
        // (export truth = the ref, never the resolved provenance).
        if (node.permissionPolicy) member.permissionPolicy = node.permissionPolicy;
        if (node.env) member.env = node.env;
        if (node.sessionSource) member.sessionSource = node.sessionSource;
        const rp = getRestorePolicy(node.id);
        if (rp) member.restorePolicy = rp;
        return member;
      });

      // Pod-local edges: both endpoints are in this pod
      const podEdges: SoftwareTeamSpecPodEdge[] = softwareTeam.edges
        .filter((e) => memberNodeIds.has(e.sourceId) && memberNodeIds.has(e.targetId))
        .map((e) => ({
          kind: e.kind,
          from: idToMemberLocal.get(e.sourceId)!,
          to: idToMemberLocal.get(e.targetId)!,
        }));

      // Derive pod spec id from the first member's logicalId prefix (e.g., "dev" from "dev.impl")
      const podSpecId = pod.namespace;
      const podSpec: SoftwareTeamSpecPod = {
        id: podSpecId,
        label: pod.label,
        members,
        edges: podEdges,
      };
      if (pod.summary) podSpec.summary = pod.summary;
      if (pod.continuityPolicyJson) {
        try {
          podSpec.continuityPolicy = JSON.parse(pod.continuityPolicyJson);
        } catch { /* skip if invalid JSON */ }
      }
      return podSpec;
    });

    // Cross-pod edges: endpoints in different pods
    // logicalId is already "podSpecId.memberLocalId" — use directly as qualified ref
    const crossPodEdges: SoftwareTeamSpecCrossPodEdge[] = softwareTeam.edges
      .filter((e) => {
        const srcPod = nodeIdToPodId.get(e.sourceId);
        const tgtPod = nodeIdToPodId.get(e.targetId);
        return srcPod && tgtPod && srcPod !== tgtPod;
      })
      .map((e) => ({
        kind: e.kind,
        from: idToLogical.get(e.sourceId)!,
        to: idToLogical.get(e.targetId)!,
      }));

    // OPR.0.4.8.3 Seam B: software-team-level permission_policy is a SOFTWARE_TEAM-ROW field (not derivable
    // from the spec re-emit) — explicit repository read, emitted only when set.
    const softwareTeamPermissionPolicy = this.softwareTeamRepo.getSoftwareTeamPermissionPolicy(softwareTeamId);
    const workspace = this.softwareTeamRepo.getSoftwareTeamWorkspace(softwareTeamId);
    const softwareTeamEnv = this.softwareTeamRepo.getSoftwareTeamEnv(softwareTeamId);
    // #25: the selected Claude managed-block file is also a software-team-row field.
    const claudeManagedBlockFile = this.softwareTeamRepo.getSoftwareTeamClaudeManagedBlockFile(softwareTeamId);

    return {
      version: "0.2",
      name: softwareTeam.softwareTeam.name,
      ...(softwareTeamPermissionPolicy ? { permissionPolicy: softwareTeamPermissionPolicy } : {}),
      ...(this.softwareTeamRepo.getSoftwareTeamNonInterruptive(softwareTeamId) ? { nonInterruptive: true } : {}),
      ...(softwareTeamEnv ? { env: softwareTeamEnv } : {}),
      ...(claudeManagedBlockFile ? { managedBlocks: { "claude-code": claudeManagedBlockFile } } : {}),
      ...(workspace ? { workspace } : {}),
      pods: podSpecs,
      edges: crossPodEdges,
    };
  }
}
