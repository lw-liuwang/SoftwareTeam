import nodePath from "node:path";
import { effortPrecedence, readSeatEffort } from "./seat-effort.js";
import type Database from "better-sqlite3";
import {
  resolvePermissionPolicyAttachment,
  resolvePermissionPolicyRefValue,
  type ResolvedPolicyAttachment,
} from "./permission-policy/policy-ref.js";
import type { SoftwareTeamRepository } from "./software-team-repository.js";
import { checkRunningNameGuard, confirmStoppedGenerations, makeRunningSessionCounter } from "./running-name-guard.js";
import type { SessionRegistry } from "./session-registry.js";
import type { EventBus } from "./event-bus.js";
import type { NodeLauncher } from "./node-launcher.js";
import type { PreflightSpecContext, SoftwareTeamSpecPreflight } from "./software-team-spec-preflight.js";
import { deriveCanonicalSessionName, validateSessionComponents } from "./session-name.js";
import { LegacySoftwareTeamSpecSchema as SoftwareTeamSpecSchema } from "./software-team-spec-schema.js"; // TODO: AS-T08b — migrate to pod-aware SoftwareTeamSpec
import { LegacySoftwareTeamSpecCodec as SoftwareTeamSpecCodec } from "./software-team-spec-codec.js"; // TODO: AS-T08b — migrate to pod-aware SoftwareTeamSpec
import type { LegacySoftwareTeamSpec as SoftwareTeamSpec, LegacySoftwareTeamSpecEdge as SoftwareTeamSpecEdge, InstantiateOutcome, InstantiateResult } from "./types.js"; // TODO: AS-T08b — migrate to pod-aware SoftwareTeamSpec
import { resolveLaunchCwd } from "./cwd-resolution.js";

// Only these edge kinds constrain launch order
const LAUNCH_DEPENDENCY_KINDS = new Set(["delegates_to", "spawned_by"]);

interface SoftwareTeamInstantiatorDeps {
  db: Database.Database;
  softwareTeamRepo: SoftwareTeamRepository;
  sessionRegistry: SessionRegistry;
  eventBus: EventBus;
  nodeLauncher: NodeLauncher;
  preflight: SoftwareTeamSpecPreflight;
  tmuxAdapter?: import("../adapters/tmux.js").TmuxAdapter;
}

export class SoftwareTeamInstantiator {
  readonly db: Database.Database;
  private softwareTeamRepo: SoftwareTeamRepository;
  private sessionRegistry: SessionRegistry;
  private eventBus: EventBus;
  private nodeLauncher: NodeLauncher;
  private preflight: SoftwareTeamSpecPreflight;
  private tmuxAdapter?: import("../adapters/tmux.js").TmuxAdapter;

  constructor(deps: SoftwareTeamInstantiatorDeps) {
    if (deps.db !== deps.softwareTeamRepo.db) {
      throw new Error("SoftwareTeamInstantiator: softwareTeamRepo must share the same db handle");
    }
    if (deps.db !== deps.sessionRegistry.db) {
      throw new Error("SoftwareTeamInstantiator: sessionRegistry must share the same db handle");
    }
    if (deps.db !== deps.eventBus.db) {
      throw new Error("SoftwareTeamInstantiator: eventBus must share the same db handle");
    }
    if (deps.db !== deps.nodeLauncher.db) {
      throw new Error("SoftwareTeamInstantiator: nodeLauncher must share the same db handle");
    }
    if (deps.db !== deps.preflight.db) {
      throw new Error("SoftwareTeamInstantiator: preflight must share the same db handle");
    }

    this.db = deps.db;
    this.softwareTeamRepo = deps.softwareTeamRepo;
    this.sessionRegistry = deps.sessionRegistry;
    this.eventBus = deps.eventBus;
    this.nodeLauncher = deps.nodeLauncher;
    this.preflight = deps.preflight;
    this.tmuxAdapter = deps.tmuxAdapter;
  }

  async instantiate(spec: SoftwareTeamSpec, opts?: { nonInterruptive?: boolean }): Promise<InstantiateOutcome> {
    // 1. Validate
    const raw = SoftwareTeamSpecCodec.parse(SoftwareTeamSpecCodec.serialize(spec));
    const validation = SoftwareTeamSpecSchema.validate(raw);
    if (!validation.valid) {
      return { ok: false, code: "validation_failed", errors: validation.errors };
    }

    // 1b. S5b running-name guard (OPR.0.5.4.11) — the ONE guard shared by every
    // instantiator create path, before any preflight/create/launch spend. A
    // RUNNING same-name softwareTeam gets the teaching refusal (preflight's blunt
    // name-exists check downstream still owns the all-stopped case on this path).
    const nameGuard = checkRunningNameGuard({
      findSoftwareTeamsByName: (n) => this.softwareTeamRepo.findSoftwareTeamsByName(n),
      countRunningSessions: makeRunningSessionCounter(this.db),
    }, spec.name);
    if (!nameGuard.ok) return nameGuard;

    // 2. Preflight
    const preflightResult = await this.preflight.check(spec);
    if (!preflightResult.ready) {
      return { ok: false, code: "preflight_failed", errors: preflightResult.errors, warnings: preflightResult.warnings };
    }

    // 3. Compute launch order BEFORE materialization (detect cycles early)
    let launchOrder: string[];
    try {
      launchOrder = this.computeLaunchOrder(spec);
    } catch (err) {
      return {
        ok: false,
        code: "instantiate_error",
        message: err instanceof Error ? err.message : String(err),
      };
    }

    // 4. Atomic DB materialization: softwareTeam + nodes + edges
    let softwareTeamId: string;
    const nodeIdMap: Record<string, string> = {}; // logicalId -> DB id
    try {
      const txn = this.db.transaction(() => {
        const softwareTeam = this.softwareTeamRepo.createSoftwareTeam(spec.name);
        softwareTeamId = softwareTeam.id;
        if (opts?.nonInterruptive !== undefined) this.softwareTeamRepo.setSoftwareTeamNonInterruptive(softwareTeam.id, opts.nonInterruptive);

        for (const specNode of spec.nodes) {
          const node = this.softwareTeamRepo.addNode(softwareTeam.id, specNode.id, {
            role: specNode.role,
            runtime: specNode.runtime,
            model: specNode.model,
            effort: specNode.effort,
            cwd: specNode.cwd,
            surfaceHint: specNode.surfaceHint,
            workspace: specNode.workspace,
            restorePolicy: specNode.restorePolicy,
            packageRefs: specNode.packageRefs,
          });
          nodeIdMap[specNode.id] = node.id;
        }

        for (const specEdge of spec.edges) {
          this.softwareTeamRepo.addEdge(
            softwareTeam.id,
            nodeIdMap[specEdge.from]!,
            nodeIdMap[specEdge.to]!,
            specEdge.kind
          );
        }
      });
      txn();
    } catch (err) {
      return {
        ok: false,
        code: "instantiate_error",
        message: err instanceof Error ? err.message : String(err),
      };
    }

    // 5. Launch nodes in topological order
    const nodeResults: { logicalId: string; status: "launched" | "failed"; error?: string }[] = [];
    const launchedSessionNames: string[] = [];
    const instantiateWarnings: string[] = [];

    for (const logicalId of launchOrder) {
      const result = await this.nodeLauncher.launchNode(softwareTeamId!, logicalId);
      if (result.ok) {
        nodeResults.push({ logicalId, status: "launched" });
        launchedSessionNames.push(result.sessionName);
        if (result.warnings?.length) {
          instantiateWarnings.push(...result.warnings);
        }
      } else {
        nodeResults.push({ logicalId, status: "failed", error: result.message });
      }
    }

    // Check for total launch failure — kill orphan sessions and clean up the softwareTeam
    const allFailed = nodeResults.every((n) => n.status === "failed");
    if (allFailed && nodeResults.length > 0) {
      const cleanup = async () => {
        if (this.tmuxAdapter) {
          for (const sessionName of launchedSessionNames) {
            const stopped = await this.tmuxAdapter.killSession(sessionName);
            if (!stopped.ok) return; // Preserve custody when termination was refused/unverified.
          }
        }
        this.softwareTeamRepo.deleteSoftwareTeam(softwareTeamId!);
      };
      const guard = this.tmuxAdapter?.deliveryGuard;
      if (guard) await guard.lifecycle(Object.values(nodeIdMap), cleanup);
      else await cleanup();
      return {
        ok: false,
        code: "instantiate_error",
        message: "all node launches failed",
      };
    }

    // 6. Propagate restorePolicy to session metadata (best-effort)
    try {
      for (const specNode of spec.nodes) {
        const restorePolicy = specNode.restorePolicy ?? "resume_if_possible";
        const sessions = this.sessionRegistry.getSessionsForSoftwareTeam(softwareTeamId!);
        const nodeDbId = nodeIdMap[specNode.id];
        const session = sessions.find((s) => s.nodeId === nodeDbId);
        if (session) {
          this.db.prepare("UPDATE sessions SET restore_policy = ? WHERE id = ?")
            .run(restorePolicy, session.id);
        }
      }
    } catch {
      // Best-effort: import succeeded even if restorePolicy propagation fails
    }

    // 6. Emit softwareTeam.imported (best-effort)
    try {
      this.eventBus.emit({
        type: "topology.roster_recorded",
        softwareTeamId: softwareTeamId!,
        intendedNodeIds: Object.values(nodeIdMap),
        source: "materialized_topology",
      });
      this.eventBus.emit({
        type: "softwareTeam.imported",
        softwareTeamId: softwareTeamId!,
        specName: spec.name,
        specVersion: spec.version,
      });
    } catch {
      // Best-effort: import succeeded even if event persistence fails
    }

    return {
      ok: true,
      result: {
        softwareTeamId: softwareTeamId!,
        specName: spec.name,
        specVersion: spec.version,
        nodes: nodeResults,
        warnings: instantiateWarnings.length > 0 ? instantiateWarnings : undefined,
      },
    };
  }

  private computeLaunchOrder(spec: SoftwareTeamSpec): string[] {
    const nodes = spec.nodes;
    const edges = spec.edges;

    const inDegree: Record<string, number> = {};
    const adjacency: Record<string, string[]> = {};

    for (const node of nodes) {
      inDegree[node.id] = 0;
      adjacency[node.id] = [];
    }

    for (const edge of edges) {
      if (!LAUNCH_DEPENDENCY_KINDS.has(edge.kind)) continue;

      let from: string;
      let to: string;

      if (edge.kind === "delegates_to") {
        from = edge.from;
        to = edge.to;
      } else {
        // spawned_by: target (parent) before source (child)
        from = edge.to;
        to = edge.from;
      }

      if (adjacency[from]) {
        adjacency[from]!.push(to);
        inDegree[to] = (inDegree[to] ?? 0) + 1;
      }
    }

    // Topological sort with alphabetical tiebreaker
    const queue = Object.keys(inDegree)
      .filter((id) => inDegree[id] === 0)
      .sort();

    const order: string[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      order.push(current);

      const neighbors = (adjacency[current] ?? []).slice().sort();
      for (const neighbor of neighbors) {
        inDegree[neighbor] = (inDegree[neighbor] ?? 1) - 1;
        if ((inDegree[neighbor] ?? 0) === 0) {
          // Insert sorted
          let inserted = false;
          for (let i = 0; i < queue.length; i++) {
            if (queue[i]!.localeCompare(neighbor) > 0) {
              queue.splice(i, 0, neighbor);
              inserted = true;
              break;
            }
          }
          if (!inserted) queue.push(neighbor);
        }
      }
    }

    // Cycle detection: if not all nodes reached, there's a cycle
    if (order.length !== nodes.length) {
      const missing = nodes.filter((n) => !order.includes(n.id)).map((n) => n.id);
      throw new Error(`Dependency cycle detected among nodes: ${missing.join(", ")}`);
    }

    return order;
  }
}

// -- Pod-aware instantiator (AgentSpec reboot) --

import { SoftwareTeamSpecCodec as PodSoftwareTeamSpecCodec } from "./software-team-spec-codec.js";
import { SoftwareTeamSpecSchema as PodSoftwareTeamSpecSchema, VALID_EDGE_KINDS } from "./software-team-spec-schema.js";
import { softwareTeamPreflight, preflightValidatedSpec } from "./software-team-spec-preflight.js";
import { resolveAgentRef, type AgentResolverFsOps } from "./agent-resolver.js";
import { resolveNodeConfig, selectedPluginPaths } from "./profile-resolver.js";
import { resolveStartup } from "./startup-resolver.js";
import { planProjection, claudeConflictTargetPath, projectionConflictWarnings, filterProtectedProjections, type ProjectionPlan } from "./projection-planner.js";
import { ProjectionManifestStore } from "./projection-manifest-store.js";
import { StartupOrchestrator } from "./startup-orchestrator.js";
import { PodRepository } from "./pod-repository.js";
import type { SoftwareTeamSpec as PodSoftwareTeamSpec, SoftwareTeamSpecPod, SoftwareTeamSpecPodMember, StartupAction, StartupFile } from "./types.js";
import type { RuntimeAdapter, NodeBinding, ResolvedStartupFile } from "./runtime-adapter.js";
import { resolveConcreteHint } from "./runtime-adapter.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import { installTopologyDefaults } from "./topology-defaults-installer.js";
import type {
  CompactionStrategy,
  ContinuityPolicyMaterializer,
} from "./continuity-policy-materializer.js";
import { isKeptPluginSkill, type ReconcileSkillLoadoutResult, type SkillLoadout, type SkillRuntime } from "./skill-catalog.js";
import type { SystemWorldResolution } from "./system-world.js";
import type { SeatEnv } from "./seat-env.js";

function defaultCultureStartupFile(): ResolvedStartupFile {
  const assetsRoot = nodePath.resolve(import.meta.dirname, "../../assets");
  return {
    path: "CULTURE-default.md",
    absolutePath: nodePath.join(assetsRoot, "guidance/CULTURE-default.md"),
    ownerRoot: assetsRoot,
    deliveryHint: "guidance_merge",
    required: true,
    appliesOn: ["fresh_start", "restore"],
  };
}

interface PodInstantiatorDeps {
  db: Database.Database;
  softwareTeamRepo: SoftwareTeamRepository;
  podRepo: PodRepository;
  sessionRegistry: SessionRegistry;
  eventBus: EventBus;
  nodeLauncher: NodeLauncher;
  startupOrchestrator: StartupOrchestrator;
  fsOps: AgentResolverFsOps;
  /** §6 reconciliation: main's managed Claude activity-hook delivery asset paths, forwarded to
   *  preflight (defaults to daemon-shipped assets; tests inject fixtures). Restores main's proven
   *  threading, dropped when the restacked 4.8 instantiator won the warnings-site conflicts. */
  claudeActivityAssets?: { relayPath?: string; manifestPath?: string };
  adapters: Record<string, RuntimeAdapter>;
  tmuxAdapter?: TmuxAdapter;
  /** PL-016 Item 4: optional agent-image library so AgentSpec
   *  session_source: mode: agent_image entries can resolve to the
   *  image's resume token. Optional — when absent, agent_image session
   *  source surfaces a structured error at instantiation time. */
  agentImageLibrary?: import("./agent-images/agent-image-library-service.js").AgentImageLibraryService;
  exec?: (cmd: string) => Promise<string>;
  /** OPR.0.5.3.6 — resolves the typed topology.root so a spec's shipped
   *  `topology/` chain-file defaults install at materialization (copy-if-absent,
   *  best-effort). Absent → no defaults install (tests, legacy composition). */
  topologyRootResolver?: () => string;
  /** S15 — whether new seats receive the compact default mental-model pack.
   *  Resolved at materialization so config changes affect future launches. */
  onboardingEnabledResolver?: () => boolean;
  /** S04 — live config resolver for the authoritative managed skill catalog. */
  skillsRootResolver?: () => string;
  /** S05 — selected System World. Resolution failures refuse preflight/launch
   *  rather than falling back to a different system selector. */
  systemWorldResolver?: () => SystemWorldResolution;
  /** S04 — exact-byte catalog projection before a harness starts. Optional
   *  for old tests/embedders; production wires the shared reconciler. */
  skillReconciler?: (input: {
    loadout: SkillLoadout;
    runtime: SkillRuntime;
    cwd: string;
    apply: true;
    topologyOwner?: string;
  }) => ReconcileSkillLoadoutResult;
  /** S20 P4 — materializes the selected Claude continuity policy by
   *  registering jobs in the existing watchdog engine after startup succeeds. */
  continuityPolicyMaterializer?: Pick<ContinuityPolicyMaterializer, "arm">;
}

export interface MaterializeResult {
  softwareTeamId: string;
  specName: string;
  specVersion: string;
  nodes: Array<{ logicalId: string; status: "materialized" }>;
  warnings?: string[];
}

export type MaterializeOutcome =
  | { ok: true; result: MaterializeResult }
  | { ok: false; code: "validation_failed"; errors: string[] }
  | { ok: false; code: "preflight_failed"; errors: string[]; warnings: string[] }
  | { ok: false; code: "target_software_team_not_found"; message: string }
  | { ok: false; code: "materialize_conflict"; message: string }
  | { ok: false; code: "materialize_error"; message: string }
  // S5b (OPR.0.5.4.11) — running-name guard refusal on the CREATE branch only
  // (expand/add_member pass targetSoftwareTeamId and are never guarded here).
  | { ok: false; code: "software_team_name_running"; message: string; runningSoftwareTeam: { id: string; name: string; runningSessionCount: number } };

export interface LaunchMaterializedNodeResult {
  logicalId: string;
  nodeId: string;
  status: "launched" | "failed" | "attention_required";
  error?: string;
  sessionName?: string;
}

export type LaunchMaterializedOutcome =
  | { ok: true; result: { nodes: LaunchMaterializedNodeResult[]; warnings?: string[] } }
  | { ok: false; code: "validation_failed"; errors: string[] }
  | { ok: false; code: "target_software_team_not_found"; message: string };

/** A pod-local edge declared alongside an added member (from/to are member ids
 *  within the pod; resolved against the new member + existing pod-mates). */
export interface AddMemberEdge {
  from: string;
  to: string;
  kind: string;
}

export interface AddMemberResult {
  podId: string;
  podNamespace: string;
  node: {
    logicalId: string;
    nodeId: string;
    status: "launched" | "failed" | "attention_required";
    error?: string;
    sessionName?: string;
  };
  /** Pod-local edges persisted with the add (empty when none declared). The
   *  endpoints are qualified logical ids. Edges carry no runtime behavior yet
   *  (OPR.0.3.3.24 fence) - they record declared topology intent. */
  edges: Array<{ from: string; to: string; kind: string }>;
  warnings?: string[];
}

/**
 * Outcome of the `add_member` converge op (OPR.0.3.3.24). Mirrors the
 * MaterializeOutcome error vocabulary where it overlaps (validation_failed /
 * preflight_failed) and adds the add-member-specific honest codes
 * (software_team_not_found / pod_not_found / member_conflict / edge_unresolved). Every
 * failure carries a human-actionable message or error list (the 3-part
 * honest-error contract that the converge interface surfaces to CLI + MCP).
 */
export type AddMemberOutcome =
  | { ok: true; result: AddMemberResult }
  | { ok: false; code: "software_team_not_found"; message: string }
  | { ok: false; code: "pod_not_found"; message: string }
  | { ok: false; code: "member_conflict"; message: string }
  | { ok: false; code: "edge_unresolved"; message: string }
  | { ok: false; code: "materialize_error"; message: string }
  | { ok: false; code: "validation_failed"; errors: string[] }
  | { ok: false; code: "preflight_failed"; errors: string[]; warnings: string[] };

/**
 * Pod-aware softwareTeam instantiator. Creates pods, nodes, edges, and runs
 * startup orchestration per node with resolved agent specs.
 */
/** #141: softwareTeam names with a YAML import in progress, per daemon database. */
const importsInFlight = new WeakMap<Database.Database, Set<string>>();

/** #141: the same-name softwareTeams changed between the stopped check and the create transaction. */
class GenerationChanged extends Error {
  constructor(name: string) {
    super(`The softwareTeams named "${name}" changed while this import was checking them. Nothing was created; retry the import.`);
  }
}

export class PodSoftwareTeamInstantiator {
  readonly db: Database.Database;
  private deps: PodInstantiatorDeps;

  constructor(deps: PodInstantiatorDeps) {
    if (deps.db !== deps.softwareTeamRepo.db) throw new Error("PodSoftwareTeamInstantiator: softwareTeamRepo must share the same db handle");
    if (deps.db !== deps.sessionRegistry.db) throw new Error("PodSoftwareTeamInstantiator: sessionRegistry must share the same db handle");
    if (deps.db !== deps.eventBus.db) throw new Error("PodSoftwareTeamInstantiator: eventBus must share the same db handle");
    if (deps.db !== deps.nodeLauncher.db) throw new Error("PodSoftwareTeamInstantiator: nodeLauncher must share the same db handle");
    this.db = deps.db;
    this.deps = deps;
  }

  /** One configured catalog root for preflight, materialization, and launch. */
  resolveSkillsRoot(): string | undefined {
    return this.deps.skillsRootResolver?.();
  }

  private systemWorldResolutionContext(): { systemSkills?: string[]; systemWorldError?: string } {
    const resolution = this.deps.systemWorldResolver?.();
    if (!resolution) return {};
    if (!resolution.ok) return { systemWorldError: resolution.error.message };
    return { systemSkills: resolution.manifest?.skills ?? [] };
  }

  private inheritedPermissionPolicy(targetSoftwareTeamId: string | undefined): PreflightSpecContext["inheritedPermissionPolicy"] {
    if (!targetSoftwareTeamId) return undefined;
    const provenance = this.deps.softwareTeamRepo.getSoftwareTeamPolicyProvenance(targetSoftwareTeamId);
    if (!provenance?.softwareTeamRef) return undefined;
    return {
      ref: provenance.softwareTeamRef,
      origin: provenance.origin,
      launchPosture: provenance.launchPosture,
      ...(provenance.resolvedTarget ? { resolvedTarget: provenance.resolvedTarget } : {}),
      ...(provenance.declaringDir ? { declaringDir: provenance.declaringDir } : {}),
    };
  }

  async materialize(
    softwareTeamSpecYaml: string,
    softwareTeamRoot: string,
    opts?: { targetSoftwareTeamId?: string; suppressSummaryEvent?: boolean; cwdOverride?: string },
  ): Promise<MaterializeOutcome> {
    let raw: unknown;
    try {
      raw = PodSoftwareTeamSpecCodec.parse(softwareTeamSpecYaml);
    } catch (err) {
      return { ok: false, code: "validation_failed", errors: [(err as Error).message] };
    }

    const targetSoftwareTeam = opts?.targetSoftwareTeamId ? this.deps.softwareTeamRepo.getSoftwareTeam(opts.targetSoftwareTeamId) : null;
    if (opts?.targetSoftwareTeamId && !targetSoftwareTeam) {
      return { ok: false, code: "target_software_team_not_found", message: `SoftwareTeam "${opts.targetSoftwareTeamId}" not found` };
    }

    const validation = PodSoftwareTeamSpecSchema.validate(raw, {
      externalQualifiedIds: targetSoftwareTeam?.nodes.map((node) => node.logicalId),
    });
    if (!validation.valid) {
      return { ok: false, code: "validation_failed", errors: validation.errors };
    }

    const softwareTeamSpec = PodSoftwareTeamSpecSchema.normalize(raw as Record<string, unknown>);
    const preflight = await softwareTeamPreflight({
      softwareTeamSpecYaml,
      softwareTeamRoot,
      cwdOverride: opts?.cwdOverride,
      fsOps: this.deps.fsOps,
      skillsRoot: this.resolveSkillsRoot(),
      ...this.systemWorldResolutionContext(),
      softwareTeamNameOverride: targetSoftwareTeam?.softwareTeam.name,
      externalQualifiedIds: targetSoftwareTeam?.nodes.map((node) => node.logicalId),
      inheritedPermissionPolicy: this.inheritedPermissionPolicy(opts?.targetSoftwareTeamId),
      exec: this.deps.exec,
      claudeActivityAssets: this.deps.claudeActivityAssets, // §6: restore main's activity-hook asset threading
    });
    if (!preflight.ready) {
      return { ok: false, code: "preflight_failed", errors: preflight.errors, warnings: preflight.warnings };
    }

    // OPR.0.3.3.24: parse/validate/preflight is the separable FRONT-END; the
    // persistence CORE (createPod + create-node + edges + events, in one tx)
    // takes the already-parsed+validated spec so `expand` and the `add_member`
    // converge op compose it WITHOUT fabricating a synthetic softwareTeam spec.
    return this.materializeValidatedSpec(softwareTeamSpec, softwareTeamRoot, preflight.warnings, opts);
  }

  /**
   * materialize with a STRUCTURED front (OPR.0.3.3.24): the YAML-free sibling of
   * materialize(). Runs the SAME front-end (validate + preflight, via the
   * preflight CORE using this adapter's fsOps) on an already-built raw spec
   * OBJECT, then the persistence core - so `expand` (and the add_member op) drop
   * the synthetic-spec YAML round-trip. Byte-identical to materialize(yaml): same
   * validate(externalQualifiedIds), same preflight checks, same MaterializeOutcome
   * error codes (validation_failed / preflight_failed / target_software_team_not_found /
   * materialize_conflict). fsOps stays encapsulated here (the expansion service
   * has none) - this wrapper is mechanics only, no behaviour/layering change.
   */
  async materializeStructured(
    raw: unknown,
    softwareTeamRoot: string,
    opts?: { targetSoftwareTeamId?: string; suppressSummaryEvent?: boolean; cwdOverride?: string },
  ): Promise<MaterializeOutcome> {
    const targetSoftwareTeam = opts?.targetSoftwareTeamId ? this.deps.softwareTeamRepo.getSoftwareTeam(opts.targetSoftwareTeamId) : null;
    if (opts?.targetSoftwareTeamId && !targetSoftwareTeam) {
      return { ok: false, code: "target_software_team_not_found", message: `SoftwareTeam "${opts.targetSoftwareTeamId}" not found` };
    }

    const validation = PodSoftwareTeamSpecSchema.validate(raw, {
      externalQualifiedIds: targetSoftwareTeam?.nodes.map((node) => node.logicalId),
    });
    if (!validation.valid) {
      return { ok: false, code: "validation_failed", errors: validation.errors };
    }

    const softwareTeamSpec = PodSoftwareTeamSpecSchema.normalize(raw as Record<string, unknown>);
    const preflight = await preflightValidatedSpec(softwareTeamSpec, {
      softwareTeamRoot,
      cwdOverride: opts?.cwdOverride,
      fsOps: this.deps.fsOps,
      skillsRoot: this.resolveSkillsRoot(),
      ...this.systemWorldResolutionContext(),
      softwareTeamNameOverride: targetSoftwareTeam?.softwareTeam.name,
      inheritedPermissionPolicy: this.inheritedPermissionPolicy(opts?.targetSoftwareTeamId),
      exec: this.deps.exec,
      claudeActivityAssets: this.deps.claudeActivityAssets, // §6: restore main's activity-hook asset threading
    });
    if (!preflight.ready) {
      return { ok: false, code: "preflight_failed", errors: preflight.errors, warnings: preflight.warnings };
    }

    return this.materializeValidatedSpec(softwareTeamSpec, softwareTeamRoot, preflight.warnings, opts);
  }

  /**
   * materialize CORE (OPR.0.3.3.24): the persistence body of materialize, taking
   * an already-parsed + validated + preflighted PodSoftwareTeamSpec. Creates pods +
   * member nodes (via the create-node primitive) + edges + events in one
   * transaction. Parse/validate/preflight is the caller's separable front-end
   * (materialize() for YAML; expand/add_member build + validate a structured
   * spec). This is the cut that lets `expand` drop its synthetic-spec hack and
   * `add_member` reuse the exact create path — create+launch only, no identity
   * migration.
   */
  async materializeValidatedSpec(
    softwareTeamSpec: PodSoftwareTeamSpec,
    softwareTeamRoot: string,
    preflightWarnings: string[],
    opts?: {
      targetSoftwareTeamId?: string;
      suppressSummaryEvent?: boolean;
      cwdOverride?: string;
      /** S9: ordinary member growth targets this already-persisted pod. */
      existingPodNamespace?: string;
    },
  ): Promise<MaterializeOutcome> {
    const persistedEvents: Array<ReturnType<EventBus["persistWithinTransaction"]>> = [];
    const nodeResults: Array<{ logicalId: string; status: "materialized" }> = [];

    // S5b running-name guard (OPR.0.5.4.11) — CREATE branch only: an expansion
    // (targetSoftwareTeamId) adds to an existing softwareTeam and never mints a name, so the
    // guard must not fire there.
    if (!opts?.targetSoftwareTeamId) {
      const nameGuard = checkRunningNameGuard({
        findSoftwareTeamsByName: (n) => this.deps.softwareTeamRepo.findSoftwareTeamsByName(n),
        countRunningSessions: makeRunningSessionCounter(this.db),
      }, softwareTeamSpec.name);
      if (!nameGuard.ok) return nameGuard;
    }

    try {
      let materializedSoftwareTeamId = opts?.targetSoftwareTeamId ?? "";
      const tx = this.db.transaction(() => {
        if (!materializedSoftwareTeamId) {
          const softwareTeam = this.deps.softwareTeamRepo.createSoftwareTeam(softwareTeamSpec.name);
          materializedSoftwareTeamId = softwareTeam.id;
          persistedEvents.push(this.deps.eventBus.persistWithinTransaction({ type: "software-team.created", softwareTeamId: materializedSoftwareTeamId }));
        }

        // PL-007: persist the softwareTeam's typed workspace block when declared.
        if (softwareTeamSpec.workspace) {
          this.deps.softwareTeamRepo.setSoftwareTeamWorkspace(materializedSoftwareTeamId, softwareTeamSpec.workspace);
        }
        // #25: the Claude managed-block destination is software-team-row state (both persist sites).
        if (softwareTeamSpec.managedBlocks?.["claude-code"]) {
          this.deps.softwareTeamRepo.setSoftwareTeamClaudeManagedBlockFile(materializedSoftwareTeamId, softwareTeamSpec.managedBlocks["claude-code"]);
        }

        // OPR.0.4.8.3 Seam B: persist the software-team-level permission_policy REF (raw, like role) —
        // this is ONE of TWO software-team-persist sites (materializeValidatedSpec + instantiate); missing
        // either drops the softwareTeam ref on that path (map correction, independently verified).
        // Guard-F1: the RESOLVED softwareTeam attachment persists too (declaringDir = THIS softwareTeamRoot,
        // the original declaring SoftwareTeamSpec dir) — restart-complete for organic seats,
        // add-member under a different root, and successor continuity. STRICT (load-bearing).
        if (softwareTeamSpec.env) this.deps.softwareTeamRepo.setSoftwareTeamEnv(materializedSoftwareTeamId, softwareTeamSpec.env);
        if (softwareTeamSpec.permissionPolicy) {
          this.deps.softwareTeamRepo.setSoftwareTeamPermissionPolicy(materializedSoftwareTeamId, softwareTeamSpec.permissionPolicy);
          const softwareTeamAttachment = resolvePermissionPolicyAttachment(softwareTeamSpec.permissionPolicy, softwareTeamRoot, {
            readFile: (p) => this.deps.fsOps.readFile(p),
          });
          this.deps.softwareTeamRepo.setSoftwareTeamPolicyProvenance(materializedSoftwareTeamId, {
            origin: softwareTeamAttachment.origin,
            resolvedTarget: softwareTeamAttachment.resolvedTarget ?? null,
            declaringDir: softwareTeamAttachment.origin === "custom" ? softwareTeamRoot : null,
            launchPosture: softwareTeamAttachment.launchPosture,
          });
        }

        const currentSoftwareTeam = this.deps.softwareTeamRepo.getSoftwareTeam(materializedSoftwareTeamId)!;
        const logicalIdToNodeId = new Map(currentSoftwareTeam.nodes.map((node) => [node.logicalId, node.id]));
        const existingPodIds = new Set(
          currentSoftwareTeam.nodes
            .map((node) => node.logicalId.includes(".") ? node.logicalId.split(".")[0]! : null)
            .filter((value): value is string => value !== null),
        );

        for (const pod of softwareTeamSpec.pods) {
          if (existingPodIds.has(pod.id) && opts?.existingPodNamespace !== pod.id) {
            throw { code: "materialize_conflict", message: `Pod id '${pod.id}' already exists in softwareTeam '${currentSoftwareTeam.softwareTeam.name}'` };
          }
          for (const member of pod.members) {
            const qualifiedId = `${pod.id}.${member.id}`;
            if (logicalIdToNodeId.has(qualifiedId)) {
              throw { code: "materialize_conflict", message: `Logical ID '${qualifiedId}' already exists in softwareTeam '${currentSoftwareTeam.softwareTeam.name}'` };
            }
          }
        }

        const podIdMap: Record<string, string> = {};
        for (const pod of softwareTeamSpec.pods) {
          const existingPod = opts?.existingPodNamespace === pod.id
            ? this.deps.podRepo.getPodByNamespace(materializedSoftwareTeamId, pod.id)
            : null;
          if (opts?.existingPodNamespace === pod.id && !existingPod) {
            throw { code: "materialize_conflict", message: `Existing pod '${pod.id}' not found in softwareTeam '${currentSoftwareTeam.softwareTeam.name}'` };
          }
          const podRecord = existingPod ?? this.deps.podRepo.createPod(
            materializedSoftwareTeamId,
            pod.id,
            pod.label,
            {
              summary: pod.summary,
              continuityPolicyJson: pod.continuityPolicy ? JSON.stringify(pod.continuityPolicy) : undefined,
            },
          );
          podIdMap[pod.id] = podRecord.id;
          if (!existingPod) {
            persistedEvents.push(this.deps.eventBus.persistWithinTransaction({
              type: "pod.created",
              softwareTeamId: materializedSoftwareTeamId,
              podId: podRecord.id,
              namespace: podRecord.namespace,
              label: pod.label,
            }));
          }

          for (const member of pod.members) {
            const qualifiedId = `${pod.id}.${member.id}`;
            const { node, event } = this.createMemberNode({
              softwareTeamId: materializedSoftwareTeamId,
              qualifiedId,
              member,
              podId: podRecord.id,
              softwareTeamRoot,
              cwdOverride: opts?.cwdOverride,
            });
            logicalIdToNodeId.set(qualifiedId, node.id);
            // Seam B R2: restart-stable provenance persists AT MATERIALIZE (a
            // materialized-but-never-launched seat must still restore its posture).
            // R2 HIGH-1: expansion into an EXISTING softwareTeam materializes through a SYNTHETIC
            // fragment with no software-team-level ref — a ref-less member must inherit the
            // PERSISTED target-softwareTeam attachment (original declaring dir), never lose it.
            const materializeAttachment = this.resolveMemberPolicyAttachment(member.permissionPolicy, softwareTeamSpec.permissionPolicy, softwareTeamRoot);
            if (materializeAttachment) {
              this.persistNodePolicyProvenanceStrict(node.id, materializeAttachment);
            } else if (opts?.targetSoftwareTeamId) {
              const softwareTeamProv = this.deps.softwareTeamRepo.getSoftwareTeamPolicyProvenance(materializedSoftwareTeamId);
              if (softwareTeamProv) {
                this.deps.softwareTeamRepo.setNodePolicyProvenance(node.id, {
                  origin: softwareTeamProv.origin,
                  resolvedTarget: softwareTeamProv.resolvedTarget,
                  declaringDir: softwareTeamProv.declaringDir,
                  launchPosture: softwareTeamProv.launchPosture,
                });
              }
            }
            nodeResults.push({ logicalId: qualifiedId, status: "materialized" });
            persistedEvents.push(event);
          }
        }

        for (const pod of softwareTeamSpec.pods) {
          for (const edge of pod.edges) {
            const fromId = logicalIdToNodeId.get(`${pod.id}.${edge.from}`);
            const toId = logicalIdToNodeId.get(`${pod.id}.${edge.to}`);
            if (!fromId || !toId) {
              throw { code: "materialize_conflict", message: `Pod-local edge references missing node: ${pod.id}.${edge.from} -> ${pod.id}.${edge.to}` };
            }
            this.deps.softwareTeamRepo.addEdge(materializedSoftwareTeamId, fromId, toId, edge.kind);
          }
        }

        for (const edge of softwareTeamSpec.edges) {
          const fromId = logicalIdToNodeId.get(edge.from);
          const toId = logicalIdToNodeId.get(edge.to);
          if (!fromId || !toId) {
            throw { code: "materialize_conflict", message: `Cross-pod edge references missing node: ${edge.from} -> ${edge.to}` };
          }
          this.deps.softwareTeamRepo.addEdge(materializedSoftwareTeamId, fromId, toId, edge.kind);
        }

        persistedEvents.push(this.deps.eventBus.persistWithinTransaction({
          type: "topology.roster_recorded",
          softwareTeamId: materializedSoftwareTeamId,
          intendedNodeIds: [...logicalIdToNodeId.values()],
          source: "materialized_topology",
        }));

        if (!opts?.suppressSummaryEvent) {
          persistedEvents.push(this.deps.eventBus.persistWithinTransaction({
            type: "softwareTeam.imported",
            softwareTeamId: materializedSoftwareTeamId,
            specName: softwareTeamSpec.name,
            specVersion: softwareTeamSpec.version,
          }));
        }
      });

      tx();
      for (const event of persistedEvents) {
        this.deps.eventBus.notifySubscribers(event);
      }

      // OPR.0.5.3.6 — install the spec's shipped topology chain-file defaults
      // under topology.root (copy-if-absent: earned context is never
      // overwritten). Best-effort AFTER the persistence tx: a softwareTeam never fails
      // to materialize over a defaults copy, but failures are surfaced as
      // named warnings, never swallowed.
      if (this.deps.topologyRootResolver && !opts?.existingPodNamespace) {
        const defaults = installTopologyDefaults({
          specDir: softwareTeamRoot,
          softwareTeamName: softwareTeamSpec.name,
          podIds: softwareTeamSpec.pods.map((pod) => pod.id),
          topologyRoot: this.deps.topologyRootResolver(),
        });
        for (const f of defaults.failed) {
          preflightWarnings.push(`topology-defaults: could not install ${f.path}: ${f.error}`);
        }
      }

      return {
        ok: true,
        result: {
          softwareTeamId: materializedSoftwareTeamId,
          specName: softwareTeamSpec.name,
          specVersion: softwareTeamSpec.version,
          nodes: nodeResults,
          warnings: preflightWarnings,
        },
      };
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && "message" in err) {
        const typed = err as { code: string; message: string };
        if (typed.code === "materialize_conflict") {
          return { ok: false, code: "materialize_conflict", message: typed.message };
        }
      }
      return { ok: false, code: "materialize_error", message: err instanceof Error ? err.message : String(err) };
    }
  }

  async launchMaterialized(
    softwareTeamSpecYaml: string,
    softwareTeamRoot: string,
    targetSoftwareTeamId: string,
  ): Promise<LaunchMaterializedOutcome> {
    let raw: unknown;
    try {
      raw = PodSoftwareTeamSpecCodec.parse(softwareTeamSpecYaml);
    } catch (err) {
      return { ok: false, code: "validation_failed", errors: [(err as Error).message] };
    }

    const targetSoftwareTeam = this.deps.softwareTeamRepo.getSoftwareTeam(targetSoftwareTeamId);
    if (!targetSoftwareTeam) {
      return { ok: false, code: "target_software_team_not_found", message: `SoftwareTeam "${targetSoftwareTeamId}" not found` };
    }

    const validation = PodSoftwareTeamSpecSchema.validate(raw, {
      externalQualifiedIds: targetSoftwareTeam.nodes.map((node) => node.logicalId),
    });
    if (!validation.valid) {
      return { ok: false, code: "validation_failed", errors: validation.errors };
    }

    const softwareTeamSpec = PodSoftwareTeamSpecSchema.normalize(raw as Record<string, unknown>);
    return this.launchValidatedSpec(softwareTeamSpec, softwareTeamRoot, targetSoftwareTeamId);
  }

  /**
   * launch CORE (OPR.0.3.3.24): given an already-parsed+validated spec whose
   * nodes are already materialized, compute launch order and bring each node
   * live via the launch-binding primitive. Extracted from launchMaterialized so
   * `expand` (and the add_member op) launch a structured spec WITHOUT a YAML
   * round-trip; launchMaterialized(yaml) is the parse/validate/normalize front
   * over it. Behaviour identical (loop body relocated verbatim).
   */
  async launchValidatedSpec(
    softwareTeamSpec: PodSoftwareTeamSpec,
    softwareTeamRoot: string,
    targetSoftwareTeamId: string,
    cwdOverride?: string,
  ): Promise<LaunchMaterializedOutcome> {
    const launchOrder = this.computePodLaunchOrder(softwareTeamSpec);
    const podWarnings: string[] = [];
    const nodeResults: LaunchMaterializedNodeResult[] = [];

    for (const logicalId of launchOrder) {
      const memberContext = this.findMemberContext(softwareTeamSpec, logicalId);
      if (!memberContext) {
        nodeResults.push({
          logicalId,
          nodeId: "",
          status: "failed",
          error: `Unable to resolve member definition for "${logicalId}"`,
        });
        continue;
      }

      const node = this.deps.softwareTeamRepo.getSoftwareTeam(targetSoftwareTeamId)?.nodes.find((entry) => entry.logicalId === logicalId);
      if (!node) {
        nodeResults.push({
          logicalId,
          nodeId: "",
          status: "failed",
          error: `Node "${logicalId}" not found after materialization`,
        });
        continue;
      }

      const launched = await this.launchBinding({
        softwareTeamId: targetSoftwareTeamId,
        softwareTeamSpec,
        softwareTeamRoot,
        pod: memberContext.pod,
        member: memberContext.member,
        qualifiedId: logicalId,
        nodeId: node.id,
        cwdOverride,
      });

      if (launched.warnings?.length) {
        podWarnings.push(...launched.warnings);
      }

      nodeResults.push({
        logicalId,
        nodeId: node.id,
        status: launched.status,
        error: launched.error,
        sessionName: launched.sessionName,
      });
    }

    return {
      ok: true,
      result: {
        nodes: nodeResults,
        warnings: podWarnings.length > 0 ? podWarnings : undefined,
      },
    };
  }

  /**
   * add_member converge op (OPR.0.3.3.24): add a single MEMBER to an EXISTING
   * pod in a live softwareTeam. S9 makes this the ordinary-growth front over the same
   * materializeValidatedSpec + launchValidatedSpec effect ingress used by pod
   * expansion; this method owns validation and result shaping, not a sibling
   * create/launch transaction.
   *
   * Identity-migration-FREE: the new node mints a fresh node id + fresh logical
   * id + fresh `@softwareteam_*` at launch; no existing seat's logical id,
   * continuity_state, queue routing, or session is re-keyed. This is the
   * source-visible fault line that lets add_member ship while move/fork wait for
   * the 0.4.0 identity stack.
   *
   * It resolves the EXISTING pod's DB id via `podRepo.getPodByNamespace`, then
   * explicitly tells the shared materializer to reuse that pod. The pod-exists
   * guard is lifted only for this named target; the per-member duplicate-logical-
   * id guard is KEPT (AC-3).
   */
  async addMemberToPod(
    softwareTeamId: string,
    podNamespace: string,
    memberFragment: Record<string, unknown>,
    softwareTeamRoot: string,
    opts?: { cwdOverride?: string; edges?: Array<{ from: string; to: string; kind: string }> },
  ): Promise<AddMemberOutcome> {
    // 1. Resolve the softwareTeam.
    const softwareTeam = this.deps.softwareTeamRepo.getSoftwareTeam(softwareTeamId);
    if (!softwareTeam) {
      return { ok: false, code: "software_team_not_found", message: `SoftwareTeam "${softwareTeamId}" not found.` };
    }

    // 2. Resolve the EXISTING pod's DB id via getPodByNamespace (the corrected
    // pod-id source — NOT a pre-computed namespace->podId map). Honest not-found
    // with the available namespaces so the caller can correct the handle.
    const pod = this.deps.podRepo.getPodByNamespace(softwareTeamId, podNamespace);
    if (!pod) {
      const available = this.deps.podRepo.getPodsForSoftwareTeam(softwareTeamId).map((p) => p.namespace);
      const hint = available.length > 0 ? available.join(", ") : "(none)";
      return {
        ok: false,
        code: "pod_not_found",
        message: `Pod "${podNamespace}" not found in softwareTeam "${softwareTeam.softwareTeam.name}". Existing pods: ${hint}. Check the namespace, or add a new pod with \`SoftwareTeam expand\`.`,
      };
    }

    // 3. Build a minimal one-pod-one-member raw spec around the EXISTING pod so
    // the new member runs the SAME validate + preflight the materialize front
    // does — without a whole-softwareTeam spec or a YAML round-trip. The member fragment
    // is embedded raw (spec snake_case shape, as expand's structured path emits);
    // validate/normalize is the type gate.
    const rawSpec: Record<string, unknown> = {
      version: "0.2",
      name: softwareTeam.softwareTeam.name,
      pods: [{ id: podNamespace, label: pod.label, members: [memberFragment], edges: [] }],
      edges: [],
    };

    // 4. Validate + normalize. externalQualifiedIds is the existing softwareTeam's node
    // set (matches the materialize front; used for cross-pod edge resolution).
    const validation = PodSoftwareTeamSpecSchema.validate(rawSpec, {
      externalQualifiedIds: softwareTeam.nodes.map((node) => node.logicalId),
    });
    if (!validation.valid) {
      return { ok: false, code: "validation_failed", errors: validation.errors };
    }
    const softwareTeamSpec = PodSoftwareTeamSpecSchema.normalize(rawSpec);
    const member = softwareTeamSpec.pods[0]!.members[0]!;
    const qualifiedId = `${podNamespace}.${member.id}`;

    // 5. KEEP the per-member duplicate-logical-id guard (AC-3). The pod-exists
    // guard is lifted (we are adding to a live pod on purpose), but minting a
    // colliding logical id would be a real seat collision — reject it honestly.
    // (validate's externalQualifiedIds only resolves edge targets; it does NOT
    // reject a member colliding with an existing node, so this guard is load-bearing.)
    if (softwareTeam.nodes.some((node) => node.logicalId === qualifiedId)) {
      return {
        ok: false,
        code: "member_conflict",
        message: `Member "${qualifiedId}" already exists in softwareTeam "${softwareTeam.softwareTeam.name}". Pick a different member id, or remove the existing seat first.`,
      };
    }

    // 6. Preflight the new member on the normalized spec (same checks the
    // materialize front runs, via the core, using this adapter's fsOps).
    // softwareTeamNameOverride suppresses the software-team-name-collision check (we are appending
    // to an existing softwareTeam, exactly like expand's structured path).
    const preflight = await preflightValidatedSpec(softwareTeamSpec, {
      softwareTeamRoot,
      cwdOverride: opts?.cwdOverride,
      fsOps: this.deps.fsOps,
      skillsRoot: this.resolveSkillsRoot(),
      ...this.systemWorldResolutionContext(),
      softwareTeamNameOverride: softwareTeam.softwareTeam.name,
      inheritedPermissionPolicy: this.inheritedPermissionPolicy(softwareTeamId),
      exec: this.deps.exec,
    });
    if (!preflight.ready) {
      return { ok: false, code: "preflight_failed", errors: preflight.errors, warnings: preflight.warnings };
    }

    // 7. Validate + resolve any declared pod-local edges BEFORE creating the
    // node, so a bad edge fails fast with no orphan seat. Two honest failure
    // classes: (a) DECLARATION validity (non-array / empty fields / a kind
    // outside the canonical VALID_EDGE_KINDS - mirrors the software-team-spec pod-local
    // edge contract, NOT a second looser path) -> validation_failed; (b) live
    // ENDPOINT resolution against the new member + existing pod-mates ->
    // edge_unresolved. Edges carry NO runtime behavior yet (the edge-runtime
    // fence); we persist the declared graph so it is NOT silently dropped (FM2).
    const rawEdges = opts?.edges;
    if (rawEdges !== undefined && rawEdges !== null && !Array.isArray(rawEdges)) {
      return { ok: false, code: "validation_failed", errors: ["edges: must be an array of { from, to, kind }"] };
    }
    const declaredEdges = Array.isArray(rawEdges) ? rawEdges : [];
    const edgeErrors: string[] = [];
    declaredEdges.forEach((edge, i) => {
      if (typeof edge?.from !== "string" || typeof edge?.to !== "string" || typeof edge?.kind !== "string"
        || edge.from.trim() === "" || edge.to.trim() === "" || edge.kind.trim() === "") {
        edgeErrors.push(`edges[${i}]: from, to, and kind are required non-empty strings`);
        return;
      }
      if (!VALID_EDGE_KINDS.has(edge.kind)) {
        edgeErrors.push(`edges[${i}].kind: must be one of ${[...VALID_EDGE_KINDS].join(", ")} (got "${edge.kind}")`);
      }
    });
    if (edgeErrors.length > 0) {
      return { ok: false, code: "validation_failed", errors: edgeErrors };
    }
    const knownLogicalIds = new Set<string>([...softwareTeam.nodes.map((node) => node.logicalId), qualifiedId]);
    const resolvedEdges: Array<{ from: string; to: string; kind: string }> = [];
    for (const edge of declaredEdges) {
      const from = `${podNamespace}.${edge.from}`;
      const to = `${podNamespace}.${edge.to}`;
      if (!knownLogicalIds.has(from) || !knownLogicalIds.has(to)) {
        const missing = !knownLogicalIds.has(from) ? from : to;
        return { ok: false, code: "edge_unresolved", message: `Pod-local edge references "${missing}", which is neither the new member "${qualifiedId}" nor an existing seat in softwareTeam "${softwareTeam.softwareTeam.name}". Use member ids within pod "${podNamespace}".` };
      }
      resolvedEdges.push({ from, to, kind: edge.kind });
    }

    // 8. Feed the already-validated member and edges to the ONE creation
    // effect. Pod-local edges may name existing pod-mates, so they are checked
    // above against the live topology, then attached after schema validation.
    softwareTeamSpec.pods[0]!.edges = declaredEdges;
    const materialized = await this.materializeValidatedSpec(softwareTeamSpec, softwareTeamRoot, preflight.warnings, {
      targetSoftwareTeamId: softwareTeamId,
      suppressSummaryEvent: true,
      cwdOverride: opts?.cwdOverride,
      existingPodNamespace: podNamespace,
    });
    if (!materialized.ok) {
      const message = "message" in materialized
        ? materialized.message
        : "errors" in materialized
          ? materialized.errors.join("; ")
          : "member materialization failed";
      if (materialized.code === "materialize_conflict") {
        return { ok: false, code: "member_conflict", message };
      }
      return { ok: false, code: "materialize_error", message };
    }

    // 9. The shared launch effect owns startup projection + delivery +
    // readiness + `@softwareteam_*` for both expansion and ordinary growth.
    const launchOutcome = await this.launchValidatedSpec(softwareTeamSpec, softwareTeamRoot, softwareTeamId, opts?.cwdOverride);
    if (!launchOutcome.ok) {
      const message = "message" in launchOutcome
        ? launchOutcome.message
        : "errors" in launchOutcome
          ? launchOutcome.errors.join("; ")
          : "member launch failed";
      return { ok: false, code: "materialize_error", message };
    }
    const launched = launchOutcome.result.nodes.find((node) => node.logicalId === qualifiedId);
    if (!launched) {
      return { ok: false, code: "materialize_error", message: `No launch outcome returned for member "${qualifiedId}".` };
    }

    return {
      ok: true,
      result: {
        podId: pod.id,
        podNamespace,
        node: {
          logicalId: qualifiedId,
          nodeId: launched.nodeId,
          status: launched.status,
          error: launched.error,
          sessionName: launched.sessionName,
        },
        edges: resolvedEdges,
        warnings: [...(materialized.result.warnings ?? []), ...(launchOutcome.result.warnings ?? [])],
      },
    };
  }

  /** Recover the legacy gap where projection failed before startup context was
   * persisted. This is an explicit first-start retry, never a resume/fresh fallback.
   * The operator supplies the original member source after exiting and cleaning
   * the failed shell. Existing validation, projection and startup delivery own all
   * effects; no node, history, token or startup-context row is fabricated here. */
  async retryFirstStart(softwareTeamId: string, nodeId: string, memberFragment: Record<string, unknown>, softwareTeamRoot: string): Promise<
    { ok: false; code: string; message: string } |
    { ok: true; softwareTeamId: string; nodeId: string; logicalId: string; status: "launched"; sessionName?: string; warnings?: string[] }
  > {
    const guard = this.deps.tmuxAdapter?.deliveryGuard;
    if (guard && !guard.ownsLifecycle(nodeId)) {
      return guard.lifecycle([nodeId], () => this.retryFirstStart(softwareTeamId, nodeId, memberFragment, softwareTeamRoot));
    }
    const refuse = (message: string) => ({ ok: false as const, code: "first_start_retry_refused", message });
    const softwareTeam = this.deps.softwareTeamRepo.getSoftwareTeam(softwareTeamId);
    const node = softwareTeam?.nodes.find(n => n.id === nodeId);
    const podRow = node && this.deps.podRepo.getPodsForSoftwareTeam(softwareTeamId).find(p => p.id === node.podId);
    if (!softwareTeam || !node || !podRow || node.runtime === "terminal") return refuse("Retry requires an existing agent member in a pod.");
    if (!nodePath.isAbsolute(softwareTeamRoot)) return refuse("Supply the original absolute --software-team-root for agent resolution.");

    const eligible = (): string | undefined => {
      const current = this.deps.softwareTeamRepo.getSoftwareTeam(softwareTeamId)?.nodes.find(n => n.id === nodeId);
      if (!current || JSON.stringify(current) !== JSON.stringify(node)) return "Seat changed during recovery checks; inspect it before retrying.";
      if (this.deps.sessionRegistry.getBindingForNode(nodeId)) return "Seat is still bound. Exit the failed shell, then use SoftwareTeam seat clean; retry never stops a process.";
      if (this.db.prepare("SELECT 1 FROM node_startup_context WHERE node_id = ?").get(nodeId)) return "Startup context already exists; use the ordinary seat lifecycle commands.";
      const sessions = this.deps.sessionRegistry.getSessionsForSoftwareTeam(softwareTeamId).filter(s => s.nodeId === nodeId);
      if (sessions.length === 0 || sessions.some(s => s.status !== "exited" || s.startupStatus !== "failed" || s.origin !== "launched" || s.resumeToken)) {
        return "Every prior session must be an exited, failed first start with no native resume token.";
      }
      if (this.db.prepare("SELECT 1 FROM occupant_tenures WHERE node_id = ? AND native_session_id_at_boot IS NOT NULL").get(nodeId)
        || this.db.prepare("SELECT 1 FROM applied_launch_observations a JOIN occupant_tenures t USING (generation_uuid) WHERE t.node_id = ?").get(nodeId)) {
        return "A native identity or applied launch was recorded; first-start retry cannot replace it.";
      }
      const events = this.db.prepare("SELECT type, payload FROM events WHERE node_id = ? AND type IN ('node.startup_ready', 'node.startup_failed') ORDER BY seq").all(nodeId) as Array<{ type: string; payload: string }>;
      if (events.some(e => e.type === "node.startup_ready")) return "This seat previously reached startup readiness.";
      // Old producers have no structured phase field. Admit only their exact
      // projection-failure prefixes, which precede launchHarness in startNode.
      try {
        const failures = events.map(e => JSON.parse(e.payload) as { sessionId?: string; error?: string });
        if (sessions.some(s => {
          const last = failures.filter(f => f.sessionId === s.id).at(-1);
          return !last || typeof last.error !== "string" || !/^Projection (failed for |error: )/.test(last.error);
        })) return "Retained events do not prove projection failed before native launch for every session.";
      } catch { return "Retained startup failure evidence is unreadable."; }
    };
    const initialRefusal = eligible();
    if (initialRefusal) return refuse(initialRefusal);

    const retainedFields = new Set(["id", "label", "agent_ref", "profile", "runtime", "model", "effort", "cwd", "role", "codex_config_profile", "permission_policy", "restore_policy"]);
    if (Object.keys(memberFragment).some(key => !retainedFields.has(key))) return refuse("Retry accepts only retained member fields; topology and startup overrides require a separate change.");
    const rawSpec = { version: "0.2", name: softwareTeam.softwareTeam.name, pods: [{ id: podRow.namespace, label: podRow.label, members: [memberFragment], edges: [] }], edges: [] };
    const validation = PodSoftwareTeamSpecSchema.validate(rawSpec);
    if (!validation.valid) return refuse(validation.errors.join("; "));
    const softwareTeamSpec = PodSoftwareTeamSpecSchema.normalize(rawSpec);
    const pod = softwareTeamSpec.pods[0]!;
    const member = pod.members[0]!;
    // These overrides were not retained on the old node. Refuse to guess them or
    // introduce new startup/session-source behavior in a recovery request.
    if (member.startup || member.starterRef || member.sessionSource || member.compactionStrategy || member.mechanic || node.sessionSource) {
      return refuse("First-start retry does not accept unretained member startup, continuity or session-source overrides.");
    }
    const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);
    if (`${pod.id}.${member.id}` !== node.logicalId || !same(member.agentRef, node.agentRef) || !same(member.profile, node.profile)
      || !same(member.runtime, node.runtime) || !same(member.role, node.role) || !same(member.label, node.label) || !same(member.codexConfigProfile, node.codexConfigProfile)
      || !same(member.permissionPolicy, node.permissionPolicy)) return refuse("Member source disagrees with the retained seat identity or policy.");
    const resolved = resolveAgentRef(member.agentRef, softwareTeamRoot, this.deps.fsOps);
    if (!resolved.ok) return refuse(resolved.code === "validation_failed" ? resolved.errors.join("; ") : resolved.error);
    if (!node.resolvedSpecHash || resolved.resolved.hash !== node.resolvedSpecHash) return refuse("Agent source hash differs from the failed first start.");
    const config = resolveNodeConfig({ baseSpec: resolved.resolved, importedSpecs: resolved.imports, collisions: resolved.collisions,
      profileName: member.profile, specRoot: softwareTeamRoot, member, pod, softwareTeam: softwareTeamSpec, skillsRoot: this.resolveSkillsRoot(), ...this.systemWorldResolutionContext() });
    if (!config.ok) return refuse(config.errors.join("; "));
    if (!same(config.config.model, node.model) || !same(config.config.effort, node.effort) || !same(config.config.cwd, node.cwd) || !same(config.config.restorePolicy, node.restorePolicy)) {
      return refuse("Resolved model, effort, cwd or restore policy differs from the failed first start.");
    }
    const preflight = await preflightValidatedSpec(softwareTeamSpec, { softwareTeamRoot, fsOps: this.deps.fsOps, skillsRoot: this.resolveSkillsRoot(),
      ...this.systemWorldResolutionContext(), softwareTeamNameOverride: softwareTeam.softwareTeam.name, inheritedPermissionPolicy: this.inheritedPermissionPolicy(softwareTeamId), exec: this.deps.exec });
    if (!preflight.ready) return refuse(preflight.errors.join("; "));
    const names = new Set([deriveCanonicalSessionName(pod.id, member.id, softwareTeam.softwareTeam.name),
      ...this.deps.sessionRegistry.getSessionsForSoftwareTeam(softwareTeamId).filter(s => s.nodeId === nodeId).map(s => s.sessionName)]);
    try {
      for (const name of names) {
        if ((await this.deps.tmuxAdapter?.probeSession(name))?.state !== "absent") return refuse(`Session "${name}" is live or its liveness is unknown; no retry was attempted.`);
      }
    } catch { return refuse("Session liveness could not be determined; no retry was attempted."); }
    const finalRefusal = eligible();
    if (finalRefusal) return refuse(finalRefusal);
    const result = await this.launchExistingAgentMember({ softwareTeamId, nodeId, qualifiedId: node.logicalId, softwareTeamSpec, softwareTeamRoot, pod, member,
      resolveResult: resolved, configResult: config });
    if (result.status !== "launched") return { ok: false, code: result.status, message: result.error ?? "First-start retry did not reach readiness." };
    return { ok: true, softwareTeamId, nodeId, logicalId: node.logicalId, status: "launched", sessionName: result.sessionName, warnings: result.warnings };
  }

  async instantiate(softwareTeamSpecYaml: string, softwareTeamRoot: string, opts?: { nonInterruptive?: boolean; cwdOverride?: string; env?: SeatEnv; installRoot?: string; force?: boolean; prelaunchHook?: (softwareTeamId: string, replacedSoftwareTeamIds: readonly string[]) => Promise<{ ok: true; rollback?: () => Promise<void> } | { ok: false; code: string; message: string; retainSoftwareTeam?: boolean }> }): Promise<InstantiateOutcome> {
    // #141: while an import may archive a stopped same-name generation, allow one import per softwareTeam name at
    // a time on this daemon. Otherwise two imports could each replace it, or one could archive the other's
    // in-progress replacement. Unrelated names are unaffected; an adapter that cannot probe keeps today's
    // behavior.
    let name: string | null = null;
    if (this.deps.tmuxAdapter?.probeSession) {
      try {
        const parsed = PodSoftwareTeamSpecCodec.parse(softwareTeamSpecYaml) as { name?: unknown };
        name = typeof parsed?.name === "string" ? parsed.name : null;
      } catch { /* the import below reports the parse error */ }
    }
    if (!name) return this.instantiateOnce(softwareTeamSpecYaml, softwareTeamRoot, opts);
    let inFlight = importsInFlight.get(this.db);
    if (!inFlight) importsInFlight.set(this.db, (inFlight = new Set()));
    if (inFlight.has(name)) {
      return { ok: false, code: "generation_unconfirmed", message: `Another import of softwareTeam "${name}" is in progress. Nothing was created; retry once it finishes.` };
    }
    inFlight.add(name);
    try {
      return await this.instantiateOnce(softwareTeamSpecYaml, softwareTeamRoot, opts);
    } finally {
      inFlight.delete(name);
    }
  }

  private async instantiateOnce(softwareTeamSpecYaml: string, softwareTeamRoot: string, opts?: { nonInterruptive?: boolean; cwdOverride?: string; env?: SeatEnv; installRoot?: string; force?: boolean; prelaunchHook?: (softwareTeamId: string, replacedSoftwareTeamIds: readonly string[]) => Promise<{ ok: true; rollback?: () => Promise<void> } | { ok: false; code: string; message: string; retainSoftwareTeam?: boolean }> }): Promise<InstantiateOutcome> {
    // 1. Parse + validate
    let softwareTeamSpec: PodSoftwareTeamSpec;
    try {
      const raw = PodSoftwareTeamSpecCodec.parse(softwareTeamSpecYaml);
      const validation = PodSoftwareTeamSpecSchema.validate(raw);
      if (!validation.valid) {
        return { ok: false, code: "validation_failed", errors: validation.errors };
      }
      softwareTeamSpec = PodSoftwareTeamSpecSchema.normalize(raw as Record<string, unknown>);
    } catch (err) {
      return { ok: false, code: "validation_failed", errors: [(err as Error).message] };
    }

    // 1b. S5b running-name guard (OPR.0.5.4.11) — THE software-team-up path (the 08-26
    // duplicate specimen's path). Fires before preflight/create/launch: a
    // RUNNING same-name softwareTeam refuses with the teaching error and spends nothing;
    // all-stopped generations pass through (name reuse unchanged).
    const nameGuard = checkRunningNameGuard({
      findSoftwareTeamsByName: (n) => this.deps.softwareTeamRepo.findSoftwareTeamsByName(n),
      countRunningSessions: makeRunningSessionCounter(this.db),
    }, softwareTeamSpec.name);
    if (!nameGuard.ok) return nameGuard;

    // 2. Preflight
    const preflight = await softwareTeamPreflight({ softwareTeamSpecYaml, softwareTeamRoot, cwdOverride: opts?.cwdOverride, fsOps: this.deps.fsOps, skillsRoot: this.resolveSkillsRoot(), ...this.systemWorldResolutionContext(), exec: this.deps.exec, claudeActivityAssets: this.deps.claudeActivityAssets });
    if (!preflight.ready) {
      return { ok: false, code: "preflight_failed", errors: preflight.errors, warnings: preflight.warnings };
    }

    // 3. Compute launch order from edges (rejects cycles)
    //
    // OPR.0.3.2.22 Bug 2: this MUST run BEFORE createSoftwareTeam. Pre-fix, a
    // cycle in the spec left an orphan stopped-state softwareTeam record because
    // createSoftwareTeam had already committed before the cycle check ran. The
    // operator-facing consequence was the "ambiguous library-spec vs
    // restore-target" UX trap on the very next `SoftwareTeam up <builtin>` retry.
    let launchOrder: string[];
    try {
      launchOrder = this.computePodLaunchOrder(softwareTeamSpec);
    } catch (err) {
      return { ok: false, code: "cycle_error", message: (err as Error).message };
    }

    // 4. Create softwareTeam (after cycle check passes)
    // #141: an explicit YAML import replacing a same-name softwareTeam archives the prior generations once they
    // are confirmed stopped, atomically with creating the replacement, so they stop claiming its seat
    // names. A same-name generation that can't be confirmed stopped is kept, and nothing is created.
    let archivedGenerations: string[] = [];
    const tmuxProbe = this.deps.tmuxAdapter?.probeSession?.bind(this.deps.tmuxAdapter);
    const priorGenerations = tmuxProbe ? this.deps.softwareTeamRepo.findUnarchivedSoftwareTeamsByName(softwareTeamSpec.name).map((softwareTeam) => softwareTeam.id) : [];
    if (priorGenerations.length > 0) {
      const stopped = await confirmStoppedGenerations(this.db, priorGenerations, tmuxProbe!);
      if (!stopped.ok) {
        return {
          ok: false,
          code: "generation_unconfirmed",
          message:
            `A SoftwareTeam named "${softwareTeamSpec.name}" already exists (${stopped.softwareTeamId}), and SoftwareTeam could not confirm it is stopped: ` +
            `${stopped.reason}. Nothing was created. Restore it with 'SoftwareTeam up ${softwareTeamSpec.name}', ` +
            `or archive it first with 'SoftwareTeam archive ${stopped.softwareTeamId}'.`,
        };
      }
      archivedGenerations = stopped.softwareTeamIds;
    }
    const restoreArchived = () => { for (const id of archivedGenerations) this.deps.softwareTeamRepo.unarchiveSoftwareTeam(id); };

    let softwareTeamId: string;
    let createdSoftwareTeamId: string | null = null;
    try {
      const create = this.db.transaction(() => {
        if (tmuxProbe) {
          // #141: apply the stopped decision only to the same-name softwareTeams it was made for, and archive
          // only rows this import changes, so a rollback restores exactly what it archived.
          const current = this.deps.softwareTeamRepo.findUnarchivedSoftwareTeamsByName(softwareTeamSpec.name).map((softwareTeam) => softwareTeam.id).sort();
          if (current.join(",") !== [...priorGenerations].sort().join(",")) throw new GenerationChanged(softwareTeamSpec.name);
          for (const id of archivedGenerations) {
            if (makeRunningSessionCounter(this.db)(id) > 0 || !this.deps.softwareTeamRepo.archiveSoftwareTeam(id)) throw new GenerationChanged(softwareTeamSpec.name);
          }
        }
        return this.deps.softwareTeamRepo.createSoftwareTeam(softwareTeamSpec.name, opts?.installRoot);
      });
      const softwareTeam = create();
      softwareTeamId = softwareTeam.id;
      createdSoftwareTeamId = softwareTeam.id;
      const nonInterruptive = opts?.nonInterruptive ?? softwareTeamSpec.nonInterruptive;
      if (nonInterruptive !== undefined) this.deps.softwareTeamRepo.setSoftwareTeamNonInterruptive(softwareTeamId, nonInterruptive);
      // PL-007: persist typed workspace block (when declared) on the softwareTeam
      // record. Whoami / node-inventory read it via getSoftwareTeamWorkspace().
      if (softwareTeamSpec.workspace) {
        this.deps.softwareTeamRepo.setSoftwareTeamWorkspace(softwareTeamId, softwareTeamSpec.workspace);
      }
      // #25: the second software-team-persist site (see materializeValidatedSpec).
      if (softwareTeamSpec.managedBlocks?.["claude-code"]) {
        this.deps.softwareTeamRepo.setSoftwareTeamClaudeManagedBlockFile(softwareTeamId, softwareTeamSpec.managedBlocks["claude-code"]);
      }
      // OPR.0.4.8.3 Seam B: the SECOND software-team-persist site (bootstrap instantiate path) —
      // both sites must write or the softwareTeam ref silently drops on one instantiate path.
      // Guard-F1: resolved softwareTeam attachment persists here too (declaringDir = softwareTeamRoot).
      if (softwareTeamSpec.env) this.deps.softwareTeamRepo.setSoftwareTeamEnv(softwareTeamId, softwareTeamSpec.env);
      if (softwareTeamSpec.permissionPolicy) {
        this.deps.softwareTeamRepo.setSoftwareTeamPermissionPolicy(softwareTeamId, softwareTeamSpec.permissionPolicy);
        const softwareTeamAttachment = resolvePermissionPolicyAttachment(softwareTeamSpec.permissionPolicy, softwareTeamRoot, {
          readFile: (p) => this.deps.fsOps.readFile(p),
        });
        this.deps.softwareTeamRepo.setSoftwareTeamPolicyProvenance(softwareTeamId, {
          origin: softwareTeamAttachment.origin,
          resolvedTarget: softwareTeamAttachment.resolvedTarget ?? null,
          declaringDir: softwareTeamAttachment.origin === "custom" ? softwareTeamRoot : null,
          launchPosture: softwareTeamAttachment.launchPosture,
        });
      }
    } catch (err) {
      if (err instanceof GenerationChanged) return { ok: false, code: "generation_unconfirmed", message: err.message };
      // #141: a replacement that failed to finish creating must not leave the prior generation hidden.
      if (createdSoftwareTeamId && archivedGenerations.length > 0) { this.deps.softwareTeamRepo.deleteSoftwareTeam(createdSoftwareTeamId); restoreArchived(); }
      return { ok: false, code: "instantiate_error", message: (err as Error).message };
    }

    // 5. Create pods + nodes + edges, then launch in topological order
    const nodeResults: { logicalId: string; status: "launched" | "failed" | "attention_required"; error?: string; evidence?: string; sessionName?: string }[] = [];
    const nodeIdMap: Record<string, string> = {}; // "pod.member" -> node DB id
    const launchedSessionNames: string[] = []; // Track for orphan cleanup on total failure
    const podInstantiateWarnings = preflight.warnings;
    for (const id of archivedGenerations) {
      podInstantiateWarnings.push(`Archived the stopped earlier "${softwareTeamSpec.name}" softwareTeam ${id}; its records are kept. Restore it with: SoftwareTeam unarchive ${id}`);
    }

    // OPR.0.5.3.6 (r2-B1) — instantiate() is the REAL software-team-up door (/api/up →
    // bootstrap → here), and like the software-team-persist sites above, BOTH
    // instantiation paths must install or defaults silently drop on one of
    // them (materializeValidatedSpec carries the same guarded block). Runs
    // BEFORE node launch so seats can read their defaults from first boot.
    // Best-effort, doubly guarded: the installer itself never throws, and this
    // wrapper makes even a broken injected fsOps a named warning, never a
    // failed softwareTeam.
    if (this.deps.topologyRootResolver) {
      try {
        const defaults = installTopologyDefaults({
          specDir: softwareTeamRoot,
          softwareTeamName: softwareTeamSpec.name,
          podIds: softwareTeamSpec.pods.map((pod) => pod.id),
          topologyRoot: this.deps.topologyRootResolver(),
        });
        for (const f of defaults.failed) {
          podInstantiateWarnings.push(`topology-defaults: could not install ${f.path}: ${f.error}`);
        }
      } catch (err) {
        podInstantiateWarnings.push(`topology-defaults: installer failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Store per-member context for deferred launch
    const memberContext = new Map<string, { pod: typeof softwareTeamSpec.pods[0]; member: typeof softwareTeamSpec.pods[0]["members"][0]; podId: string; nodeId: string; resolveResult: any; configResult: any }>();

    // Phase 1: Create all pods and collect member entries
    const podIdMap: Record<string, string> = {}; // pod.id -> DB pod id
    const memberEntries: Array<{ pod: typeof softwareTeamSpec.pods[0]; member: typeof softwareTeamSpec.pods[0]["members"][0]; podId: string; qualifiedId: string }> = [];

    for (const pod of softwareTeamSpec.pods) {
      let podId: string;
      try {
        const podRecord = this.deps.podRepo.createPod(softwareTeamId, pod.id, pod.label, {
          summary: pod.summary,
          continuityPolicyJson: pod.continuityPolicy ? JSON.stringify(pod.continuityPolicy) : undefined,
        });
        podId = podRecord.id;
        podIdMap[pod.id] = podId;
      } catch (err) {
        nodeResults.push(...pod.members.map((m) => ({ logicalId: `${pod.id}.${m.id}`, status: "failed" as const, error: `Pod creation failed: ${(err as Error).message}` })));
        continue;
      }
      for (const member of pod.members) {
        memberEntries.push({ pod, member, podId, qualifiedId: `${pod.id}.${member.id}` });
      }
    }

    // Sort members by topological launch order
    const orderMap = new Map(launchOrder.map((id, i) => [id, i]));
    memberEntries.sort((a, b) => (orderMap.get(a.qualifiedId) ?? 999) - (orderMap.get(b.qualifiedId) ?? 999));

    // Prelaunch hook: service gate runs after topology setup, before any node launch.
    //
    // OPR.0.3.2.22 Bug 2: if the hook fails, roll back the softwareTeam record so
    // the spec name is left free for a clean retry. Pods rely on software_teams
    // via ON DELETE CASCADE so deleting the softwareTeam is sufficient.
    let rollbackServices: (() => Promise<void>) | undefined;
    if (opts?.prelaunchHook) {
      const hookResult = await opts.prelaunchHook(softwareTeamId, archivedGenerations);
      if (!hookResult.ok) {
        if (!hookResult.retainSoftwareTeam) {
          this.deps.softwareTeamRepo.deleteSoftwareTeam(softwareTeamId);
          restoreArchived();
        }
        return { ok: false, code: hookResult.code === "compose_project_conflict" ? "compose_project_conflict" : "service_boot_failed", message: hookResult.message };
      }
      rollbackServices = hookResult.rollback;
    }

    // Phase 2: Process members in launch order
    for (const { pod, member, podId, qualifiedId } of memberEntries) {

        // Terminal fast-path: skip agent resolution and profile resolution
        if (member.agentRef === "builtin:terminal") {
          const termResult = await this.processTerminalMember(
            softwareTeamId, softwareTeamSpec, softwareTeamRoot, pod, member, podId, qualifiedId, nodeIdMap, launchedSessionNames, podInstantiateWarnings, opts?.cwdOverride, opts?.env,
          );
          nodeResults.push(termResult);
          continue;
        }

        // Resolve agent ref
        const resolveResult = resolveAgentRef(member.agentRef, softwareTeamRoot, this.deps.fsOps);
        if (!resolveResult.ok) {
          const msg = resolveResult.code === "validation_failed"
            ? (resolveResult as { errors: string[] }).errors.join("; ")
            : (resolveResult as { error: string }).error;
          nodeResults.push({ logicalId: qualifiedId, status: "failed", error: msg });
          continue;
        }

        // Resolve node config (profile + precedence)
        const configResult = resolveNodeConfig({
          baseSpec: resolveResult.resolved,
          importedSpecs: resolveResult.imports,
          collisions: resolveResult.collisions,
          profileName: member.profile,
          specRoot: softwareTeamRoot,
          cwdOverride: opts?.cwdOverride,
          member,
          pod,
          softwareTeam: softwareTeamSpec,
          skillsRoot: this.resolveSkillsRoot(),
          ...this.systemWorldResolutionContext(),
        });
        if (!configResult.ok) {
          nodeResults.push({ logicalId: qualifiedId, status: "failed", error: configResult.errors.join("; ") });
          continue;
        }

        // Create node
        const createUnit = this.db.transaction(() => {
          const node = this.deps.softwareTeamRepo.addNode(softwareTeamId, qualifiedId, {
            // OPR.0.4.6.FAC1 (VM-caught): the pod-aware bootstrap
            // instantiate-from-YAML path (`SoftwareTeam up <spec>`) creates agent
            // nodes via this INLINE addNode, NOT createMemberNode — so
            // it needs its own role wire or every up'd softwareTeam persists
            // role=NULL and role→seat resolution can never match. This
            // is the FOURTH node-creation site (materialize/expand/
            // add_member share createMemberNode; this one does not); the
            // C1 sibling-layer sweep missed it because its tests
            // exercised the createMemberNode paths, not bootstrap.
            role: member.role,
            runtime: member.runtime,
            model: member.model ?? configResult.config.model,
            effort: member.effort ?? configResult.config.effort,
            codexConfigProfile: member.codexConfigProfile,
            // OPR.0.4.8.3 Seam B: bootstrap inline addNode is the FOURTH node-creation
            // site (see the role wire note above) — same member-ref persistence as
            // createMemberNode or `SoftwareTeam up <spec>` seats lose their policy ref.
            permissionPolicy: member.permissionPolicy,
            env: member.env,
            sessionSource: member.sessionSource,
            cwd: configResult.config.cwd,
            restorePolicy: configResult.config.restorePolicy,
            podId,
            agentRef: member.agentRef,
            profile: member.profile,
            label: member.label,
            resolvedSpecName: configResult.config.resolvedSpecName,
            resolvedSpecVersion: configResult.config.resolvedSpecVersion,
            resolvedSpecHash: configResult.config.resolvedSpecHash,
          });
          // Guard multi-seat correction (16e853a7): node creation + required provenance
          // are ONE ATOMIC UNIT (SQLite savepoint). A setter fault rolls the INSERT back
          // too — under partial-success semantics the sibling may proceed, but a failed
          // member can never survive as a half-created node whose restore posture would
          // widen to the softwareTeam attachment. (Previously the row survived with provenance
          // null, and resolveRestorePosture fell through to softwareTeam full_bypass.)
          const bootstrapAttachment = this.resolveMemberPolicyAttachment(member.permissionPolicy, softwareTeamSpec.permissionPolicy, softwareTeamRoot);
          if (bootstrapAttachment) this.persistNodePolicyProvenanceStrict(node.id, bootstrapAttachment);
          return node.id;
        });
        let nodeId: string;
        try {
          nodeId = createUnit();
          // nodeIdMap only AFTER the atomic unit succeeds (Guard contract item 2).
          nodeIdMap[qualifiedId] = nodeId;
        } catch (err) {
          nodeResults.push({ logicalId: qualifiedId, status: "failed", error: (err as Error).message });
          continue;
        }

        const launched = await this.launchExistingAgentMember({
          softwareTeamId,
          softwareTeamSpec,
          softwareTeamRoot,
          cwdOverride: opts?.cwdOverride,
          envOverride: opts?.env,
          force: opts?.force,
          pod,
          member,
          qualifiedId,
          nodeId,
          resolveResult,
          configResult,
        });
        if (launched.sessionName) {
          launchedSessionNames.push(launched.sessionName);
        }
        if (launched.warnings?.length) {
          podInstantiateWarnings.push(...launched.warnings);
        }
        nodeResults.push({
          logicalId: qualifiedId,
          status: launched.status,
          error: launched.error,
          evidence: launched.evidence,
          sessionName: launched.sessionName,
        });
      }

    // Create pod-local edges (after all members created)
    for (const pod of softwareTeamSpec.pods) {
      for (const edge of pod.edges) {
        const fromId = nodeIdMap[`${pod.id}.${edge.from}`];
        const toId = nodeIdMap[`${pod.id}.${edge.to}`];
        if (fromId && toId) {
          try {
            this.deps.softwareTeamRepo.addEdge(softwareTeamId, fromId, toId, edge.kind);
          } catch { /* best-effort */ }
        }
      }
    }

    // Create cross-pod edges
    for (const edge of softwareTeamSpec.edges) {
      const fromId = nodeIdMap[edge.from];
      const toId = nodeIdMap[edge.to];
      if (fromId && toId) {
        try {
          this.deps.softwareTeamRepo.addEdge(softwareTeamId, fromId, toId, edge.kind);
        } catch { /* best-effort */ }
      }
    }

    // OPR.0.3.2.CT (conveyor-trust-minimal-fix):
    // Distinguish recoverable attention_required (e.g., workspace trust
    // gate) from terminal failure. ANY attention_required node means
    // the softwareTeam is operator-recoverable — do NOT tear down. Only when
    // every node is TERMINALLY failed (status === "failed") does the
    // tear-down run, preserving the existing failure-cleanup behavior.
    //
    // For all-attention_required (no successful launch, no terminal
    // failure), surface an attention_required outcome that carries
    // the actionable per-node detail. The route returns a 3-part
    // error pointing the operator at the approve→resume path. Sessions
    // remain in startup_status='attention_required' so `SoftwareTeam ps` lists
    // them and tmux panes are NOT killed.
    const hasAttention = nodeResults.some((n) => n.status === "attention_required");
    const hasLaunched = nodeResults.some((n) => n.status === "launched");
    const allTerminal = nodeResults.length > 0 && nodeResults.every((n) => n.status === "failed");

    if (allTerminal) {
      let serviceCleanupError: string | undefined;
      const cleanup = async () => {
        if (this.deps.tmuxAdapter) {
          for (const sessionName of launchedSessionNames) {
            if (this.deps.tmuxAdapter.probeSession) {
              let probe;
              try {
                probe = await this.deps.tmuxAdapter.probeSession(sessionName);
              } catch {
                return; // Unknown state: retain the softwareTeam for recovery.
              }
              if (probe.state === "absent") continue;
              if (probe.state !== "present") return;
            }
            const stopped = await this.deps.tmuxAdapter.killSession(sessionName);
            if (!stopped.ok && (stopped.code !== "session_not_found" || /no server running/i.test(stopped.message ?? ""))) return;
          }
        }
        try {
          await rollbackServices?.();
        } catch (error) {
          serviceCleanupError = `Service cleanup failed; softwareTeam ${softwareTeamId} retained for recovery: ${String(error)}`;
          return;
        }
        this.deps.softwareTeamRepo.deleteSoftwareTeam(softwareTeamId);
        restoreArchived();
      };
      const guard = this.deps.tmuxAdapter?.deliveryGuard;
      if (guard) await guard.lifecycle(Object.values(nodeIdMap), cleanup);
      else await cleanup();
      const details = nodeResults.map((n) => `${n.logicalId}: ${n.error ?? "unknown"}`).join("; ");
      return { ok: false, code: "instantiate_error", message: `all node launches/startups failed — ${details}${serviceCleanupError ? `; ${serviceCleanupError}` : ""}` };
    }

    if (hasAttention && !hasLaunched) {
      // All-attention_required path — softwareTeam + sessions PRESERVED; no
      // tear-down. Inspect the session and reason to distinguish native
      // decisions from failed/exited runtimes before choosing recovery.
      const attentionNodes = nodeResults
        .filter((n) => n.status === "attention_required")
        .map((n) => ({
          logicalId: n.logicalId,
          sessionName: n.sessionName ?? "",
          evidence: n.evidence,
          reason: n.error ?? "node awaiting attention",
        }));
      // Emit softwareTeam.imported so callers see the softwareTeam exists; nodes are
      // attention_required, not "launched", so `SoftwareTeam ps` shows the
      // correct lifecycle state.
      try {
        this.deps.eventBus.emit({
          type: "topology.roster_recorded",
          softwareTeamId,
          intendedNodeIds: Object.values(nodeIdMap),
          source: "materialized_topology",
        });
        this.deps.eventBus.emit({ type: "softwareTeam.imported", softwareTeamId, specName: softwareTeamSpec.name, specVersion: softwareTeamSpec.version });
      } catch { /* best-effort */ }
      return {
        ok: false,
        code: "attention_required",
        message: `${attentionNodes.length} node${attentionNodes.length === 1 ? " requires" : "s require"} attention before becoming interactive. Inspect the affected sessions and reasons before choosing recovery.`,
        softwareTeamId,
        attentionNodes,
        // #141: the replacement is kept on this path, so its archive notice must reach the user too.
        ...(archivedGenerations.length > 0 ? { warnings: podInstantiateWarnings } : {}),
      };
    }

    // Emit softwareTeam.imported
    try {
      this.deps.eventBus.emit({
        type: "topology.roster_recorded",
        softwareTeamId,
        intendedNodeIds: Object.values(nodeIdMap),
        source: "materialized_topology",
      });
      this.deps.eventBus.emit({ type: "softwareTeam.imported", softwareTeamId, specName: softwareTeamSpec.name, specVersion: softwareTeamSpec.version });
    } catch { /* best-effort */ }

    // Carry sessionName + evidence through to InstantiateResult.nodes
    // so BootstrapOrchestrator can build AttentionNode[] in the mixed
    // launched+attention_required path (guard verdict
    // qitem-20260518082933 BLOCKER 1).
    const resultNodes = nodeResults.map((n) => ({
      logicalId: n.logicalId,
      status: n.status,
      error: n.error,
      sessionName: n.sessionName,
      evidence: n.evidence,
    }));

    return {
      ok: true,
      result: { softwareTeamId, specName: softwareTeamSpec.name, specVersion: softwareTeamSpec.version, nodes: resultNodes, warnings: podInstantiateWarnings.length > 0 ? podInstantiateWarnings : undefined },
    };
  }

  private computePodLaunchOrder(softwareTeamSpec: PodSoftwareTeamSpec): string[] {
    const LAUNCH_DEP_KINDS = new Set(["delegates_to", "spawned_by"]);
    const allIds: string[] = [];
    const inDegree: Record<string, number> = {};
    const adjacency: Record<string, string[]> = {};

    // Collect all qualified member ids
    for (const pod of softwareTeamSpec.pods) {
      for (const member of pod.members) {
        const qid = `${pod.id}.${member.id}`;
        allIds.push(qid);
        inDegree[qid] = 0;
        adjacency[qid] = [];
      }
    }

    // Build adjacency from pod-local edges (qualify them) and cross-pod edges (already qualified)
    for (const pod of softwareTeamSpec.pods) {
      for (const edge of pod.edges) {
        if (!LAUNCH_DEP_KINDS.has(edge.kind)) continue;
        const from = `${pod.id}.${edge.kind === "delegates_to" ? edge.from : edge.to}`;
        const to = `${pod.id}.${edge.kind === "delegates_to" ? edge.to : edge.from}`;
        if (adjacency[from]) { adjacency[from]!.push(to); inDegree[to] = (inDegree[to] ?? 0) + 1; }
      }
    }
    for (const edge of softwareTeamSpec.edges) {
      if (!LAUNCH_DEP_KINDS.has(edge.kind)) continue;
      const from = edge.kind === "delegates_to" ? edge.from : edge.to;
      const to = edge.kind === "delegates_to" ? edge.to : edge.from;
      if (adjacency[from] && adjacency[to]) {
        adjacency[from]!.push(to);
        inDegree[to] = (inDegree[to] ?? 0) + 1;
      }
    }

    // Topological sort with alphabetical tiebreaker
    const queue = allIds.filter((id) => inDegree[id] === 0).sort();
    const order: string[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      order.push(current);
      for (const neighbor of (adjacency[current] ?? []).sort()) {
        inDegree[neighbor]! -= 1;
        if (inDegree[neighbor] === 0) {
          let inserted = false;
          for (let i = 0; i < queue.length; i++) {
            if (queue[i]!.localeCompare(neighbor) > 0) { queue.splice(i, 0, neighbor); inserted = true; break; }
          }
          if (!inserted) queue.push(neighbor);
        }
      }
    }

    // Cycle detection: if any nodes remain unvisited, the graph has a cycle
    if (order.length < allIds.length) {
      const cycled = allIds.filter((id) => !order.includes(id));
      throw new Error(`Dependency cycle detected among nodes: ${cycled.join(", ")}`);
    }

    return order;
  }

  private async processTerminalMember(
    softwareTeamId: string,
    softwareTeamSpec: PodSoftwareTeamSpec,
    softwareTeamRoot: string,
    pod: PodSoftwareTeamSpec["pods"][0],
    member: SoftwareTeamSpecPodMember,
    podId: string,
    qualifiedId: string,
    nodeIdMap: Record<string, string>,
    launchedSessionNames: string[],
    warnings: string[],
    cwdOverride?: string,
    envOverride?: SeatEnv,
  ): Promise<{ logicalId: string; status: "launched" | "failed"; error?: string }> {
    const effectiveCwd = resolveLaunchCwd(member.cwd, softwareTeamRoot, cwdOverride);
    // Create node with sentinel values
    let nodeId: string;
    try {
      const node = this.deps.softwareTeamRepo.addNode(softwareTeamId, qualifiedId, {
        runtime: member.runtime,
        model: member.model,
        effort: member.effort,
        env: member.env,
        cwd: effectiveCwd,
        restorePolicy: "checkpoint_only",
        podId,
        agentRef: member.agentRef,
        profile: member.profile,
        label: member.label,
      });
      nodeId = node.id;
      nodeIdMap[qualifiedId] = nodeId;
    } catch (err) {
      return { logicalId: qualifiedId, status: "failed", error: (err as Error).message };
    }

    const launched = await this.launchExistingTerminalMember({
      softwareTeamId,
      softwareTeamSpec,
      softwareTeamRoot,
      cwdOverride,
      envOverride,
      pod,
      member,
      qualifiedId,
      nodeId,
    });
    if (launched.sessionName) {
      launchedSessionNames.push(launched.sessionName);
    }
    if (launched.warnings?.length) {
      warnings.push(...launched.warnings);
    }
    return {
      logicalId: qualifiedId,
      status: launched.status,
      error: launched.error,
    };
  }

  private findMemberContext(
    softwareTeamSpec: PodSoftwareTeamSpec,
    qualifiedId: string,
  ): { pod: SoftwareTeamSpecPod; member: SoftwareTeamSpecPodMember } | null {
    const [podId, memberId] = qualifiedId.split(".", 2);
    if (!podId || !memberId) return null;
    const pod = softwareTeamSpec.pods.find((entry) => entry.id === podId);
    const member = pod?.members.find((entry) => entry.id === memberId);
    return pod && member ? { pod, member } : null;
  }

  /**
   * create-node primitive (OPR.0.3.3.24): mint a fresh node row for one member
   * (fresh stable id + fresh qualified logical id, `pod_id` = the given pod) plus
   * the matching `node.added` event. Extracted from materialize's loop so the
   * `add_member` converge op and a de-YAML'd `expand` create a member node
   * WITHOUT fabricating a synthetic softwareTeam spec. Identity-migration-FREE: addNode
   * mints a brand-new identity; nothing existing re-keys. The caller pushes the
   * returned `event` into its transaction's persisted-events list.
   */
  createMemberNode(input: {
    softwareTeamId: string;
    qualifiedId: string;
    member: SoftwareTeamSpecPodMember;
    podId: string;
    softwareTeamRoot: string;
    cwdOverride?: string;
  }) {
    const effectiveCwd = resolveLaunchCwd(input.member.cwd, input.softwareTeamRoot, input.cwdOverride);
    const node = this.deps.softwareTeamRepo.addNode(input.softwareTeamId, input.qualifiedId, {
      role: input.member.role,
      runtime: input.member.runtime,
      model: input.member.model,
      effort: input.member.effort,
      codexConfigProfile: input.member.codexConfigProfile,
      // OPR.0.4.8.3 Seam B: the member's OWN raw ref persists on the node (like role);
      // software-team-level lives on the softwareTeam row; precedence applies at RESOLUTION, not storage.
      permissionPolicy: input.member.permissionPolicy,
      env: input.member.env,
      sessionSource: input.member.sessionSource,
      cwd: effectiveCwd,
      restorePolicy: input.member.restorePolicy,
      podId: input.podId,
      agentRef: input.member.agentRef,
      profile: input.member.profile,
      label: input.member.label,
    });
    const event = this.deps.eventBus.persistWithinTransaction({
      type: "node.added",
      softwareTeamId: input.softwareTeamId,
      nodeId: node.id,
      logicalId: input.qualifiedId,
    });
    return { node, event };
  }

  /**
   * launch-binding primitive (OPR.0.3.3.24): given an already-created node and
   * its member context, bring it fully live — harness launch + startup
   * projection + delivery + readiness + `@softwareteam_*` metadata. Dispatches the
   * terminal vs agent launch path. Extracted as an independently-callable
   * primitive so launchMaterialized's loop, `expand`, and the `add_member`
   * converge op all launch a node WITHOUT fabricating a synthetic softwareTeam spec.
   * Behaviour is identical to the prior inline dispatch.
   */
  async launchBinding(input: {
    softwareTeamId: string;
    softwareTeamSpec: PodSoftwareTeamSpec;
    softwareTeamRoot: string;
    pod: SoftwareTeamSpecPod;
    member: SoftwareTeamSpecPodMember;
    qualifiedId: string;
    nodeId: string;
    cwdOverride?: string;
    envOverride?: SeatEnv;
  }): Promise<{ status: "launched" | "failed" | "attention_required"; error?: string; evidence?: string; sessionName?: string; warnings?: string[] }> {
    return input.member.agentRef === "builtin:terminal"
      ? this.launchExistingTerminalMember(input)
      : this.launchExistingAgentMember(input);
  }

  /**
   * OPR.0.4.8.3 Seam B — the ONE precedence + resolution point for a seat's permission
   * policy at launch: member ref > softwareTeam ref > absent (undefined = the env-driven floor).
   * Custom refs resolve relative to the softwareTeam root (the declaring SoftwareTeamSpec's directory in a
   * materialized softwareTeam). Returns undefined when no ref is attached at either level.
   */
  private resolveMemberPolicyAttachment(
    memberRef: string | undefined,
    softwareTeamRef: string | undefined | null,
    softwareTeamRoot: string,
  ): ResolvedPolicyAttachment | undefined {
    const ref = resolvePermissionPolicyRefValue(memberRef, softwareTeamRef);
    if (!ref) return undefined;
    return resolvePermissionPolicyAttachment(ref, softwareTeamRoot, {
      readFile: (p) => this.deps.fsOps.readFile(p),
    });
  }

  /** Seam B Guard-F2: the STRICT materialize/add-member persist — provenance here is
   *  LOAD-BEARING restart state; a real write failure must fail the surrounding
   *  transaction, never commit a node without it. (The repository setter itself still
   *  no-ops on pre-057 legacy fixture DBs — that narrow compatibility is preserved.) */
  private persistNodePolicyProvenanceStrict(nodeId: string, attachment: ResolvedPolicyAttachment): void {
    this.deps.softwareTeamRepo.setNodePolicyProvenance(nodeId, {
      origin: attachment.origin,
      resolvedTarget: attachment.resolvedTarget ?? null,
      declaringDir: attachment.declaringDir ?? null,
      launchPosture: attachment.launchPosture,
    });
  }

  /** Seam B: the LAUNCH-time refresh stays best-effort (idempotent re-write on an already-
   *  materialized node; a transient failure must not block a launch). */
  private persistNodePolicyProvenance(nodeId: string, attachment: ResolvedPolicyAttachment): void {
    try {
      this.persistNodePolicyProvenanceStrict(nodeId, attachment);
    } catch { /* best-effort on launch refresh only */ }
  }

  private async launchExistingAgentMember(input: {
    softwareTeamId: string;
    softwareTeamSpec: PodSoftwareTeamSpec;
    softwareTeamRoot: string;
    pod: SoftwareTeamSpecPod;
    member: SoftwareTeamSpecPodMember;
    qualifiedId: string;
    nodeId: string;
    cwdOverride?: string;
    /** One-off `SoftwareTeam up --env` values for this launch; not saved with the seat. */
    envOverride?: SeatEnv;
    /** P20 atom-4 — operator override: overwrite operator-edited (operator_conflict)
     *  projection targets instead of protecting them. Absent = protect (safe default). */
    force?: boolean;
    resolveResult?: ReturnType<typeof resolveAgentRef> extends infer T ? T : never;
    configResult?: ReturnType<typeof resolveNodeConfig> extends infer T ? T : never;
  }): Promise<{ status: "launched" | "failed" | "attention_required"; error?: string; evidence?: string; sessionName?: string; warnings?: string[] }> {
    const guard = this.deps.tmuxAdapter?.deliveryGuard;
    if (guard && !guard.ownsLifecycle(input.nodeId)) {
      return guard.lifecycle([input.nodeId], () => this.launchExistingAgentMember(input));
    }
    const resolveResult = input.resolveResult ?? resolveAgentRef(input.member.agentRef, input.softwareTeamRoot, this.deps.fsOps);
    if (!resolveResult.ok) {
      const msg = resolveResult.code === "validation_failed"
        ? (resolveResult as { errors: string[] }).errors.join("; ")
        : (resolveResult as { error: string }).error;
      return { status: "failed", error: msg };
    }

    const configResult = input.configResult ?? resolveNodeConfig({
      baseSpec: resolveResult.resolved,
      importedSpecs: resolveResult.imports,
      collisions: resolveResult.collisions,
      profileName: input.member.profile,
      specRoot: input.softwareTeamRoot,
      cwdOverride: input.cwdOverride,
      member: input.member,
      pod: input.pod,
      softwareTeam: input.softwareTeamSpec,
      skillsRoot: this.resolveSkillsRoot(),
      ...this.systemWorldResolutionContext(),
    });
    if (!configResult.ok) {
      return { status: "failed", error: configResult.errors.join("; ") };
    }

    this.updateNodeResolvedConfig(input.nodeId, configResult.config);

    // OPR.0.4.8.3 Seam B: resolve the seat's permission-policy attachment once for this
    // launch (member > softwareTeam precedence; declaring dir = the softwareTeam root, where the declaring
    // SoftwareTeamSpec + its relative policy files live). Also persists restart-stable provenance.
    // R2 HIGH-1: the LIVE binding must AGREE with persisted provenance — structured
    // add-member/expansion launch with a SYNTHETIC minimal spec (no software-team-level ref), so
    // when the in-memory spec resolves nothing, the PERSISTED node provenance (written in
    // the creation tx) and then the PERSISTED softwareTeam attachment are the binding's truth.
    const policyAttachment = this.resolveMemberPolicyAttachment(input.member.permissionPolicy, input.softwareTeamSpec.permissionPolicy, input.softwareTeamRoot);
    if (policyAttachment) this.persistNodePolicyProvenance(input.nodeId, policyAttachment);
    // R2 terminal (954d97a0): TRUE ABSENCE binds the locked MINIMUM FLOOR explicitly
    // (README v4 "DEFAULT IF NONE ATTACHED = the minimum floor"; FINAL2) — ambient
    // SOFTWARETEAM_YOLO must never widen a seat with no attachment. Absence stays honest
    // (no fabricated attachment/provenance); only the lifecycle BINDING is explicit.
    const launchPosture = policyAttachment?.launchPosture
      ?? this.deps.softwareTeamRepo.getNodePolicyProvenance(input.nodeId)?.launchPosture
      ?? this.deps.softwareTeamRepo.getSoftwareTeamPolicyProvenance(input.softwareTeamId)?.launchPosture
      ?? "floor";

    const sessionNameErrors = validateSessionComponents(input.pod.id, input.member.id, input.softwareTeamSpec.name);
    if (sessionNameErrors.length > 0) {
      return { status: "failed", error: sessionNameErrors.join("; ") };
    }

    const canonicalSessionName = deriveCanonicalSessionName(input.pod.id, input.member.id, input.softwareTeamSpec.name);
    const keptSkillWarnings: string[] = [];
    if (
      configResult.config.skillLoadout
      && this.deps.skillReconciler
      && (configResult.config.runtime === "claude-code" || configResult.config.runtime === "codex")
    ) {
      const reconcile = (selected: SkillLoadout) => this.deps.skillReconciler!({
        loadout: selected,
        runtime: configResult.config.runtime as SkillRuntime,
        cwd: configResult.config.cwd,
        apply: true,
        topologyOwner: canonicalSessionName,
      });
      const loadout = configResult.config.skillLoadout;
      let projection = reconcile(loadout);
      // Plugin skills never stop a seat that launched before them: if they cannot be
      // projected, the seat starts with the rest of its loadout and says why.
      if (!projection.ok && loadout.entries.some((entry) => entry.pluginId)) {
        const withoutPlugins = reconcile({ ...loadout, entries: loadout.entries.filter((entry) => !entry.pluginId) });
        if (withoutPlugins.ok) {
          keptSkillWarnings.push(`plugin_skills_not_projected: ${projection.errors.map((error) => `${error.code}: ${error.message}`).join("; ")}`);
          projection = withoutPlugins;
        }
      }
      if (!projection.ok) {
        return {
          status: "failed",
          error: projection.errors.map((error) => `${error.code}: ${error.message}`).join("; "),
          sessionName: canonicalSessionName,
        };
      }
      for (const receipt of projection.receipts.filter(isKeptPluginSkill)) {
        keptSkillWarnings.push(`plugin_skill_kept: ${receipt.id}: ${receipt.detail.slice("kept: ".length)} (${receipt.target})`);
      }
    }
    // Forward per-seat silenceWindowSeconds from the resolved profile.
    // Currently inert: the live SeatActivityService poller uses the
    // global 3s default. Retained for a future per-seat-poller decision.
    const launchResult = await this.deps.nodeLauncher.launchNode(input.softwareTeamId, input.qualifiedId, {
      sessionName: canonicalSessionName,
      silenceWindowSeconds: configResult.config.activity?.silenceWindowSeconds,
      env: input.envOverride,
      pluginPaths: selectedPluginPaths(configResult.config.selectedResources),
    });
    if (!launchResult.ok) {
      return { status: "failed", error: launchResult.message };
    }

    try {
      this.db.prepare("UPDATE sessions SET restore_policy = ? WHERE id = ?")
        .run(configResult.config.restorePolicy, launchResult.session.id);
    } catch { /* best-effort */ }

    const adapter = this.deps.adapters[input.member.runtime];
    if (!adapter) {
      return { status: "failed", error: `No adapter for runtime "${input.member.runtime}"`, sessionName: canonicalSessionName, warnings: launchResult.warnings };
    }

    // P20 — the projection manifest: consulted so a divergent target is
    // discriminated operator-modified (protect) vs stale-projection (safe
    // overwrite). REAL store-backed lookup on this.db (never a mock/null — the
    // uninjected-service dead-invalidator class the P17 comment below records).
    const projectionManifest = new ProjectionManifestStore(this.db);
    const planResult = planProjection({
      config: configResult.config,
      collisions: resolveResult.collisions,
      fsOps: this.deps.fsOps,
      // P17 (finding A2): the conflict detector's resolver, UNINJECTED since the
      // 4.8 restack dropped the warnings-site threading — without it every entry
      // classified safe_projection and divergent targets overwrote silently.
      // #25: a Claude seat's guidance conflict target is the softwareTeam's selected file (softwareTeam row,
      // the same source startNode binds for the write). An adapter that writes skills
      // outside the project tree (OMP's seat agent dir) names its own skill target.
      resolveTargetPath: (category, effectiveId, cwd, sourcePath) =>
        input.member.runtime === "codex" && category === "skill"
          ? nodePath.join(cwd, ".agents", "skills", effectiveId, "SKILL.md")
          : category === "skill" && adapter.skillTargetPath
            ? adapter.skillTargetPath(launchResult.binding.tmuxSession, effectiveId)
            : claudeConflictTargetPath(
              category, effectiveId, cwd, sourcePath,
              input.member.runtime === "claude-code" ? this.deps.softwareTeamRepo.getSoftwareTeamClaudeManagedBlockFile(input.softwareTeamId) ?? undefined : undefined,
            ),
      lastHashLookup: (targetPath) => projectionManifest.lastHash(targetPath),
    });
    if (!planResult.ok) {
      return { status: "failed", error: planResult.errors.join("; "), sessionName: canonicalSessionName, warnings: launchResult.warnings };
    }
    // P17: a divergent target is never SILENT again — each conflict rides the
    // instantiate warnings surface with the file, reason, and consequence.
    (launchResult.warnings ??= []).push(
      ...[...(configResult.config.skillWarnings ?? []), ...keptSkillWarnings].map(warning => `${canonicalSessionName}: ${warning}`),
      ...projectionConflictWarnings(planResult.plan),
    );

    // Codex project() writes plan entries before startup-file delivery. Protect
    // edited skills there too; filtering only startup files is insufficient.
    if (input.member.runtime === "codex" && !input.force) {
      planResult.plan.entries = planResult.plan.entries.filter(
        entry => entry.category !== "skill" || entry.classification !== "operator_conflict",
      );
    }

    const resolvedFiles = this.buildResolvedStartupFiles(
      resolveResult.resolved.spec,
      resolveResult.resolved.sourcePath,
      resolveResult.resolved.spec.profiles[input.member.profile],
      input.softwareTeamSpec,
      input.softwareTeamRoot,
      input.pod,
      input.member,
    );
    const managedDedupedFiles = this.dedupeProjectedManagedStartupFiles(planResult.plan, resolvedFiles);
    // P20 atom-4 PROTECT: hold back operator-edited skill targets (operator_conflict)
    // so the adapter never overwrites an operator's edit — unless the operator forces
    // it (input.force). The per-conflict warning already tells the operator this.
    const dedupedResolvedFiles = filterProtectedProjections(
      managedDedupedFiles,
      planResult.plan,
      { force: input.force },
    ).delivered;

    const binding: NodeBinding = {
      id: launchResult.binding.id,
      nodeId: input.nodeId,
      tmuxSession: launchResult.binding.tmuxSession,
      tmuxWindow: null,
      tmuxPane: null,
      cmuxWorkspace: null,
      cmuxSurface: null,
      updatedAt: "",
      cwd: configResult.config.cwd,
      model: configResult.config.model,
      // The seat's saved effort choice wins over the authored value just written by
      // updateNodeResolvedConfig; a seat without one launches with exactly that authored value.
      effort: (readSeatEffort(this.deps.softwareTeamRepo.db, input.nodeId) ?? { effective: configResult.config.effort ?? null }).effective ?? undefined,
      codexConfigProfile: input.member.codexConfigProfile,
      // OPR.0.4.8.3 Seam B: resolved launch posture (member > softwareTeam > persisted > FLOOR)
      // binds per-seat explicitly; adapters thread it into the yolo-mode helpers.
      launchPosture,
    };

    // session_source dispatch: fork (native runtime fork) vs rebuild (artifact-
    // injected fresh launch) vs agent_image (PL-016 Item 4: dispatch through
    // fork using the image's resume token). Mutually exclusive on a member.
    let forkSourceOpt: { forkSource: { kind: "native_id" | "artifact_path" | "name" | "last"; value?: string } } | undefined;
    let rebuildArtifactsOpt: { rebuildArtifacts: import("./runtime-adapter.js").ResolvedStartupFile[] } | undefined;
    // Stash the consumed image id + library handle so the post-launch block
    // can bump fork_count only on startupResult.ok===true (lastUsedAt
    // already bumped optimistically in the dispatch branch).
    let consumedAgentImageId: string | undefined;
    let consumedAgentImageLibrary: import("./agent-images/agent-image-library-service.js").AgentImageLibraryService | undefined;
    if (input.member.sessionSource?.mode === "fork") {
      const ref = input.member.sessionSource.ref;
      forkSourceOpt = {
        forkSource: {
          kind: ref.kind,
          ...(ref.value !== undefined ? { value: ref.value } : {}),
        },
      };
    } else if (input.member.sessionSource?.mode === "rebuild") {
      const { resolveRebuildArtifacts } = await import("./session-source-rebuild-resolver.js");
      const resolved = resolveRebuildArtifacts(input.member.sessionSource);
      if (!resolved.ok) {
        return { status: "failed", error: resolved.error, sessionName: canonicalSessionName };
      }
      rebuildArtifactsOpt = { rebuildArtifacts: resolved.files };
    } else if (input.member.sessionSource?.mode === "agent_image") {
      // PL-016 Item 4: agent_image → resolve via library + dispatch
      // through the native-fork code path so nativeResumeProbe
      // semantics are preserved
      // (docs/as-built/architecture/adapters-and-runtimes.md § Resume honesty).
      const library = this.deps.agentImageLibrary;
      if (!library) {
        return {
          status: "failed",
          error: `session_source: mode: agent_image requires the daemon AgentImageLibraryService to be wired; restart the daemon or check ~/.softwareteam/agent-images/ exists.`,
          sessionName: canonicalSessionName,
        };
      }
      const ref = input.member.sessionSource.ref;
      const version = ref.version ?? "1";
      const image = library.getByNameVersion(ref.value, version);
      if (!image) {
        return {
          status: "failed",
          error: `Agent image '${ref.value}' v${version} not found in library. Run 'SoftwareTeam agent-image list' to see what's installed.`,
          sessionName: canonicalSessionName,
        };
      }
      if (image.runtime !== input.member.runtime) {
        return {
          status: "failed",
          error: `Agent image '${ref.value}' v${version} runtime '${image.runtime}' does not match member '${input.member.id}' runtime '${input.member.runtime}'.`,
          sessionName: canonicalSessionName,
        };
      }
      forkSourceOpt = {
        forkSource: { kind: "native_id", value: image.sourceResumeToken },
      };
      // Pre-launch bump of lastUsedAt only — records the operator's
      // INTENT to consume the image. forkCount increments later, gated
      // on startupResult.ok===true (see post-startNode block below).
      // Best-effort: stat-write failures don't abort launch.
      try {
        library.recordConsumption(image.id, { incrementForkCount: false });
      } catch (err) {
        console.warn(`[softwareteam] agent-image stats update failed for ${image.id}: ${(err as Error).message}`);
      }
      // Stash the consumed image for the post-launch fork-count bump.
      consumedAgentImageId = image.id;
      consumedAgentImageLibrary = library;
    }

    // Agent Starter resolver dispatch (Agent Starter v1 vertical M2). When
    // `member.starterRef` is set, resolve the named registry entry into a
    // `ResolvedStartupFile[]` that prepends ahead of the member's per-agent
    // and per-pod startup files (the new STARTER layer at the front of the
    // layer chain). The resolver THROWS on a failed credential scan, missing
    // registry entry, or malformed YAML; on any throw we abort the launch
    // BEFORE `startNode` runs (no STARTER layer added; no adapter
    // `deliverStartup` called) — load-bearing credential-safety contract.
    let starterArtifacts: import("./runtime-adapter.js").ResolvedStartupFile[] | undefined;
    if (input.member.starterRef) {
      const { AgentStarterResolver } = await import("./agent-starter-resolver.js");
      const resolver = new AgentStarterResolver();
      try {
        const resolved = resolver.resolveStarter(input.member.starterRef.name);
        starterArtifacts = resolved.files;
      } catch (err) {
        return {
          status: "failed",
          error: `Agent Starter resolver failed: ${(err as Error).message}`,
          sessionName: canonicalSessionName,
          warnings: launchResult.warnings,
        };
      }
    }

    // STARTER layer (artifact-seeded fresh-launch context; precedes per-agent
    // and per-pod layers). Prepended to dedupedResolvedFiles so the existing
    // `startupOrchestrator.startNode` consumes the combined chain via the
    // existing `resolvedStartupFiles` input — NO new orchestrator branch.
    const finalResolvedStartupFiles = starterArtifacts
      ? [...starterArtifacts, ...dedupedResolvedFiles]
      : dedupedResolvedFiles;

    const startupResult = await this.deps.startupOrchestrator.startNode({
      softwareTeamId: input.softwareTeamId,
      nodeId: input.nodeId,
      sessionId: launchResult.session.id,
      binding,
      adapter,
      plan: planResult.plan,
      resolvedStartupFiles: finalResolvedStartupFiles,
      startupActions: [
        ...configResult.config.startup.actions,
        this.buildSessionIdentityAction({
          softwareTeamName: input.softwareTeamSpec.name,
          pod: input.pod,
          member: input.member,
          runtime: input.member.runtime,
          sessionName: canonicalSessionName,
          resolvedSpecName: configResult.config.resolvedSpecName,
        }),
      ],
      isRestore: false,
      ...(forkSourceOpt ?? {}),
      ...(rebuildArtifactsOpt ?? {}),
    });

    // Bump fork_count only on launch success. lastUsedAt already
    // updated optimistically in the agent_image dispatch branch above.
    if (startupResult.ok && consumedAgentImageId && consumedAgentImageLibrary) {
      try {
        consumedAgentImageLibrary.recordConsumption(consumedAgentImageId, { incrementForkCount: true });
      } catch (err) {
        console.warn(`[softwareteam] agent-image fork_count bump failed for ${consumedAgentImageId}: ${(err as Error).message}`);
      }
    }

    if (startupResult.ok && this.deps.continuityPolicyMaterializer) {
      try {
        this.deps.continuityPolicyMaterializer.arm({
          compactionStrategy: configResult.config.compactionStrategy as CompactionStrategy,
          mechanic: configResult.config.mechanic,
          runtime: input.member.runtime,
          targetSession: canonicalSessionName,
          sessionId: launchResult.session.id,
        });
      } catch (err) {
        (launchResult.warnings ??= []).push(
          `continuity policy was not armed for ${canonicalSessionName}: ${(err as Error).message}`,
        );
      }
    }

    // OPR.0.3.2.CT — preserve the attention_required distinction so
    // the instantiator can leave a recoverable softwareTeam + sessions instead
    // of zero-collapsing. The session row's startup_status was already
    // persisted by startupOrchestrator.fail() (see startup-orchestrator.ts
    // lines 223-225, 241-243).
    if (startupResult.ok) {
      return {
        status: "launched",
        sessionName: canonicalSessionName,
        warnings: startupResult.warnings?.length ? [...(launchResult.warnings ?? []), ...startupResult.warnings] : launchResult.warnings,
      };
    }
    return {
      status: startupResult.startupStatus === "attention_required" ? "attention_required" : "failed",
      error: startupResult.errors.join("; "),
      evidence: startupResult.evidence,
      sessionName: canonicalSessionName,
      warnings: startupResult.warnings?.length ? [...(launchResult.warnings ?? []), ...startupResult.warnings] : launchResult.warnings,
    };
  }

  private async launchExistingTerminalMember(input: {
    softwareTeamId: string;
    softwareTeamSpec: PodSoftwareTeamSpec;
    softwareTeamRoot: string;
    pod: SoftwareTeamSpecPod;
    member: SoftwareTeamSpecPodMember;
    qualifiedId: string;
    nodeId: string;
    cwdOverride?: string;
    envOverride?: SeatEnv;
  }): Promise<{ status: "launched" | "failed"; error?: string; sessionName?: string; warnings?: string[] }> {
    const guard = this.deps.tmuxAdapter?.deliveryGuard;
    if (guard && !guard.ownsLifecycle(input.nodeId)) {
      return guard.lifecycle([input.nodeId], () => this.launchExistingTerminalMember(input));
    }
    const effectiveCwd = resolveLaunchCwd(input.member.cwd, input.softwareTeamRoot, input.cwdOverride);
    const terminalPolicyAttachment = this.resolveMemberPolicyAttachment(input.member.permissionPolicy, input.softwareTeamSpec.permissionPolicy, input.softwareTeamRoot);
    if (terminalPolicyAttachment) this.persistNodePolicyProvenance(input.nodeId, terminalPolicyAttachment);
    const terminalLaunchPosture = terminalPolicyAttachment?.launchPosture
      ?? this.deps.softwareTeamRepo.getNodePolicyProvenance(input.nodeId)?.launchPosture
      ?? this.deps.softwareTeamRepo.getSoftwareTeamPolicyProvenance(input.softwareTeamId)?.launchPosture
      ?? "floor"; // R2 terminal: absence = the locked floor, explicitly
    const sessionNameErrors = validateSessionComponents(input.pod.id, input.member.id, input.softwareTeamSpec.name);
    if (sessionNameErrors.length > 0) {
      return { status: "failed", error: sessionNameErrors.join("; ") };
    }

    const canonicalSessionName = deriveCanonicalSessionName(input.pod.id, input.member.id, input.softwareTeamSpec.name);
    const launchResult = await this.deps.nodeLauncher.launchNode(input.softwareTeamId, input.qualifiedId, { sessionName: canonicalSessionName, env: input.envOverride });
    if (!launchResult.ok) {
      return { status: "failed", error: launchResult.message };
    }

    try {
      this.db.prepare("UPDATE nodes SET restore_policy = ? WHERE id = ?")
        .run("checkpoint_only", input.nodeId);
    } catch { /* best-effort */ }

    try {
      this.db.prepare("UPDATE sessions SET restore_policy = ? WHERE id = ?")
        .run("checkpoint_only", launchResult.session.id);
    } catch { /* best-effort */ }

    const startup = resolveStartup({
      specStartup: { files: [], actions: [] },
      profileStartup: undefined,
      softwareTeamCultureFile: input.softwareTeamSpec.cultureFile,
      softwareTeamStartup: input.softwareTeamSpec.startup,
      podStartup: input.pod.startup,
      memberStartup: input.member.startup,
      operatorStartup: undefined,
    });
    const resolvedFiles = this.buildTerminalResolvedStartupFiles(input.softwareTeamSpec, input.softwareTeamRoot, input.pod, input.member);
    const binding: NodeBinding = {
      id: launchResult.binding.id,
      nodeId: input.nodeId,
      tmuxSession: launchResult.binding.tmuxSession,
      tmuxWindow: null,
      tmuxPane: null,
      cmuxWorkspace: null,
      cmuxSurface: null,
      updatedAt: "",
      cwd: effectiveCwd,
      // Seam B: a terminal seat has no harness posture flag, but the resolved/persisted
      // posture (floor when absent) still binds for provenance-consuming consumers.
      launchPosture: terminalLaunchPosture,
    };
    const adapter = this.deps.adapters["terminal"];
    if (!adapter) {
      return { status: "failed", error: 'No adapter for runtime "terminal"', sessionName: canonicalSessionName, warnings: launchResult.warnings };
    }

    const emptyPlan = {
      entries: [],
      diagnostics: [],
      conflicts: [],
      noOps: [],
      runtime: "terminal",
      cwd: effectiveCwd,
    };

    const startupResult = await this.deps.startupOrchestrator.startNode({
      softwareTeamId: input.softwareTeamId,
      nodeId: input.nodeId,
      sessionId: launchResult.session.id,
      binding,
      adapter,
      plan: emptyPlan as any,
      resolvedStartupFiles: resolvedFiles,
      startupActions: startup.actions,
      isRestore: false,
    });

    return {
      status: startupResult.ok ? "launched" : "failed",
      error: startupResult.ok ? undefined : startupResult.errors.join("; "),
      sessionName: canonicalSessionName,
      warnings: startupResult.warnings?.length ? [...(launchResult.warnings ?? []), ...startupResult.warnings] : launchResult.warnings,
    };
  }

  private updateNodeResolvedConfig(
    nodeId: string,
    config: {
      restorePolicy: string;
      resolvedSpecName: string;
      resolvedSpecVersion: string;
      resolvedSpecHash: string;
      effort?: string;
    },
  ): void {
    try {
      this.db.prepare(
        `UPDATE nodes
         SET restore_policy = ?,
             resolved_spec_name = ?,
             resolved_spec_version = ?,
             resolved_spec_hash = ?
         WHERE id = ?`
      ).run(
        config.restorePolicy,
        config.resolvedSpecName,
        config.resolvedSpecVersion,
        config.resolvedSpecHash,
        nodeId,
      );
      // Always write the resolved effort — present value sets it, absent value
      // clears a previously-stored effort so spec changes take effect on next launch.
      // OPR.0.7.0.7: a seat's saved effort choice is a separate value; whether a refresh keeps
      // it is the founder's open precedence decision, asked of the one seam.
      const before = readSeatEffort(this.deps.softwareTeamRepo.db, nodeId);
      if (before?.choice && effortPrecedence.specRefreshChoice({
        choice: before.choice, authoredBefore: before.authored, authoredAfter: config.effort?.trim() || null,
      }) === "clear") {
        this.deps.softwareTeamRepo.setNodeEffortChoice(nodeId, null);
      }
      if (config.effort) {
        this.deps.softwareTeamRepo.setNodeEffort(nodeId, config.effort);
      } else {
        this.deps.softwareTeamRepo.clearNodeEffort(nodeId);
      }
    } catch {
      /* best-effort */
    }
  }

  private buildTerminalResolvedStartupFiles(
    softwareTeamSpec: PodSoftwareTeamSpec,
    softwareTeamRoot: string,
    pod: SoftwareTeamSpecPod,
    member: SoftwareTeamSpecPodMember,
  ): ResolvedStartupFile[] {
    const files: ResolvedStartupFile[] = [];

    // Skip layers 1-2 (agent base, profile) — terminal nodes have no agent spec
    // Layer 3: SoftwareTeam culture floor, then the software-team-specific overlay.
    files.push(defaultCultureStartupFile());
    if (softwareTeamSpec.cultureFile) {
      files.push({
        path: softwareTeamSpec.cultureFile,
        absolutePath: nodePath.resolve(softwareTeamRoot, softwareTeamSpec.cultureFile),
        ownerRoot: softwareTeamRoot,
        deliveryHint: "auto",
        required: true,
        appliesOn: ["fresh_start", "restore"],
      });
    }
    // Layer 4: SoftwareTeam startup
    if (softwareTeamSpec.startup) {
      for (const f of softwareTeamSpec.startup.files) {
        files.push({ ...f, absolutePath: nodePath.resolve(softwareTeamRoot, f.path), ownerRoot: softwareTeamRoot });
      }
    }
    // Layer 5: Pod startup
    if (pod.startup) {
      for (const f of pod.startup.files) {
        files.push({ ...f, absolutePath: nodePath.resolve(softwareTeamRoot, f.path), ownerRoot: softwareTeamRoot });
      }
    }
    // Layer 6: Member startup
    if (member.startup) {
      for (const f of member.startup.files) {
        files.push({ ...f, absolutePath: nodePath.resolve(softwareTeamRoot, f.path), ownerRoot: softwareTeamRoot });
      }
    }

    return this.resolveAutoHints(files);
  }

  private buildResolvedStartupFiles(
    agentSpec: { startup: { files: StartupFile[] } },
    agentSourcePath: string,
    profile: { startup?: { files: StartupFile[] } } | undefined,
    softwareTeamSpec: PodSoftwareTeamSpec,
    softwareTeamRoot: string,
    pod: SoftwareTeamSpecPod,
    member: SoftwareTeamSpecPodMember,
  ): ResolvedStartupFile[] {
    const files: ResolvedStartupFile[] = [];
    // nodePath imported at top level (ESM)

    // 1. Agent base startup
    for (const f of agentSpec.startup.files) {
      files.push({ ...f, absolutePath: nodePath.resolve(agentSourcePath, f.path), ownerRoot: agentSourcePath });
    }
    // 2. Profile startup
    if (profile?.startup) {
      for (const f of profile.startup.files) {
        files.push({ ...f, absolutePath: nodePath.resolve(agentSourcePath, f.path), ownerRoot: agentSourcePath });
      }
    }
    // 3. SoftwareTeam culture floor, then the software-team-specific overlay.
    files.push(defaultCultureStartupFile());
    if (softwareTeamSpec.cultureFile) {
      files.push({
        path: softwareTeamSpec.cultureFile,
        absolutePath: nodePath.resolve(softwareTeamRoot, softwareTeamSpec.cultureFile),
        ownerRoot: softwareTeamRoot,
        deliveryHint: "auto",
        required: true,
        appliesOn: ["fresh_start", "restore"],
      });
    }
    // 4. SoftwareTeam startup
    if (softwareTeamSpec.startup) {
      for (const f of softwareTeamSpec.startup.files) {
        files.push({ ...f, absolutePath: nodePath.resolve(softwareTeamRoot, f.path), ownerRoot: softwareTeamRoot });
      }
    }
    // 5. Pod startup
    if (pod.startup) {
      for (const f of pod.startup.files) {
        files.push({ ...f, absolutePath: nodePath.resolve(softwareTeamRoot, f.path), ownerRoot: softwareTeamRoot });
      }
    }
    // 6. Member startup
    if (member.startup) {
      for (const f of member.startup.files) {
        files.push({ ...f, absolutePath: nodePath.resolve(softwareTeamRoot, f.path), ownerRoot: softwareTeamRoot });
      }
    }

    // 7. Built-in SoftwareTeam onboarding overlay (appended last, does not replace agent guidance)
    const onboardingPath = nodePath.resolve(import.meta.dirname, "../../assets/guidance/softwareteam-start.md");
    files.push({
      path: "softwareteam-start.md",
      absolutePath: onboardingPath,
      ownerRoot: nodePath.resolve(import.meta.dirname, "../../assets"),
      deliveryHint: "guidance_merge",
      required: false,
      appliesOn: ["fresh_start", "restore"],
    });

    if (this.deps.onboardingEnabledResolver?.() ?? true) {
      const assetsRoot = nodePath.resolve(import.meta.dirname, "../../assets");
      files.push(
        {
          path: "softwareteam-onboarding-01.md",
          absolutePath: nodePath.resolve(import.meta.dirname, "../../assets/onboarding/01-world-and-purpose.md"),
          ownerRoot: assetsRoot,
          deliveryHint: "guidance_merge",
          required: true,
          appliesOn: ["fresh_start"],
        },
        {
          path: "softwareteam-onboarding-02.md",
          absolutePath: nodePath.resolve(import.meta.dirname, "../../assets/onboarding/02-self-and-competent-action.md"),
          ownerRoot: assetsRoot,
          deliveryHint: "guidance_merge",
          required: true,
          appliesOn: ["fresh_start"],
        },
      );
    }

    return this.resolveAutoHints(files);
  }

  private dedupeProjectedManagedStartupFiles(
    plan: ProjectionPlan,
    files: ResolvedStartupFile[],
  ): ResolvedStartupFile[] {
    const projectedManagedGuidancePaths = new Set(
      plan.entries
        .filter((entry) => entry.category === "guidance" && entry.mergeStrategy === "managed_block")
        .map((entry) => entry.absolutePath),
    );
    return files.filter((file) => {
      if (file.deliveryHint !== "guidance_merge") {
        return true;
      }
      return !projectedManagedGuidancePaths.has(file.absolutePath);
    });
  }

  private buildSessionIdentityAction(input: {
    softwareTeamName: string;
    pod: SoftwareTeamSpecPod;
    member: SoftwareTeamSpecPodMember;
    runtime: string;
    sessionName: string;
    resolvedSpecName?: string | null;
  }): StartupAction {
    const lines = [
      input.sessionName,
      "SoftwareTeam session identity:",
      `- softwareTeam: ${input.softwareTeamName}`,
      `- pod: ${input.pod.id}`,
      `- pod_label: ${input.pod.label}`,
      `- member: ${input.member.id}`,
      input.member.label ? `- member_label: ${input.member.label}` : null,
      `- logical_id: ${input.pod.id}.${input.member.id}`,
      input.resolvedSpecName ? `- agent_spec: ${input.resolvedSpecName}` : null,
      `- runtime: ${input.runtime}`,
      `- session: ${input.sessionName}`,
      "This is your startup identity hint. For durable identity recovery after compaction, run:",
      "  SoftwareTeam whoami --json",
      "That command returns your full topology context: softwareTeam, pod, peers, edges, and transcript path.",
      "If its peersNote says some peers are not shown, SoftwareTeam whoami --json --all-peers lists them all.",
    ].filter((line): line is string => Boolean(line));

    return {
      type: "send_text",
      value: lines.join("\n"),
      phase: "after_ready",
      appliesOn: ["fresh_start", "restore"],
      idempotent: true,
      builtin: "session_identity",
    };
  }

  /**
   * Resolve any remaining 'auto' delivery hints to concrete hints at plan time.
   * Uses the shared resolveConcreteHint resolver (single source of truth).
   * After this, no file should have deliveryHint === 'auto'.
   */
  private resolveAutoHints(files: ResolvedStartupFile[]): ResolvedStartupFile[] {
    return files.map((f) => {
      if (f.deliveryHint !== "auto") return f;
      try {
        const content = this.deps.fsOps.readFile(f.absolutePath);
        return { ...f, deliveryHint: resolveConcreteHint(f.path, content) };
      } catch {
        // If file can't be read, default to send_text (safest — delivered after harness ready)
        return { ...f, deliveryHint: "send_text" as const };
      }
    });
  }
}
