import { claudeActivityRelayPath } from "./claude-activity-hooks.js";
import { existsSync, accessSync, constants } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { getCompatibleSoftwareTeamPath } from "../softwareteam-compat.js";
import { shellQuote as quoteShellArgument } from "../adapters/shell-quote.js";
import { reanchorBuiltinStartupFile, reanchorShippedProjectionEntry } from "./builtin-startup-files.js";
import { validatePreRestore } from "./restore-preconditions.js";
import type { CurrentStateRehydrateEligibility } from "./rehydrate-eligibility.js";
import type { Snapshot, SoftwareTeamServicesRecord, SeatIdentityVerdict } from "./types.js";

// --- Types ---

export type CheckStatus = "green" | "yellow" | "red";
export type Verdict = "restorable" | "restorable_with_caveats" | "not_restorable" | "unknown";
export type ReadinessStatus = "ready" | "ready_with_caveats" | "not_ready" | "unknown";
export type HostInfraStatus = "not_inspected" | "not_declared" | "declared" | "unknown";

export interface CheckEntry {
  check: string;
  status: CheckStatus;
  evidence: string;
  remediation: string;
  /** Whether the remediation action is execution-safe (read-only / manual
   *  inspection). false for mutating actions (daemon start, chmod, create
   *  files, snapshot). Defaults to false (unsafe) if omitted — conservative
   *  so new checks without explicit classification don't invite agents to
   *  auto-execute mutating commands. */
  remediationSafe?: boolean;
}

export interface RepairStep {
  step: number;
  command: string;
  rationale: string;
  safe: boolean;
  blocking: boolean;
}

export interface ReadinessAssertion {
  status: ReadinessStatus;
  reason: string;
  blockingSoftwareTeamCount: number;
  caveatSoftwareTeamCount: number;
  unknownSoftwareTeamCount: number;
}

export interface ContinuityAssertion {
  status: "proven" | "not_proven" | "partial" | "not_applicable";
  evidence: string;
  provenCapabilities: string[];
  unprovenCapabilities: string[];
}

// OPR.0.4.0.29 FR-8 — ready-confidence breakdown by the 5 REAL-enum seat
// classes. Each derives from a real primitive (no invented status): ready /
// ready_with_caveats / not_ready come from the seat readiness checks;
// attention_required from node.startupStatus; unknown is the indeterminate
// remainder. (The fresh-primed/awaiting-decision SPLIT of ready_with_caveats is
// the deferred/escalated follow-on — NOT emitted here.)
export interface ReadinessClassCounts {
  ready: number;
  ready_with_caveats: number;
  not_ready: number;
  attention_required: number;
  unknown: number;
}

export interface SoftwareTeamRestoreRollup {
  softwareTeamId: string;
  softwareTeamName: string;
  status: ReadinessStatus;
  verdict: Verdict;
  expectedNodes: number;
  runningReadyNodes: number;
  blockedNodes: number;
  caveatNodes: number;
  classCounts: ReadinessClassCounts;
  blockingChecks: CheckEntry[];
  caveatChecks: CheckEntry[];
}

export interface HostInfraAssertion {
  status: HostInfraStatus;
  evidence: string;
}

export type RecoveryStatus = "not_needed" | "actionable" | "blocked" | "unknown";

export interface RecoveryAction {
  scope: "softwareTeam";
  softwareTeamId: string;
  softwareTeamName: string;
  action: "restore_from_latest_snapshot";
  command: string;
  reason: string;
  safe: boolean;
  blocking: boolean;
}

export interface RecoveryIssue {
  scope: "host" | "softwareTeam";
  softwareTeamId?: string;
  softwareTeamName?: string;
  reason: string;
}

export interface RecoveryPlan {
  status: RecoveryStatus;
  summary: string;
  actions: RecoveryAction[];
  blocked: RecoveryIssue[];
  unknown: RecoveryIssue[];
}

export interface StartupContextResolvedFile {
  absolutePath: string;
  required: boolean;
  path?: string | null;
  deliveryHint?: string | null;
  ownerRoot?: string | null;
}

export interface StartupContextProjectionEntry {
  absolutePath: string;
  effectiveId?: string | null;
  category?: string | null;
  sourcePath?: string | null;
  resourceType?: string | null;
}

export interface QueueStoreProbeResult {
  available: boolean;
  evidence: string;
}

export type StartupContextProbeResult =
  | {
      status: "ok";
      runtime: string | null;
      resolvedStartupFiles: StartupContextResolvedFile[];
      projectionEntries: StartupContextProjectionEntry[];
    }
  | {
      status: "missing" | "malformed" | "probe_error";
      evidence: string;
    };

export interface RestoreCheckResult {
  verdict: Verdict;
  readiness: ReadinessAssertion;
  continuity: ContinuityAssertion;
  softwareTeams: SoftwareTeamRestoreRollup[];
  hostInfra: HostInfraAssertion;
  recovery: RecoveryPlan;
  counts: { red: number; yellow: number; green: number };
  /** OPR.0.4.0.29 FR-8 — fleet-wide ready-confidence breakdown by class. */
  classCounts: ReadinessClassCounts;
  checks: CheckEntry[];
  repairPacket: RepairStep[] | null;
}

export interface RestoreCheckOpts {
  softwareTeam?: string;
  noQueue?: boolean;
  noHooks?: boolean;
  compact?: boolean;
  /** OPR.0.4.0.29 FR-2: in compact mode, still assemble ready-seat detail so
   *  `--ready` shows ready seats without dropping to the full firehose. */
  includeReady?: boolean;
  /** Composed status polls need preconditions only for softwareTeams needing recovery. */
  recoveryOnly?: boolean;
}

// --- Deps (framework-free per ADR-0001; reads from existing projections per ADR-0002) ---

export interface NodeInventoryEntry {
  nodeId?: string | null;
  softwareTeamId: string;
  softwareTeamName: string;
  logicalId: string;
  podId: string | null;
  podNamespace?: string | null;
  canonicalSessionName: string | null;
  nodeKind: "agent" | "infrastructure";
  runtime: string | null;
  sessionStatus: string | null;
  startupStatus: string | null;
  storedStartupStatus?: string | null;
  identityVerdict?: SeatIdentityVerdict | null;
  tmuxAttachCommand: string | null;
  latestError: string | null;
  cwd?: string | null;
}

export interface RestoreCheckDeps {
  /** Get all softwareTeams as summaries */
  listSoftwareTeams: () => Array<{ softwareTeamId: string; name: string; hasServices?: boolean }>;
  /** Get node inventory for a softwareTeam (ADR-0002: NodeInventory projection) */
  getNodeInventory: (softwareTeamId: string) => NodeInventoryEntry[];
  /** Get persisted startup context for a node */
  getStartupContext: (nodeId: string) => StartupContextProbeResult;
  /** Check if a snapshot exists for a softwareTeam */
  hasSnapshot: (softwareTeamId: string) => boolean;
  /** Get the newest snapshot for exact restore planning when available */
  getLatestSnapshot?: (softwareTeamId: string) => { id: string; kind: string } | null;
  /** Exact ordinary-restore input; never captures an auto-rehydrate snapshot. */
  getRestoreInputs: (softwareTeamId: string) =>
    | { snapshot: Pick<Snapshot, "id" | "kind" | "data">; servicesRecord: SoftwareTeamServicesRecord | null }
    | { currentStateRehydrate: CurrentStateRehydrateEligibility; reason: string }
    | { unavailable: string };
  /** Probe daemon health: returns { healthy: boolean; evidence: string } */
  probeDaemonHealth: () => { healthy: boolean; evidence: string };
  /** Filesystem probes */
  exists: (path: string) => boolean;
  /** Read a declaration/config file. Kept injectable so restore-check remains testable and source-safe. */
  readFile: (path: string) => string;
  /** Shared-docs root for softwareTeam spec path resolution. */
  substrateRoot?: string;
  /** Read-only probe of the daemon SQLite queue store. */
  probeQueueStore?: () => QueueStoreProbeResult;
  /** Configured SoftwareTeam instance root, matching the Claude adapter stateDir. */
  stateDir?: string;
  /** Relay-backed Claude hook events derived from the shipped hook manifest. */
  getClaudeActivityHookEvents?: () => string[];
}

interface SoftwareTeamRollupInput {
  softwareTeam: { softwareTeamId: string; name: string };
  nodes: NodeInventoryEntry[];
  checks: CheckEntry[];
  preconditionError?: string;
}

interface RecoverySoftwareTeamInput {
  softwareTeamId: string;
  softwareTeamName: string;
  expectedNodes: number;
  runningReadyNodes: number;
  blockingChecks: CheckEntry[];
  latestSnapshot: { id: string; kind: string } | null;
  snapshotLookupError?: string;
}

interface HostInfraCheckResult {
  check: CheckEntry;
  hostInfra: HostInfraAssertion;
}

// --- Service ---

const DAEMON_HEALTHY_PATTERN = /^Daemon running\b/m;
export class RestoreCheckService {
  private deps: RestoreCheckDeps;

  constructor(deps: RestoreCheckDeps) {
    this.deps = deps;
  }

  /**
   * Compute scoped restore checks and recovery guidance from daemon, softwareTeam and
   * seat evidence without launching occupants.
   */
  check(opts: RestoreCheckOpts): RestoreCheckResult {
    const checks: CheckEntry[] = [];
    // rev1-r2 no-false-ready: ready-seat caveat signals that default compact
    // COMPUTES but does NOT emit (AC-4 token-safe) still count toward the
    // top-level verdict/readiness/counts, so the headline never reports a false
    // ready while a softwareTeam rollup is ready_with_caveats.
    const deferredAssessmentChecks: CheckEntry[] = [];
    const softwareTeamRollupInputs: SoftwareTeamRollupInput[] = [];
    const recoverySoftwareTeamInputs: RecoverySoftwareTeamInput[] = [];
    const restoreInputsBySoftwareTeam = new Map<string, { snapshot: { id: string; kind: string } | null; error?: string }>();

    // Host-level checks — daemon probe throw produces unknown (not not_restorable).
    // Daemon definitely-down (healthy=false, negative text) is red/not_restorable.
    // Daemon probe exception (socket unavailable, etc.) is unknown.
    const daemonCheck = this.checkDaemonReachable();
    if (daemonCheck === null) {
      // Probe threw — state is uninspectable
      return this.buildUnknown([
        { check: "daemon.reachable", status: "red", evidence: "Daemon health probe failed (unable to determine state)", remediation: "Start the daemon with: SoftwareTeam daemon start",
      remediationSafe: false },
      ]);
    }
    checks.push(daemonCheck);
    checks.push(this.checkStateDirWritable());
    const hostInfraCheck = this.checkHostInfraDeclaration();
    checks.push(hostInfraCheck.check);

    // Get softwareTeams — probe error produces unknown, not not_restorable
    let softwareTeams: Array<{ softwareTeamId: string; name: string; hasServices?: boolean }>;
    try {
      softwareTeams = this.deps.listSoftwareTeams();
    } catch (err) {
      return this.buildUnknown([
        ...checks,
        { check: "probe.error", status: "red", evidence: `Failed to list softwareTeams: ${err instanceof Error ? err.message : String(err)}`, remediation: "Check daemon status with: SoftwareTeam daemon status", remediationSafe: true },
      ]);
    }

    if (opts.softwareTeam) {
      softwareTeams = softwareTeams.filter((r) => r.name === opts.softwareTeam);
      if (softwareTeams.length === 0) {
        return this.buildResult([
          ...checks,
          { check: `softwareTeam.${opts.softwareTeam}.exists`, status: "red", evidence: `SoftwareTeam "${opts.softwareTeam}" not found`, remediation: "List softwareTeams with: SoftwareTeam ps", remediationSafe: true },
        ], [], hostInfraCheck.hostInfra);
      }
    }

    // Per-softwareTeam checks
    for (const softwareTeam of softwareTeams) {
      const softwareTeamChecks: CheckEntry[] = [];

      const snapshotCheck = this.checkSnapshot(softwareTeam);
      checks.push(snapshotCheck);
      softwareTeamChecks.push(snapshotCheck);

      // SoftwareTeam spec/root check
      const specCheck = this.checkSpecPresent(softwareTeam);
      checks.push(specCheck);
      softwareTeamChecks.push(specCheck);

      // Per-seat checks — probe error produces unknown, not not_restorable
      let nodes: NodeInventoryEntry[];
      try {
        nodes = this.deps.getNodeInventory(softwareTeam.softwareTeamId);
      } catch (err) {
        return this.buildUnknown([
          ...checks,
          { check: "probe.error", status: "red", evidence: `Failed to get node inventory for ${softwareTeam.name}: ${err instanceof Error ? err.message : String(err)}`, remediation: "Check daemon status" },
        ]);
      }

      // No added snapshot/history read on a routine status poll for an all-ready softwareTeam.
      // Explicit restore-check still assesses its next restore, even while it is running.
      let preconditionError: string | undefined;
      const allReady = nodes.length > 0 && nodes.every((node) =>
        Boolean(node.canonicalSessionName) && node.sessionStatus === "running" && node.startupStatus === "ready"
      );
      if (!opts.recoveryOnly || !allReady) {
        const preconditions = this.checkRestorePreconditions(softwareTeam, nodes);
        checks.push(preconditions.check);
        softwareTeamChecks.push(preconditions.check);
        preconditionError = preconditions.error;
        restoreInputsBySoftwareTeam.set(softwareTeam.softwareTeamId, { snapshot: preconditions.snapshot, error: preconditions.error });
      }

      for (const node of nodes) {
        const readinessCheck = this.checkSeatReadiness(node);
        checks.push(readinessCheck);
        softwareTeamChecks.push(readinessCheck);

        // OPR.0.4.0.29: in default compact, ready (green) seats SKIP full per-seat
        // detail assembly — the FR-3/AC-4 compute "look-above" win (transcript,
        // resume, queue, hooks are NOT probed). But the FR-8 summary still needs
        // the restore-readiness caveat signal: a running/ready seat whose startup
        // context is missing/unrestorable is ready_with_caveats, not ready. So we
        // compute ONLY checkStartupContext for every seat and feed it to the softwareTeam
        // rollup (softwareTeamChecks); it is emitted to the top-level `checks` only when we
        // are not skipping (full, --ready/includeReady, or a non-ready seat).
        const omitReadyDetail = opts.compact && !opts.includeReady && readinessCheck.status === "green";

        const startupContextCheck = this.checkStartupContext(node);
        if ("unknownChecks" in startupContextCheck) {
          return this.buildUnknown([
            ...checks,
            ...startupContextCheck.unknownChecks,
          ]);
        }
        softwareTeamChecks.push(startupContextCheck.check);
        if (omitReadyDetail) {
          // Not emitted (AC-4 token-safe), but counts toward the top-level
          // verdict/readiness/counts (rev1-r2 no-false-ready).
          deferredAssessmentChecks.push(startupContextCheck.check);
        } else {
          checks.push(startupContextCheck.check);
        }

        // AC-4 / FR-3: default compact does NOT assemble the rest of the
        // ready-seat detail (the genuine compute skip, not a post-assembly hide).
        if (omitReadyDetail) {
          continue;
        }

        const transcriptCheck = this.checkTranscript(softwareTeam.name, node);
        checks.push(transcriptCheck);
        softwareTeamChecks.push(transcriptCheck);

        const resumeCheck = this.checkResumePath(node, softwareTeam.name);
        checks.push(resumeCheck);
        softwareTeamChecks.push(resumeCheck);

        if (!opts.noQueue) {
          const queueCheck = this.checkQueueStore(node);
          checks.push(queueCheck);
          softwareTeamChecks.push(queueCheck);
        }
        if (!opts.noHooks) {
          const hooksCheck = this.checkHooks(node);
          checks.push(hooksCheck);
          softwareTeamChecks.push(hooksCheck);
        }
      }

      softwareTeamRollupInputs.push({ softwareTeam, nodes, checks: softwareTeamChecks, preconditionError });
    }

    const softwareTeamRollups = softwareTeamRollupInputs.map((input) => this.buildSoftwareTeamRollup(input));
    for (const rollup of softwareTeamRollups) {
      const latestSnapshot = restoreInputsBySoftwareTeam.get(rollup.softwareTeamId) ?? this.inspectLatestSnapshot(rollup.softwareTeamId);
      recoverySoftwareTeamInputs.push({
        softwareTeamId: rollup.softwareTeamId,
        softwareTeamName: rollup.softwareTeamName,
        expectedNodes: rollup.expectedNodes,
        runningReadyNodes: rollup.runningReadyNodes,
        blockingChecks: rollup.blockingChecks,
        latestSnapshot: latestSnapshot.snapshot,
        snapshotLookupError: latestSnapshot.error,
      });
    }

    return this.buildResult(checks, softwareTeamRollups, hostInfraCheck.hostInfra, recoverySoftwareTeamInputs, deferredAssessmentChecks);
  }

  private checkRestorePreconditions(softwareTeam: { softwareTeamId: string; name: string }, inventory: NodeInventoryEntry[]): {
    check: CheckEntry;
    snapshot: { id: string; kind: string } | null;
    error?: string;
  } {
    const check = `softwareTeam.${softwareTeam.name}.restore-preconditions`;
    try {
      const input = this.deps.getRestoreInputs(softwareTeam.softwareTeamId);
      if ("unavailable" in input) throw new Error(input.unavailable);
      if ("currentStateRehydrate" in input) {
        const { ok, blockers } = input.currentStateRehydrate;
        return {
          snapshot: null,
          check: {
            check,
            status: ok ? "yellow" : "red",
            evidence: ok
              ? `${input.reason}; restore inputs not inspected. Current-state rehydrate is eligible to attempt: ordinary SoftwareTeam up would capture current state. This does not validate that future snapshot or prove native continuity.`
              : `${input.reason}; current-state rehydrate is not eligible: ${blockers.join("; ")}`,
            remediation: "Inspect the softwareTeam's persisted state before choosing manual recovery",
            remediationSafe: true,
          },
        };
      }
      const validation = validatePreRestore(input.snapshot.data, {
        fsOps: { exists: this.deps.exists },
        servicesRecord: input.servicesRecord,
        currentRuntimes: Object.fromEntries(inventory.map((current) => [current.logicalId, current.runtime])),
      });
      const { blockers, warnings } = validation;
      return {
        snapshot: { id: input.snapshot.id, kind: input.snapshot.kind },
        check: {
          check,
          status: blockers.length > 0 ? "red" : warnings.length > 0 ? "yellow" : "green",
          evidence: `Snapshot ${input.snapshot.id}: ${[
            ...blockers.map((blocker) => `${blocker.code}: ${blocker.message}`),
            ...warnings,
          ].join("; ") || "restore pre-validation passed (not a native resume proof)"}`,
          remediation: blockers.map((blocker) => blocker.remediation).join("; "),
          remediationSafe: false,
        },
      };
    } catch (err) {
      const error = `Restore preconditions unavailable for ${softwareTeam.name}: ${err instanceof Error ? err.message : String(err)}`;
      return {
        snapshot: null,
        error,
        check: { check, status: "yellow", evidence: error, remediation: "Inspect the softwareTeam's restore snapshot and persisted inputs before trusting restore", remediationSafe: true },
      };
    }
  }

  /** Returns CheckEntry on success/definite-down; null on probe exception
   *  (uninspectable state → caller should produce verdict: unknown). */
  private checkDaemonReachable(): CheckEntry | null {
    try {
      const probe = this.deps.probeDaemonHealth();
      // Anchored positive match: only "Daemon running" at line start is green.
      // Anything else (including "Daemon not running", empty output, or text
      // that contains "running" non-anchored) is red. This preserves the
      // reviewer fix from prototype 0e2af8d.
      if (probe.healthy && DAEMON_HEALTHY_PATTERN.test(probe.evidence)) {
        return { check: "daemon.reachable", status: "green", evidence: probe.evidence, remediation: "" };
      }
      return {
        check: "daemon.reachable", status: "red",
        evidence: probe.evidence || "Daemon health probe returned non-positive result",
        remediation: "Start the daemon with: SoftwareTeam daemon start",
      remediationSafe: false,
      };
    } catch {
      // Probe threw — return null to signal uninspectable state
      return null;
    }
  }

  private checkStateDirWritable(): CheckEntry {
    const stateDir = getCompatibleSoftwareTeamPath("");
    try {
      // Non-mutating permission probe — no file creation/deletion.
      // accessSync throws if the directory is not writable.
      accessSync(stateDir, constants.W_OK);
      return { check: "host.state-dir-writable", status: "green", evidence: `${stateDir} is writable`, remediation: "" };
    } catch {
      return {
        check: "host.state-dir-writable", status: "red",
        evidence: `${stateDir} is not writable`,
        remediation: `Fix permissions: chmod u+w ${stateDir}`,
      remediationSafe: false,
      };
    }
  }

  private checkHostInfraDeclaration(): HostInfraCheckResult {
    const declarationPath = getCompatibleSoftwareTeamPath("host-infra.json");
    const check = "host.bootstrap-autostart.declaration";

    try {
      if (!this.deps.exists(declarationPath)) {
        const evidence = `Host infra declaration missing at ${declarationPath}`;
        return {
          check: {
            check,
            status: "yellow",
            evidence,
            remediation: `Create host infra declaration at ${declarationPath}`,
            remediationSafe: false,
          },
          hostInfra: {
            status: "not_declared",
            evidence,
          },
        };
      }

      let raw: string;
      try {
        raw = this.deps.readFile(declarationPath);
      } catch (err) {
        const evidence = `Host infra declaration inspection failed at ${declarationPath}: ${err instanceof Error ? err.message : String(err)}`;
        return {
          check: {
            check,
            status: "yellow",
            evidence,
            remediation: `Inspect or fix host infra declaration at ${declarationPath}`,
            remediationSafe: false,
          },
          hostInfra: {
            status: "unknown",
            evidence,
          },
        };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        const evidence = `Host infra declaration JSON parse failed at ${declarationPath}: ${err instanceof Error ? err.message : String(err)}`;
        return {
          check: {
            check,
            status: "yellow",
            evidence,
            remediation: `Fix host infra declaration JSON at ${declarationPath}`,
            remediationSafe: false,
          },
          hostInfra: {
            status: "not_declared",
            evidence,
          },
        };
      }

      const validation = this.validateHostInfraDeclaration(parsed);
      if (validation.errors.length > 0) {
        const evidence = `Invalid host infra declaration at ${declarationPath}: missing/invalid ${validation.errors.join(", ")}`;
        return {
          check: {
            check,
            status: "yellow",
            evidence,
            remediation: `Fix host infra declaration shape at ${declarationPath}`,
            remediationSafe: false,
          },
          hostInfra: {
            status: "not_declared",
            evidence,
          },
        };
      }

      if (validation.schemaVersion === 2 && validation.evidenceProblems.length > 0) {
        const evidence = `Host infra declaration at ${declarationPath} declared with insufficient evidence paths; ${validation.evidenceProblems.join("; ")}`;
        return {
          check: {
            check,
            status: "yellow",
            evidence,
            remediation: `Add or repair host infra evidence path(s): ${validation.evidenceProblems.join("; ")}`,
            remediationSafe: false,
          },
          hostInfra: {
            status: "declared",
            evidence,
          },
        };
      }

      const evidence = validation.schemaVersion === 2
        ? `Host infra declaration at ${declarationPath} declared, evidence paths present, not autostart verified; daemonBootstrap mechanism=${validation.mechanism}; requiredSupportingInfra=${validation.requiredSupportingInfra}; evidencePaths=${validation.evidencePaths.join(", ")}`
        : `Host infra declaration at ${declarationPath} declared, not verified; daemonBootstrap mechanism=${validation.mechanism}; requiredSupportingInfra=${validation.requiredSupportingInfra}`;
      return {
        check: {
          check,
          status: "green",
          evidence,
          remediation: "",
        },
        hostInfra: {
          status: "declared",
          evidence,
        },
      };
    } catch (err) {
      const evidence = `Host infra declaration inspection failed at ${declarationPath}: ${err instanceof Error ? err.message : String(err)}`;
      return {
        check: {
          check,
          status: "yellow",
          evidence,
          remediation: `Inspect or fix host infra declaration at ${declarationPath}`,
          remediationSafe: false,
        },
        hostInfra: {
          status: "unknown",
          evidence,
        },
      };
    }
  }

  private validateHostInfraDeclaration(value: unknown): {
    errors: string[];
    schemaVersion: 1 | 2 | null;
    mechanism: string;
    requiredSupportingInfra: number;
    evidencePaths: string[];
    evidenceProblems: string[];
  } {
    const errors: string[] = [];
    const evidencePaths: string[] = [];
    const evidenceProblems: string[] = [];
    const obj = isRecord(value) ? value : null;
    if (obj === null) {
      return {
        errors: ["schemaVersion", "daemonBootstrap.mechanism", "supportingInfra"],
        schemaVersion: null,
        mechanism: "unknown",
        requiredSupportingInfra: 0,
        evidencePaths,
        evidenceProblems,
      };
    }

    const schemaVersion = obj["schemaVersion"] === 1 || obj["schemaVersion"] === 2
      ? obj["schemaVersion"]
      : null;
    if (schemaVersion === null) {
      errors.push("schemaVersion");
    }

    const daemonBootstrap = isRecord(obj["daemonBootstrap"]) ? obj["daemonBootstrap"] : null;
    const mechanism = daemonBootstrap && typeof daemonBootstrap["mechanism"] === "string"
      ? daemonBootstrap["mechanism"].trim()
      : "";
    if (!mechanism) {
      errors.push("daemonBootstrap.mechanism");
    }
    if (daemonBootstrap?.["declared"] !== true) {
      errors.push("daemonBootstrap.declared");
    }

    const supportingInfra = Array.isArray(obj["supportingInfra"]) ? obj["supportingInfra"] : null;
    if (!supportingInfra) {
      errors.push("supportingInfra");
    }
    const requiredSupportingInfra = supportingInfra
      ? supportingInfra.filter((entry) => isRecord(entry) && entry["required"] === true).length
      : 0;

    if (schemaVersion === 2 && errors.length === 0) {
      this.collectRequiredEvidencePaths(
        "daemonBootstrap.evidencePaths",
        daemonBootstrap?.["evidencePaths"],
        evidencePaths,
        evidenceProblems,
      );

      supportingInfra?.forEach((entry, index) => {
        if (!isRecord(entry) || entry["required"] !== true) return;
        const id = typeof entry["id"] === "string" && entry["id"].trim()
          ? entry["id"].trim()
          : String(index);
        this.collectRequiredEvidencePaths(
          `supportingInfra[${id}].evidencePaths`,
          entry["evidencePaths"],
          evidencePaths,
          evidenceProblems,
        );
      });
    }

    return {
      errors,
      schemaVersion,
      mechanism: mechanism || "unknown",
      requiredSupportingInfra,
      evidencePaths,
      evidenceProblems,
    };
  }

  private collectRequiredEvidencePaths(
    label: string,
    value: unknown,
    evidencePaths: string[],
    evidenceProblems: string[],
  ): void {
    if (!Array.isArray(value) || value.length === 0) {
      evidenceProblems.push(`${label} missing or empty`);
      return;
    }

    for (const candidate of value) {
      if (typeof candidate !== "string" || candidate.trim() === "") {
        evidenceProblems.push(`${label} contains invalid evidence path ${String(candidate)}`);
        continue;
      }

      const resolved = this.resolveHostInfraEvidencePath(candidate.trim());
      if ("error" in resolved) {
        evidenceProblems.push(`${label} invalid evidence path ${candidate}: ${resolved.error}`);
        continue;
      }

      const resolvedPath = resolved.path;
      evidencePaths.push(resolvedPath);
      if (!this.deps.exists(resolvedPath)) {
        evidenceProblems.push(`${label} missing evidence path ${resolvedPath}`);
      }
    }
  }

  private resolveHostInfraEvidencePath(rawPath: string): { path: string; error?: undefined } | { path?: undefined; error: string } {
    const softwareTeamPrefix = "${SOFTWARETEAM_HOME}/";
    const hasTraversal = rawPath.split(/[\\/]+/).includes("..");

    if (rawPath.startsWith(softwareTeamPrefix)) {
      const relativePath = rawPath.slice(softwareTeamPrefix.length);
      if (!relativePath || isAbsolute(relativePath) || hasTraversal) {
        return { error: "path traversal or empty SOFTWARETEAM_HOME-relative path rejected" };
      }
      const softwareTeamHome = getCompatibleSoftwareTeamPath("");
      const resolved = join(softwareTeamHome, relativePath);
      const relativeToHome = relative(softwareTeamHome, resolved);
      if (relativeToHome === ".." || relativeToHome.startsWith(`..${sep}`) || isAbsolute(relativeToHome)) {
        return { error: "path traversal outside SOFTWARETEAM_HOME rejected" };
      }
      return { path: resolved };
    }

    if (!isAbsolute(rawPath)) {
      return { error: "plain relative evidence paths are rejected; use absolute or ${SOFTWARETEAM_HOME}/..." };
    }
    if (hasTraversal) {
      return { error: "path traversal evidence paths are rejected" };
    }
    return { path: rawPath };
  }

  private checkSnapshot(softwareTeam: { softwareTeamId: string; name: string }): CheckEntry {
    try {
      const has = this.deps.hasSnapshot(softwareTeam.softwareTeamId);
      if (has) {
        return { check: `softwareTeam.${softwareTeam.name}.snapshot`, status: "green", evidence: "Snapshot available", remediation: "" };
      }
      return {
        check: `softwareTeam.${softwareTeam.name}.snapshot`, status: "yellow",
        evidence: "No snapshot found (first-boot or adopted softwareTeam)",
        remediation: "Create a snapshot with: SoftwareTeam snapshot <softwareTeamId>",
      remediationSafe: false,
      };
    } catch {
      return { check: `softwareTeam.${softwareTeam.name}.snapshot`, status: "yellow", evidence: "Could not check snapshots", remediation: "" };
    }
  }

  private checkTranscript(softwareTeamName: string, node: NodeInventoryEntry): CheckEntry {
    const session = node.canonicalSessionName ?? node.logicalId;
    const check = `seat.${session}.transcript`;

    // Terminal/infrastructure nodes are exempt from transcript checks
    if (node.nodeKind === "infrastructure") {
      return { check, status: "green", evidence: "Terminal/infrastructure node — transcript exempt", remediation: "" };
    }

    const transcriptPath = join(
      getCompatibleSoftwareTeamPath("transcripts"),
      softwareTeamName,
      `${session}.log`
    );
    if (this.deps.exists(transcriptPath)) {
      return { check, status: "green", evidence: `Transcript exists at ${transcriptPath}`, remediation: "" };
    }
    return {
      check, status: "yellow",
      evidence: `Transcript missing: ${transcriptPath}`,
      remediation: "Transcript will be created on next session launch",
      remediationSafe: true,
    };
  }

  private checkSeatReadiness(node: NodeInventoryEntry): CheckEntry {
    const session = node.canonicalSessionName ?? node.logicalId;
    const check = `seat.${session}.readiness`;

    if (!node.canonicalSessionName) {
      return {
        check,
        status: "red",
        evidence: "Missing canonical session identity",
        remediation: "Restore or relaunch the seat so it has a canonical session identity",
        remediationSafe: false,
      };
    }

    if (node.sessionStatus === "running" && node.storedStartupStatus === "ready"
      && node.startupStatus === "attention_required"
      && (node.identityVerdict?.verdict === "mismatch" || node.identityVerdict?.verdict === "pane_missing")) {
      return {
        check,
        status: "red",
        evidence: `Seat identity needs verification: verdict=${node.identityVerdict.verdict} reason=${node.identityVerdict.reason ?? "unknown"}; stored startupStatus=ready`,
        remediation: node.identityVerdict.verdict === "mismatch"
          ? "Verify the current pane identity, then use SoftwareTeam seat clear-attention for this seat and rerun SoftwareTeam restore-check"
          : "If the seat's tmux session or pane is gone, restore or relaunch the seat; if it now runs in another pane of its session, SoftwareTeam seat clear-attention for this seat rebinds and verifies it. Then rerun SoftwareTeam restore-check.",
        remediationSafe: false,
      };
    }

    if (node.sessionStatus !== "running" || node.startupStatus !== "ready") {
      const latestError = node.latestError ? ` latestError=${node.latestError}` : "";
      return {
        check,
        status: "red",
        evidence: `Seat not running/ready: sessionStatus=${node.sessionStatus ?? "unknown"} startupStatus=${node.startupStatus ?? "unknown"}${latestError}`,
        remediation: "Restore or relaunch the seat, then rerun SoftwareTeam restore-check",
        remediationSafe: false,
      };
    }

    return {
      check,
      status: "green",
      evidence: `Seat running and ready: ${node.canonicalSessionName}`,
      remediation: "",
    };
  }

  /**
   * Report available seat attachment or a read-only restore-plan command.
   * Missing attachment does not establish whether an earlier token can resume.
   */
  private checkResumePath(node: NodeInventoryEntry, softwareTeamName: string): CheckEntry {
    const session = node.canonicalSessionName ?? node.logicalId;
    if (node.tmuxAttachCommand) {
      return { check: `seat.${session}.resume-path`, status: "green", evidence: node.tmuxAttachCommand, remediation: "" };
    }
    return {
      check: `seat.${session}.resume-path`, status: "yellow",
      evidence: "No attach command available",
      // Whether restore resumes, starts fresh or stops for a decision is per seat; the plan says which.
      remediation: `No live session to attach. Preview what restore would do for this seat with: SoftwareTeam up ${shellQuote(softwareTeamName)} --existing --plan`,
      remediationSafe: true,
    };
  }

  private checkStartupContext(node: NodeInventoryEntry): { check: CheckEntry } | { unknownChecks: CheckEntry[] } {
    const session = node.canonicalSessionName ?? node.logicalId;
    const check = `seat.${session}.startup-context`;
    const runningReady = node.sessionStatus === "running" && node.startupStatus === "ready";

    if (!node.nodeId) {
      return {
        check: this.buildStartupContextAvailabilityCheck(
          check,
          runningReady,
          `Startup context cannot be inspected because node id is missing for ${session}`,
        ),
      };
    }

    const probe = this.deps.getStartupContext(node.nodeId);
    switch (probe.status) {
      case "probe_error":
        return {
          unknownChecks: [{
            check: "probe.error",
            status: "red",
            evidence: `Failed to inspect startup context for ${session}: ${probe.evidence}`,
            remediation: "Check daemon logs with: SoftwareTeam daemon logs",
            remediationSafe: true,
          }],
        };
      case "missing":
      case "malformed":
        return {
          check: this.buildStartupContextAvailabilityCheck(check, runningReady, probe.evidence),
        };
      case "ok":
        break;
    }

    // #261: inspect (and report) the paths replay will actually use — recognized built-in startup
    // files and shipped-spec projection resources follow the running install.
    const startupContext = {
      ...probe,
      resolvedStartupFiles: probe.resolvedStartupFiles.map((file) => (
        typeof file.path === "string" && typeof file.ownerRoot === "string"
          ? reanchorBuiltinStartupFile({ ...file, path: file.path, ownerRoot: file.ownerRoot }, undefined, undefined, this.deps.exists)
          : file
      )),
      projectionEntries: probe.projectionEntries.map((entry) => (
        typeof entry.sourcePath === "string"
          ? reanchorShippedProjectionEntry({ ...entry, sourcePath: entry.sourcePath }, undefined, this.deps.exists)
          : entry
      )),
    };
    const missingRequired = startupContext.resolvedStartupFiles.filter((file) => file.required && !this.deps.exists(file.absolutePath));
    const missingOptional = startupContext.resolvedStartupFiles.filter((file) => !file.required && !this.deps.exists(file.absolutePath));
    const missingProjectionEntries = startupContext.projectionEntries.filter((entry) => !this.deps.exists(entry.absolutePath));

    if (missingRequired.length === 0 && missingOptional.length === 0 && missingProjectionEntries.length === 0) {
      const detailParts: string[] = [];
      if (startupContext.resolvedStartupFiles.length > 0) {
        detailParts.push(
          `resolved startup files present: ${startupContext.resolvedStartupFiles.map((file) => file.absolutePath).join(", ")}`
        );
      }
      if (startupContext.projectionEntries.length > 0) {
        detailParts.push(
          `projection source paths present: ${startupContext.projectionEntries.map((entry) => entry.absolutePath).join(", ")}`
        );
      }
      if (detailParts.length === 0) {
        detailParts.push("no persisted startup files or projection source paths declared");
      }
      return {
        check: {
          check,
          status: "green",
          evidence: `Startup context present for node ${node.nodeId}; ${detailParts.join("; ")}`,
          remediation: "",
        },
      };
    }

    const evidenceParts: string[] = [];
    if (missingRequired.length > 0) {
      evidenceParts.push(`missing required startup file(s): ${missingRequired.map((file) => file.absolutePath).join(", ")}`);
    }
    if (missingOptional.length > 0) {
      evidenceParts.push(`missing optional startup file(s): ${missingOptional.map((file) => file.absolutePath).join(", ")}`);
    }
    if (missingProjectionEntries.length > 0) {
      evidenceParts.push(`missing projection source path(s): ${missingProjectionEntries.map((entry) => entry.absolutePath).join(", ")}`);
    }

    const status: CheckStatus = missingRequired.length > 0 && !runningReady ? "red" : "yellow";
    return {
      check: {
        check,
        status,
        evidence: `Startup context present for node ${node.nodeId}, but replay inputs are incomplete: ${evidenceParts.join("; ")}`,
        remediation: `Restore or recreate the missing startup inputs from the SoftwareTeam or agent spec before trusting replay: ${[
          ...missingRequired.map((file) => file.absolutePath),
          ...missingOptional.map((file) => file.absolutePath),
          ...missingProjectionEntries.map((entry) => entry.absolutePath),
        ].join(", ")}`,
        remediationSafe: false,
      },
    };
  }

  private buildStartupContextAvailabilityCheck(
    check: string,
    runningReady: boolean,
    evidence: string,
  ): CheckEntry {
    return {
      check,
      status: runningReady ? "yellow" : "red",
      evidence,
      remediation: "Recreate the seat startup context from the SoftwareTeam or agent spec before trusting replay inputs",
      remediationSafe: false,
    };
  }

  private checkQueueStore(node: NodeInventoryEntry): CheckEntry {
    const session = node.canonicalSessionName ?? node.logicalId;
    const check = `seat.${session}.queue-store`;
    let probe: QueueStoreProbeResult | undefined;
    try {
      probe = this.deps.probeQueueStore?.();
    } catch (err) {
      probe = {
        available: false,
        evidence: `Daemon SQLite queue_items store probe failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (probe?.available) {
      return { check, status: "green", evidence: probe.evidence, remediation: "" };
    }
    return {
      check, status: "yellow",
      evidence: probe?.evidence ?? "Daemon SQLite queue store could not be inspected",
      remediation: "Restore the daemon SQLite queue store before relying on queue continuity",
      remediationSafe: false,
    };
  }

  private checkHooks(node: NodeInventoryEntry): CheckEntry {
    const session = node.canonicalSessionName ?? node.logicalId;

    if (node.nodeKind !== "agent") {
      return {
        check: `seat.${session}.hooks`, status: "green",
        evidence: "Infrastructure/terminal node; Claude Code hook inspection not applicable",
        remediation: "",
      };
    }

    if (node.runtime !== "claude-code") {
      return {
        check: `seat.${session}.hooks`, status: "green",
        evidence: `${node.runtime ?? "non-Claude"} seat; Claude Code hook inspection not applicable`,
        remediation: "",
      };
    }

    // Current Claude activity hooks are selected as a runtime resource and
    // delivered by ClaudeCodeAdapter: settings in the seat CWD, relay in instance state.
    // Do not require the retired internal control-plane shell hooks on public installs.
    const startup = node.nodeId ? this.deps.getStartupContext(node.nodeId) : null;
    if (startup?.status === "ok" && !startup.projectionEntries.some((entry) => (
      entry.category === "runtime_resource" && entry.resourceType === "claude_activity_hooks"
    ))) {
      return {
        check: `seat.${session}.hooks`, status: "green",
        evidence: "Claude activity hooks are not selected for this seat; hook inspection is not applicable",
        remediation: "",
      };
    }
    if (startup?.status === "ok") {
      if (!node.cwd) {
        return {
          check: `seat.${session}.hooks`, status: "yellow",
          evidence: "Claude activity hooks are selected, but seat cwd is unavailable for delivery inspection",
          remediation: "Restore the seat working directory before trusting activity-hook readiness",
          remediationSafe: false,
        };
      }
      const settingsPath = join(node.cwd, ".claude", "settings.local.json");
      const relayPath = claudeActivityRelayPath(this.deps.stateDir);
      const events = this.deps.getClaudeActivityHookEvents?.() ?? [];
      if (events.length === 0) {
        return {
          check: `seat.${session}.hooks`, status: "yellow",
          evidence: "Claude activity hook events could not be derived from the shipped manifest",
          remediation: "Restore the daemon's Claude activity-hook assets before trusting hook readiness",
          remediationSafe: false,
        };
      }
      if (!this.deps.exists(relayPath) || !this.deps.exists(settingsPath)) {
        return {
          check: `seat.${session}.hooks`, status: "yellow",
          evidence: `Claude activity hook delivery is incomplete: expected relay ${relayPath} and settings ${settingsPath}`,
          remediation: "Relaunch the seat to project its selected Claude activity hooks",
          remediationSafe: false,
        };
      }
      let settings: unknown;
      try {
        settings = JSON.parse(this.deps.readFile(settingsPath));
      } catch (err) {
        return {
          check: `seat.${session}.hooks`, status: "yellow",
          evidence: `Claude activity-hook settings could not be trusted at ${settingsPath}: ${err instanceof Error ? err.message : String(err)}`,
          remediation: `Fix the Claude settings JSON at ${settingsPath}`,
          remediationSafe: false,
        };
      }
      if (isRecord(settings) && settings["disableAllHooks"] === true) {
        return {
          check: `seat.${session}.hooks`, status: "yellow",
          evidence: `Selected Claude activity hooks are explicitly disabled in ${settingsPath}; projection does not prove usable hooks`,
          remediation: "Review the intentional hook-disable setting before relying on activity-hook readiness",
          remediationSafe: false,
        };
      }
      const missingEvents = events.filter((event) => !this.hasActivityRelayHook(settings, event, relayPath));
      if (missingEvents.length === 0) {
        return {
          check: `seat.${session}.hooks`, status: "green",
          evidence: `Selected Claude activity hooks are projected in ${settingsPath}, with relay present at ${relayPath}; hook execution is not verified`,
          remediation: "",
        };
      }
      return {
        check: `seat.${session}.hooks`, status: "yellow",
        evidence: `Claude activity-hook settings at ${settingsPath} are missing relay entries for: ${missingEvents.join(", ")}`,
        remediation: "Relaunch the seat to project its selected Claude activity hooks",
        remediationSafe: false,
      };
    }

    return {
      check: `seat.${session}.hooks`, status: "yellow",
      evidence: startup?.status === "probe_error"
        ? `Claude activity-hook selection could not be inspected: ${startup.evidence}`
        : "Claude activity-hook selection could not be inspected because persisted startup context is unavailable",
      remediation: "Restore the seat startup context before trusting hook readiness",
      remediationSafe: false,
    };
  }

  private hasActivityRelayHook(settings: unknown, eventName: string, relayPath: string): boolean {
    if (!isRecord(settings) || !isRecord(settings["hooks"])) return false;
    const eventEntries = settings["hooks"][eventName];
    if (!Array.isArray(eventEntries)) return false;
    const contexts = eventName === "SessionStart" ? ["startup", "resume"]
      : eventName === "Notification" ? ["permission_prompt", "idle_prompt"] : [null];
    return contexts.every((context) => eventEntries.some((entry) => {
      if (!isRecord(entry) || !Array.isArray(entry["hooks"])) return false;
      if (context !== null && entry["matcher"] !== undefined && entry["matcher"] !== "" && entry["matcher"] !== "*") {
        if (typeof entry["matcher"] !== "string") return false;
        try {
          const matcher = entry["matcher"];
          const matches = /^[a-zA-Z0-9_\- ,|]+$/.test(matcher)
            ? matcher.split(/[|,]/).some((value) => value.trim() === context)
            : new RegExp(matcher).test(context);
          if (!matches) return false;
        }
        catch { return false; }
      }
      return entry["hooks"].some((hook) => (
        isRecord(hook) && hook["type"] === "command" && typeof hook["command"] === "string" &&
        hook["command"] === `node ${quoteShellArgument(relayPath)}`
      ));
    }));
  }

  private checkSpecPresent(softwareTeam: { softwareTeamId: string; name: string }): CheckEntry {
    // OPR.0.3.2.14 — subpath scrubbed (internal-team layout → generic placeholder).
    const substrateRoot = this.deps.substrateRoot ?? join(process.env["HOME"] ?? "~", ".softwareteam", "shared-docs");
    const softwareTeamRoot = join(substrateRoot, "software-teams", softwareTeam.name);
    const softwareTeamYaml = join(softwareTeamRoot, "software-team.yaml");

    if (!this.deps.exists(softwareTeamRoot)) {
      // A softwareTeam can launch from a spec anywhere, and restore reads the snapshot, never the spec,
      // so a spec this check cannot find is a caveat, not a blocker.
      return {
        check: `softwareTeam.${softwareTeam.name}.spec-present`, status: "yellow",
        evidence: `Not checked: no launch spec location could be established; looked for ${softwareTeamYaml}, and ${softwareTeamRoot} does not exist`,
        remediation: `Confirm where this softwareTeam's spec lives; restore-check only looks at ${softwareTeamYaml}`,
        remediationSafe: true,
      };
    }
    if (!this.deps.exists(softwareTeamYaml)) {
      return {
        check: `softwareTeam.${softwareTeam.name}.spec-present`, status: "yellow",
        evidence: `SoftwareTeam root exists but software-team.yaml missing: ${softwareTeamYaml}`,
        remediation: `Add a software-team.yaml spec to ${softwareTeamRoot}`,
      remediationSafe: false,
      };
    }
    return { check: `softwareTeam.${softwareTeam.name}.spec-present`, status: "green", evidence: `Spec present at ${softwareTeamYaml}`, remediation: "" };
  }

  private inspectLatestSnapshot(softwareTeamId: string): { snapshot: { id: string; kind: string } | null; error?: string } {
    if (!this.deps.getLatestSnapshot) {
      return { snapshot: null };
    }

    try {
      const snapshot = this.deps.getLatestSnapshot(softwareTeamId);
      if (!snapshot) return { snapshot: null };
      return { snapshot: { id: snapshot.id, kind: snapshot.kind } };
    } catch (err) {
      return {
        snapshot: null,
        error: `Latest snapshot lookup failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private buildResult(
    checks: CheckEntry[],
    softwareTeams: SoftwareTeamRestoreRollup[],
    hostInfra?: HostInfraAssertion,
    recoveryInputs: RecoverySoftwareTeamInput[] = [],
    assessmentExtra: CheckEntry[] = [],
  ): RestoreCheckResult {
    // counts + verdict assess the FULL signal (emitted checks + any computed-but-
    // omitted ready-seat caveats) so default compact never reports a false ready;
    // repairPacket/recovery still operate on the EMITTED checks (token-safe).
    const assessed = assessmentExtra.length > 0 ? [...checks, ...assessmentExtra] : checks;
    const red = assessed.filter((c) => c.status === "red").length;
    const yellow = assessed.filter((c) => c.status === "yellow").length;
    const green = assessed.filter((c) => c.status === "green").length;

    let verdict: Verdict;
    if (red > 0) {
      verdict = "not_restorable";
    } else if (softwareTeams.some((softwareTeam) => softwareTeam.status === "unknown")) {
      verdict = "unknown";
    } else if (yellow > 0) {
      verdict = "restorable_with_caveats";
    } else {
      verdict = "restorable";
    }

    const repairPacket = this.buildRepairPacket(checks, verdict);
    const recovery = this.buildRecovery(verdict, checks, recoveryInputs);
    return this.withAssertion({ verdict, counts: { red, yellow, green }, checks, repairPacket, recovery }, softwareTeams, hostInfra);
  }

  /** Probe error produces verdict=unknown (not not_restorable) so operators
   *  can distinguish "definitely broken" from "checker couldn't inspect." */
  private buildUnknown(checks: CheckEntry[]): RestoreCheckResult {
    const red = checks.filter((c) => c.status === "red").length;
    const yellow = checks.filter((c) => c.status === "yellow").length;
    const green = checks.filter((c) => c.status === "green").length;
    const repairPacket = this.buildRepairPacket(checks, "unknown");
    const evidence = checks.find((check) => check.status === "red")?.evidence
      ?? "Restore-check state could not be inspected";
    return this.withAssertion({
      verdict: "unknown",
      counts: { red, yellow, green },
      checks,
      repairPacket,
      recovery: {
        status: "unknown",
        summary: "Recovery status could not be inspected because restore-check state is unknown.",
        actions: [],
        blocked: [],
        unknown: [{ scope: "host", reason: evidence }],
      },
    }, []);
  }

  private withAssertion(
    result: Pick<RestoreCheckResult, "verdict" | "counts" | "checks" | "repairPacket" | "recovery">,
    softwareTeams: SoftwareTeamRestoreRollup[],
    hostInfra?: HostInfraAssertion,
  ): RestoreCheckResult {
    const blockingSoftwareTeamCount = softwareTeams.filter((softwareTeam) => softwareTeam.blockedNodes > 0 || softwareTeam.blockingChecks.length > 0).length;
    const caveatSoftwareTeamCount = softwareTeams.filter((softwareTeam) => softwareTeam.blockedNodes === 0 && softwareTeam.blockingChecks.length === 0 && (softwareTeam.caveatNodes > 0 || softwareTeam.caveatChecks.length > 0)).length;
    const unknownSoftwareTeamCount = softwareTeams.filter((softwareTeam) => softwareTeam.status === "unknown").length;

    let readinessStatus: ReadinessStatus;
    let reason: string;
    if (result.verdict === "unknown") {
      readinessStatus = "unknown";
      reason = "unknown_probe_state";
    } else if (result.counts.red > 0) {
      readinessStatus = "not_ready";
      reason = "blockers_present";
    } else if (result.counts.yellow > 0) {
      readinessStatus = "ready_with_caveats";
      reason = "caveats_present";
    } else {
      readinessStatus = "ready";
      reason = hostInfra?.status === "declared"
        ? "all_observable_checks_green_host_infra_declared_not_verified"
        : "all_observable_checks_green";
    }

    // Continuity is always not_proven in v1 — no code path can produce "proven"
    const continuity: ContinuityAssertion = {
      status: "not_proven",
      evidence: "Strict same-session/provider-context resume is not verified by restore-check v1. Observable readiness is verified.",
      provenCapabilities: this.computeProvenCapabilities(result.checks),
      unprovenCapabilities: [
        "provider_session_resume",
        "context_window_preservation",
        "interrupted_work_functional_resume",
      ],
    };

    return {
      ...result,
      readiness: {
        status: readinessStatus,
        reason,
        blockingSoftwareTeamCount,
        caveatSoftwareTeamCount,
        unknownSoftwareTeamCount,
      },
      continuity,
      softwareTeams,
      // FR-8: fleet-wide ready-confidence breakdown = sum of the per-softwareTeam class counts.
      classCounts: softwareTeams.reduce<ReadinessClassCounts>((acc, r) => ({
        ready: acc.ready + r.classCounts.ready,
        ready_with_caveats: acc.ready_with_caveats + r.classCounts.ready_with_caveats,
        not_ready: acc.not_ready + r.classCounts.not_ready,
        attention_required: acc.attention_required + r.classCounts.attention_required,
        unknown: acc.unknown + r.classCounts.unknown,
      }), { ready: 0, ready_with_caveats: 0, not_ready: 0, attention_required: 0, unknown: 0 }),
      hostInfra: hostInfra ?? (result.verdict === "unknown"
        ? {
            status: "unknown",
            evidence: "Host bootstrap/autostart source could not be inspected because restore-check state is unknown",
          }
        : {
            status: "not_inspected",
            evidence: "No host bootstrap/autostart source inspected by v0; readiness only covers observable daemon, softwareTeam, and seat checks",
          }),
      recovery: result.recovery,
    };
  }

  /** Derive proven capabilities from green checks for the continuity block. */
  private computeProvenCapabilities(checks: CheckEntry[]): string[] {
    const proven: string[] = [];
    if (checks.some((c) => c.check === "daemon.reachable" && c.status === "green")) proven.push("daemon_reachable");
    if (checks.some((c) => c.check.endsWith(".transcript") && c.status === "green")) proven.push("transcript_readable");
    if (checks.some((c) => c.check.endsWith(".spec-present") && c.status === "green")) proven.push("spec_present");
    if (checks.some((c) => c.check.endsWith(".queue-store") && c.status === "green")) proven.push("queue_store_available");
    if (checks.some((c) => c.check.endsWith(".resume-path") && c.status === "green")) proven.push("seat_identity_resolvable");
    return proven;
  }

  private buildRecovery(
    verdict: Verdict,
    checks: CheckEntry[],
    recoveryInputs: RecoverySoftwareTeamInput[],
  ): RecoveryPlan {
    if (verdict === "unknown" && recoveryInputs.length === 0) {
      const evidence = checks.find((check) => check.status === "red")?.evidence
        ?? "Restore-check state could not be inspected";
      return {
        status: "unknown",
        summary: "Recovery status could not be inspected because restore-check state is unknown.",
        actions: [],
        blocked: [],
        unknown: [{ scope: "host", reason: evidence }],
      };
    }

    if (recoveryInputs.length === 0) {
      const firstRed = checks.find((check) => check.status === "red");
      if (firstRed) {
        return {
          status: "blocked",
          summary: "No exact recovery action is known in v0 because restore-check found blockers outside runnable SoftwareTeam inventory.",
          actions: [],
          blocked: [{ scope: "host", reason: firstRed.evidence }],
          unknown: [],
        };
      }
      return {
        status: "not_needed",
        summary: "All observable softwareTeams are already running/ready; no recovery action needed.",
        actions: [],
        blocked: [],
        unknown: [],
      };
    }

    const allReady = recoveryInputs.every((input) => !input.snapshotLookupError
      && input.runningReadyNodes === input.expectedNodes
      && !input.blockingChecks.some((check) => this.classifyRecoveryBlockingCheck(check) === "restore_input"));
    if (allReady) {
      return {
        status: "not_needed",
        summary: "All observable softwareTeams are already running/ready; no recovery action needed.",
        actions: [],
        blocked: [],
        unknown: [],
      };
    }

    const actions: RecoveryAction[] = [];
    const blocked: RecoveryIssue[] = [];
    const unknown: RecoveryIssue[] = [];

    for (const input of recoveryInputs) {
      if (input.snapshotLookupError) {
        unknown.push({
          scope: "softwareTeam",
          softwareTeamId: input.softwareTeamId,
          softwareTeamName: input.softwareTeamName,
          reason: input.snapshotLookupError,
        });
        continue;
      }
      const restoreInputBlockers = input.blockingChecks.filter((check) =>
        this.classifyRecoveryBlockingCheck(check) === "restore_input"
      );
      if (restoreInputBlockers.length > 0) {
        blocked.push({
          scope: "softwareTeam",
          softwareTeamId: input.softwareTeamId,
          softwareTeamName: input.softwareTeamName,
          reason: `No exact recovery action is known in v0 because restore-input blockers remain: ${restoreInputBlockers.map((check) => check.evidence).join("; ")}`,
        });
        continue;
      }
      if (input.runningReadyNodes === input.expectedNodes) continue;

      if (input.latestSnapshot) {
        actions.push({
          scope: "softwareTeam",
          softwareTeamId: input.softwareTeamId,
          softwareTeamName: input.softwareTeamName,
          action: "restore_from_latest_snapshot",
          command: `SoftwareTeam up --existing ${shellQuote(input.softwareTeamName)}`,
          reason: "SoftwareTeam has a latest snapshot and one or more seats are not running/ready.",
          safe: false,
          blocking: true,
        });
        continue;
      }

      actions.push({
        scope: "softwareTeam",
        softwareTeamId: input.softwareTeamId,
        softwareTeamName: input.softwareTeamName,
        action: "restore_from_latest_snapshot",
        command: `SoftwareTeam up --existing ${shellQuote(input.softwareTeamName)}`,
        reason: "Current persisted state is eligible for an ordinary restore attempt; SoftwareTeam up would capture an auto-rehydrate snapshot whose restore inputs have not been inspected.",
        safe: false,
        blocking: true,
      });
    }

    const status: RecoveryStatus = unknown.length > 0
      ? "unknown"
      : actions.length > 0
        ? "actionable"
        : blocked.length > 0
          ? "blocked"
          : "not_needed";

    return {
      status,
      summary: this.buildRecoverySummary(status, actions, blocked, unknown),
      actions,
      blocked,
      unknown,
    };
  }

  private classifyRecoveryBlockingCheck(check: CheckEntry): "restore_input" | "runtime" | "other" {
    if (check.status !== "red") return "other";

    if (check.check.startsWith("softwareTeam.") && check.check.endsWith(".restore-preconditions")) return "restore_input";

    if (check.check.startsWith("seat.") && check.check.endsWith(".readiness")) {
      if (check.evidence.includes("Missing canonical session identity")) {
        return "restore_input";
      }
      return "runtime";
    }

    if (check.check.startsWith("seat.") && check.check.endsWith(".startup-context")) {
      return "restore_input";
    }

    return "other";
  }

  private buildRecoverySummary(
    status: RecoveryStatus,
    actions: RecoveryAction[],
    blocked: RecoveryIssue[],
    unknown: RecoveryIssue[],
  ): string {
    if (status === "not_needed") {
      return "All observable softwareTeams are already running/ready; no recovery action needed.";
    }
    if (status === "unknown") {
      return `Recovery status could not be inspected completely; ${actions.length} actionable, ${blocked.length} blocked, ${unknown.length} unknown.`;
    }
    if (status === "actionable") {
      return `${actions.length} ${pluralize(actions.length, "SoftwareTeam")} can be recovered by known SoftwareTeam command; ${blocked.length} ${pluralize(blocked.length, "SoftwareTeam")} blocked; ${unknown.length} unknown.`;
    }
    return `${blocked.length} ${pluralize(blocked.length, "SoftwareTeam")} blocked; ${actions.length} actionable; ${unknown.length} unknown.`;
  }

  private buildSoftwareTeamRollup(input: SoftwareTeamRollupInput): SoftwareTeamRestoreRollup {
    const blockingChecks = input.checks.filter((check) => check.status === "red");
    const caveatChecks = input.checks.filter((check) => check.status === "yellow");
    const expectedNodes = input.nodes.length;
    let runningReadyNodes = 0;
    let blockedNodes = 0;
    let caveatNodes = 0;
    // FR-8: per-seat class breakdown (each seat counts toward exactly one class).
    const classCounts: ReadinessClassCounts = { ready: 0, ready_with_caveats: 0, not_ready: 0, attention_required: 0, unknown: 0 };
    // unknown/no-snapshot derives from the REAL snapshot primitive: the
    // software-team-level `softwareTeam.<name>.snapshot` yellow check (no snapshot found / could
    // not check). A softwareTeam with no snapshot cannot be restored, so its seats'
    // restore-readiness is unknown (not "ready"), per FR-8/AC-7.
    const softwareTeamNoSnapshot = input.checks.some(
      (check) => check.check === `softwareTeam.${input.softwareTeam.name}.snapshot` && check.status === "yellow",
    );

    for (const node of input.nodes) {
      const session = node.canonicalSessionName ?? node.logicalId;
      const nodeChecks = input.checks.filter((check) => check.check.startsWith(`seat.${session}.`));
      const hasBlocking = nodeChecks.some((check) => check.status === "red");
      const hasCaveat = nodeChecks.some((check) => check.status === "yellow");
      const runningReady = Boolean(node.canonicalSessionName) && node.sessionStatus === "running" && node.startupStatus === "ready";
      if (runningReady) runningReadyNodes += 1;
      if (hasBlocking) blockedNodes += 1;
      else if (hasCaveat) caveatNodes += 1;

      // FR-8 class derivation (precedence; each from a real primitive).
      // attention/not_ready WIN FIRST (a failed/attention seat is surfaced even
      // in a no-snapshot softwareTeam); no-snapshot then overrides ONLY ready/caveat (a
      // clean seat in an unrestorable softwareTeam is unknown); a real yellow caveat then
      // wins over plain ready so the class count matches the per-SoftwareTeam status +
      // caveatNodes (a running/ready seat with a yellow check is NOT plain ready):
      //   attention_required ← node.startupStatus
      //   not_ready          ← a red seat check (failed/down)
      //   unknown            ← no-snapshot (softwareTeam can't restore)
      //   ready_with_caveats ← a yellow seat check
      //   ready              ← running/ready, no caveat
      //   unknown            ← indeterminate remainder
      if (node.startupStatus === "attention_required") classCounts.attention_required += 1;
      else if (hasBlocking) classCounts.not_ready += 1;
      else if (softwareTeamNoSnapshot) classCounts.unknown += 1;
      else if (hasCaveat) classCounts.ready_with_caveats += 1;
      else if (runningReady) classCounts.ready += 1;
      else classCounts.unknown += 1;
    }

    let verdict: Verdict;
    let status: ReadinessStatus;
    if (input.preconditionError) {
      verdict = "unknown";
      status = "unknown";
    } else if (blockingChecks.length > 0) {
      verdict = "not_restorable";
      status = "not_ready";
    } else if (caveatChecks.length > 0) {
      verdict = "restorable_with_caveats";
      status = "ready_with_caveats";
    } else {
      verdict = "restorable";
      status = "ready";
    }

    return {
      softwareTeamId: input.softwareTeam.softwareTeamId,
      softwareTeamName: input.softwareTeam.name,
      status,
      verdict,
      expectedNodes,
      runningReadyNodes,
      blockedNodes,
      caveatNodes,
      classCounts,
      blockingChecks,
      caveatChecks,
    };
  }

  /** Generate ordered repair steps from non-green checks with remediation.
   *  null when all green (restorable — nothing to repair).
   *  Blockers (red) first in check order, then caveats (yellow). */
  private buildRepairPacket(checks: CheckEntry[], verdict: Verdict): RepairStep[] | null {
    if (verdict === "restorable") return null;

    // Blockers first, then caveats, preserving original check order within each group
    const blockers = checks.filter((c) => c.status === "red" && c.remediation);
    const caveats = checks.filter((c) => c.status === "yellow" && c.remediation);
    const ordered = [...blockers, ...caveats];

    if (ordered.length === 0) return null;

    let step = 0;
    return ordered.map((c) => ({
      step: ++step,
      command: c.remediation,
      rationale: c.evidence,
      safe: c.remediationSafe === true,  // conservative: default false unless explicitly marked safe
      blocking: c.status === "red",
    }));
  }
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9._@:-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pluralize(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}
