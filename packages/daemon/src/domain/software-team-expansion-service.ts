import type Database from "better-sqlite3";
import type { SoftwareTeamRepository } from "./software-team-repository.js";
import type { EventBus } from "./event-bus.js";
import type { NodeLauncher } from "./node-launcher.js";
import type { PodSoftwareTeamInstantiator } from "./software-team-spec-instantiator.js";
import type { SessionRegistry } from "./session-registry.js";
import type { ExpansionRequest, ExpansionResult, ExpansionNodeOutcome } from "./types.js";
import { SoftwareTeamSpecSchema as PodSoftwareTeamSpecSchema } from "./software-team-spec-schema.js";

interface SoftwareTeamExpansionServiceDeps {
  db: Database.Database;
  softwareTeamRepo: SoftwareTeamRepository;
  eventBus: EventBus;
  nodeLauncher: NodeLauncher;
  podInstantiator: PodSoftwareTeamInstantiator;
  sessionRegistry: SessionRegistry;
}

/**
 * Orchestrates live softwareTeam expansion by composing PodSoftwareTeamInstantiator.materialize()
 * for topology persistence and NodeLauncher for launching new nodes.
 */
export class SoftwareTeamExpansionService {
  private deps: SoftwareTeamExpansionServiceDeps;

  constructor(deps: SoftwareTeamExpansionServiceDeps) {
    this.deps = deps;
  }

  async expand(request: ExpansionRequest): Promise<ExpansionResult> {
    // 1. Validate softwareTeam exists
    const softwareTeam = this.deps.softwareTeamRepo.getSoftwareTeam(request.softwareTeamId);
    if (!softwareTeam) {
      return { ok: false, code: "software_team_not_found", error: `SoftwareTeam "${request.softwareTeamId}" not found` };
    }

    // 2. Build the one-pod spec as a structured OBJECT (OPR.0.3.3.24: no
    // synthetic-spec YAML round-trip). It flows through the materialize
    // structured-front (validate + preflight + persistence core) and the launch
    // core directly.
    const pod = request.pod;
    const specObject = this.buildExpansionSpecObject(softwareTeam.softwareTeam.name, pod, request.crossPodEdges);

    // 3. Materialize topology (suppress softwareTeam.imported event)
    const materializeResult = await this.deps.podInstantiator.materializeStructured(
      specObject,
      request.softwareTeamRoot ?? ".",
      { targetSoftwareTeamId: request.softwareTeamId, suppressSummaryEvent: true },
    );

    if (!materializeResult.ok) {
      const code = materializeResult.code;
      const message = "message" in materializeResult
        ? materializeResult.message
        : "errors" in materializeResult
          ? materializeResult.errors.join("; ")
          : "materialization failed";
      return { ok: false, code, error: message };
    }

    // 4. Find the newly created pod and nodes
    const updatedSoftwareTeam = this.deps.softwareTeamRepo.getSoftwareTeam(request.softwareTeamId)!;
    const newNodes = materializeResult.result.nodes;
    const newPod = updatedSoftwareTeam.nodes
      .filter((n) => newNodes.some((nn) => nn.logicalId === n.logicalId))
      .map((n) => n.podId)
      .find((id) => id !== null);

    const podId = newPod ?? "";
    const podNamespace = pod.id;

    // 5. Launch and fully start the newly created nodes via the launch core on
    // the structured spec (no YAML round-trip; normalize is pure).
    const launchOutcome = await this.deps.podInstantiator.launchValidatedSpec(
      PodSoftwareTeamSpecSchema.normalize(specObject as Record<string, unknown>),
      request.softwareTeamRoot ?? ".",
      request.softwareTeamId,
    );
    if (!launchOutcome.ok) {
      const message = "message" in launchOutcome
        ? launchOutcome.message
        : "errors" in launchOutcome
          ? launchOutcome.errors.join("; ")
          : "launch failed";
      return { ok: false, code: launchOutcome.code, error: message };
    }

    const nodeOutcomes: ExpansionNodeOutcome[] = launchOutcome.result.nodes.map((node) => ({
      logicalId: node.logicalId,
      nodeId: node.nodeId,
      status: node.status,
      error: node.error,
      sessionName: node.sessionName,
    }));
    const warnings = [
      ...(materializeResult.result.warnings ?? []),
      ...(launchOutcome.result.warnings ?? []),
    ];
    const retryTargets = nodeOutcomes
      .filter((node) => node.status === "failed")
      .map((node) => node.logicalId);

    // 6. Determine overall status
    const launched = nodeOutcomes.filter((n) => n.status === "launched").length;
    const failed = nodeOutcomes.filter((n) => n.status === "failed").length;
    const status: "ok" | "partial" | "failed" = failed === 0 ? "ok" : launched > 0 ? "partial" : "failed";

    // 7. Emit softwareTeam.expanded event
    this.deps.eventBus.emit({
      type: "softwareTeam.expanded",
      softwareTeamId: request.softwareTeamId,
      podId,
      podNamespace,
      nodes: nodeOutcomes,
      status,
    });

    return {
      ok: true,
      status,
      podId,
      podNamespace,
      nodes: nodeOutcomes,
      warnings,
      retryTargets,
    };
  }

  private buildExpansionSpecObject(
    softwareTeamName: string,
    pod: ExpansionRequest["pod"],
    crossPodEdges?: ExpansionRequest["crossPodEdges"],
  ): Record<string, unknown> {
    const syntheticSpec: Record<string, unknown> = {
      version: "0.2",
      name: softwareTeamName,
      pods: [
        {
          id: pod.id,
          label: pod.label,
          ...(pod.summary ? { summary: pod.summary } : {}),
          members: pod.members.map((member) => ({
            id: member.id,
            runtime: member.runtime,
            ...(member.agentRef ? { agent_ref: member.agentRef } : {}),
            ...(member.profile ? { profile: member.profile } : {}),
            ...(member.codexConfigProfile ? { codex_config_profile: member.codexConfigProfile } : {}),
            // OPR.0.4.8.3 Seam B: permission_policy rides the fragment→spec map like role.
            // R2 (4ac243c3): PRESENCE-preserving — present-invalid values (null, …) flow
            // to the canonical validator; only a truly absent key is omitted.
            ...("permissionPolicy" in member && member.permissionPolicy !== undefined
              ? { permission_policy: member.permissionPolicy }
              : {}),
            ...(member.cwd ? { cwd: member.cwd } : {}),
            ...(member.model ? { model: member.model } : {}),
            // OPR.0.4.6.FAC1: role rides the fragment→spec map (a
            // provided role must never be silently dropped here).
            ...(member.role ? { role: member.role } : {}),
            ...(member.restorePolicy ? { restore_policy: member.restorePolicy } : {}),
            ...(member.label ? { label: member.label } : {}),
            // OPR.0.5.6.3 repair amendment: session_source is carried FAITHFULLY —
            // the route already normalizes valid shapes to the typed spec (whose
            // field names are identical in snake_case form), and a present-INVALID
            // value rides through RAW so the ONE canonical SoftwareTeamSpec validator
            // rejects it structurally. A field-by-field re-map here was the
            // original drop site (ref.version, wave-1 R2) and would crash on
            // preserved-raw input; a faithful carry has no field list to forget.
            // KEY PRESENCE, never truthiness, governs emission: null/false/
            // primitive raw values must not vanish before canonical validation.
            ...("sessionSource" in member ? { session_source: member.sessionSource } : {}),
            ...(member.starterRef ? {
              starter_ref: { name: member.starterRef.name },
            } : {}),
          })),
          edges: pod.edges.map((edge) => ({
            kind: edge.kind,
            from: edge.from,
            to: edge.to,
          })),
        },
      ],
      edges: (crossPodEdges ?? []).map((edge) => ({
        kind: edge.kind,
        from: edge.from,
        to: edge.to,
      })),
    };

    return syntheticSpec;
  }
}
