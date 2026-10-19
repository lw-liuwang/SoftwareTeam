import { Command } from "commander";
import stringWidth from "string-width";
import { resolveEffectiveHost } from "../host-selection.js";
import { sessionSoftwareTeamOf } from "../session-name.js";
import { DaemonClient, remoteDaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, resolveOriginSelfHostId, type LifecycleDeps , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";
import { loadHostRegistry, resolveHost, hostDisplayTarget, resolveRemoteBearer, classifyHttpFailedStep, classifyHttpError, type HttpHostEntry } from "../host-registry.js";
import { runCrossHostCommand, type RunCrossHostCommandOpts } from "../cross-host-executor.js";
import { emitCrossHostError, emitCrossHostFailure } from "../cross-host-cli-helpers.js";
import { readSoftwareTeamEnv } from "../softwareteam-compat.js";
import type { AggregatedPayload, PerHostStatus } from "../lib/hosts/fanout-contract.js";

interface PsEntry {
  softwareTeamId: string;
  name: string;
  /** L3-followup: alias of `name`. Always populated and equal to `name`. */
  softwareTeamName?: string;
  nodeCount: number;
  runningCount: number;
  /** Slice 15 — subset of nodes producing tmux output within the silence
   *  window. Sourced from the daemon's SeatActivityService; NEVER derived
   *  from queue/assignment state. */
  activeCount?: number;
  /** Slice 17 — subset of nodes with at least one pending, in-progress,
   *  or blocked qitem assigned. Sourced from queue_items; NEVER derived
   *  from tmux output. */
  hasWorkCount?: number;
  status: "running" | "partial" | "stopped";
  /** OPR.0.4.4.21 — additive: seats needing attention (lifecycle/startup
   *  attention, needs_input, held, startup error) folded daemon-side. */
  attentionCount?: number;
  lifecycleState?: "running" | "recoverable" | "stopped" | "degraded" | "attention_required";
  uptime: string | null;
  latestSnapshot: string | null;
  /** OPR.0.3.3.19 - ISO timestamp when archived, or null if active. Present
   *  only when the daemon supports archive; optional for back-compat. */
  archivedAt?: string | null;
  /** OPR.0.3.3.19 - convenience flag; true iff the softwareTeam is archived. */
  isArchived?: boolean;
}

interface NodeEntry {
  softwareTeamId: string;
  softwareTeamName: string;
  logicalId: string;
  podId: string | null;
  podNamespace?: string | null;
  /** Slice 13 fix 2 — the serving daemon's boot-reconciled self-id, stamped per row at the source
   *  (null before the daemon reconciles). Distinct from the -A fan-out's `hostId`, which is the
   *  CALLER'S registry alias for the host it queried. */
  hostSelfId?: string | null;
  canonicalSessionName: string | null;
  nodeKind: "agent" | "infrastructure";
  runtime: string | null;
  model: string | null;
  sessionStatus: string | null;
  intentionallyStopped?: boolean;
  startupStatus: "pending" | "ready" | "attention_required" | "failed" | null;
  restoreOutcome: string;
  // OPR.0.4.3.06 — challenge-verified orientation, distinct from startupStatus.
  oriented?: string;
  lifecycleState?: "running" | "detached" | "recoverable" | "attention_required";
  tmuxAttachCommand: string | null;
  resumeCommand: string | null;
  latestError: string | null;
  /** Slice 15 — `terminal-active` primitive. true=producing output,
   *  false=silent past threshold, null=no signal. NEVER derived from
   *  hasAssignedWork (non-inference contract). */
  terminalActive?: boolean | null;
  /** S19 — the served taxonomy state (display pre-derived by the daemon's one bridge). */
  activityState?: {
    activity: string;
    display: string;
    needsInput: { count: number; reason: string | null };
    decidedBy: string | null;
  } | null;
  identityVerdict?: { reason?: string | null } | null;
  /** A community agent app's seat: its label, maintainer and declared limits. */
  agentApp?: { app: string; maintainer: string | null; limits: string[]; identity: string; needsInput: string; presetError?: string };
  /** Slice 15 — `has-work-to-do` primitive. Derived from queue_items;
   *  NEVER derived from terminalActive. */
  hasAssignedWork?: boolean;
  /** Total active assignments (pending + in-progress + blocked). */
  assignedWorkCount?: number;
  /** Slice 15 — pending qitem count for this seat (cheap aggregate). */
  pendingWorkCount?: number;
  inProgressWorkCount?: number;
  blockedWorkCount?: number;
  /** OPR.0.3.4.11 — held reason from node.held event. */
  heldReason?: string | null;
  agentActivity?: {
    state: "running" | "needs_input" | "idle" | "unknown";
    reason: string;
    evidenceSource: string;
    sampledAt: string;
    evidence: string | null;
    rawEvent?: string | null;
    stale?: boolean;
    fallback?: boolean;
  };
  // PL-012: context-usage block surfaced from the daemon's
  // /api/software-teams/:id/nodes route (already populated). Optional because
  // older daemons may not emit it.
  contextUsage?: {
    availability: "known" | "unknown";
    usedPercentage: number | null;
    fresh: boolean;
    state?: "critical" | "warning" | "low" | "unknown";
    sampledAt: string | null;
  };
  /** OPR.0.4.0.34 — resume summary from the daemon node-inventory. resumeToken
   *  is the SECRET: surfaced as a present-boolean in compact, value only in --full. */
  resumeType?: string | null;
  resumeToken?: string | null;
  /** OPR.0.4.0.34 — startup-completion timestamp; the compact `lastActivity`
   *  fallback when no agentActivity sample exists. */
  startupCompletedAt?: string | null;
  [key: string]: unknown;
}

// L3-followup: human-output budgets bound default terminal output for hosts
// with realistic agent counts. `--full` opts out. JSON output remains
// unbounded by default for back-compat (Decision C hybrid).
function extractSoftwareTeamName(sessionName: string): string | undefined {
  // OPR.0.4.6.MH1 FR-8: the shared parse contract (greedy first-@ softwareTeam).
  return sessionSoftwareTeamOf(sessionName);
}

/** The ONE active-softwareTeam predicate (LEG-7 extraction, fold-wave qitem 79159e6f): a softwareTeam is active unless
 *  its lifecycle status is exactly "stopped". Shared by the bare-default table projection and the
 *  softwareTeamsOnHost scope count so the "1 of N" label and the shown rows can never diverge (the
 *  derived-label-must-carry-liveness class the LEG-2 QA flagged). */
export function isActiveSoftwareTeam(entry: { status?: string | null }): boolean {
  return entry.status !== "stopped";
}

const HUMAN_SOFTWARE_TEAM_BUDGET = 50;
const HUMAN_NODE_BUDGET = 100;

// L3-followup: --filter accepts only this allow-list. Unknown keys produce a
// clear error with the supported list (Guard Review Checklist: filter-parser
// security).
//
// PL-019 item 1: extends the allow-list with the nested key `agentActivity.state`.
// This is the only nested filter key v0 supports; the parser checks for the
// dotted form explicitly. Bare `agentActivity` is intentionally NOT a filter
// key — it's an object, not a scalar; project it via --fields if you need it.
const ALLOWED_FILTER_KEYS = new Set([
  "status",
  "lifecycleState",
  "name-prefix",
  "name",
  "agentActivity.state",
  // PL-012: context-usage filters. percent is numeric (>=, >, <=, <, =);
  // state is enum (critical / warning / low / unknown — lockstep with
  // computeContextHealthSummary tier vocabulary).
  "contextUsage.percent",
  "contextUsage.state",
]);

// PL-019 item 1: when filter key is `agentActivity.state`, the value is
// validated against the AgentActivityState enum. Invalid values produce a
// three-part error (what failed / what's allowed / what to do).
const ALLOWED_AGENT_ACTIVITY_STATES = new Set(["running", "needs_input", "idle", "unknown"]);

// PL-012: ALLOWED_CONTEXT_USAGE_STATES — must stay lockstep with the
// daemon's computeContextHealthSummary urgency vocab.
const ALLOWED_CONTEXT_USAGE_STATES = new Set(["critical", "warning", "low", "unknown"]);

const NUMERIC_FILTER_KEYS = new Set(["contextUsage.percent"]);
type NumericComparator = ">=" | ">" | "<=" | "<" | "=";
const NUMERIC_OPERATORS: NumericComparator[] = [">=", "<=", ">", "<", "="];

// C9a: --fields accepts a per-level allow-list. Unknown keys produce a clear
// error with the supported list, mirroring the --filter rejection pattern.
// Per-level because softwareTeam and node entries have different schemas (PsEntry
// software-team-level vs NodeEntry node-level).
//
// Source of truth: PsEntry / NodeEntry interfaces above. `name` exists at
// software-team-level only; `softwareTeamName` is the alias and exists at both levels (per the
// closed `SoftwareTeam ps trust and scale-safety` slice at softwareteam 0a9fb43).
const ALLOWED_SOFTWARE_TEAM_FIELDS = new Set([
  "attentionCount",
  "softwareTeamId",
  "name",
  "softwareTeamName",
  "nodeCount",
  "runningCount",
  "activeCount",
  "hasWorkCount",
  "status",
  "lifecycleState",
  "uptime",
  "latestSnapshot",
]);
const ALLOWED_NODE_FIELDS = new Set([
  "softwareTeamId",
  "softwareTeamName",
  "logicalId",
  "podId",
  "podNamespace",
  "hostSelfId",
  "canonicalSessionName",
  "nodeKind",
  "runtime",
  "agentApp",
  "model",
  "sessionStatus",
  "intentionallyStopped",
  "startupStatus",
  "restoreOutcome",
  "oriented",
  "lifecycleState",
  "tmuxAttachCommand",
  "resumeCommand",
  "latestError",
  "terminalActive",
  "hasAssignedWork",
  "assignedWorkCount",
  "pendingWorkCount",
  "inProgressWorkCount",
  "blockedWorkCount",
  "agentActivity",
  "contextUsage",
  "heldReason",
]);

interface PsCliOptions {
  json?: boolean;
  cleanup?: boolean;
  resources?: boolean;
  nodes?: boolean;
  full?: boolean;
  verbose?: boolean;
  limit?: string;
  fields?: string;
  summary?: boolean;
  filter?: string;
  host?: string;
  allHosts?: boolean;
  hosts?: string;
  active?: boolean;
  running?: boolean;
  allSoftwareTeams?: boolean;
  softwareTeam?: string;
  session?: string;
  /** OPR.0.3.3.19 - include archived softwareTeams (default excludes them). Parity
   *  with `softwareTeam stream list --include-archived`. */
  includeArchived?: boolean;
}

export interface PsDeps extends StatusDeps {
  /**
   * Cross-host hooks. Both default to the production loaders/executors; tests
   * inject in-package mocks so no real ssh / no real ~/.ssh / no real network
   * is touched. Mirrors the SendDeps/CaptureDeps shape from the closed
   * cross-host-software-team-commands slice (cdce3a6).
   */
  hostRegistryLoader?: () => ReturnType<typeof loadHostRegistry>;
  crossHostRun?: (
    host: Parameters<typeof runCrossHostCommand>[0],
    argv: readonly string[],
    opts?: RunCrossHostCommandOpts,
  ) => ReturnType<typeof runCrossHostCommand>;
}

interface ParsedFilter {
  key: string;
  value: string;
  /** PL-012: numeric comparator for keys in NUMERIC_FILTER_KEYS;
   *  defaults to "=" (equality) for all other keys. */
  op: NumericComparator;
  /** PL-012: parsed numeric value when op is a numeric comparator. */
  numericValue?: number;
}

function parseFilter(filter: string): ParsedFilter | { error: string } {
  // PL-012: pre-detect numeric comparators (>=, <=, >, <, =) so callers
  // can write `contextUsage.percent>=80`. Order matters: check >= and
  // <= before > and < so the longer prefix wins.
  let op: NumericComparator = "=";
  let opIdx = -1;
  for (const candidate of NUMERIC_OPERATORS) {
    const i = filter.indexOf(candidate);
    if (i !== -1) {
      // Prefer the leftmost match; on tie, prefer the longest comparator.
      if (opIdx === -1 || i < opIdx || (i === opIdx && candidate.length > op.length)) {
        opIdx = i;
        op = candidate;
      }
    }
  }
  if (opIdx === -1) {
    return { error: `--filter must be key<op>value (op = ${NUMERIC_OPERATORS.join(", ")}); got: '${filter}'` };
  }
  const key = filter.slice(0, opIdx);
  const value = filter.slice(opIdx + op.length);
  if (!ALLOWED_FILTER_KEYS.has(key)) {
    return {
      error: `Unknown --filter key '${key}'. Supported: ${[...ALLOWED_FILTER_KEYS].sort().join(", ")}`,
    };
  }
  if (!value) {
    return { error: `--filter value is empty for key '${key}'` };
  }

  // PL-012: numeric-keyed filters validate the value parses as a finite
  // number. Three-part error per the existing convention.
  if (NUMERIC_FILTER_KEYS.has(key)) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
      return {
        error: `--filter ${key}${op}'${value}' is not a numeric value. ` +
          `Allowed: a finite number (e.g., ${key}>=80). ` +
          `Use 'SoftwareTeam ps --nodes --fields contextUsage --json' to see what daemon is reporting.`,
      };
    }
    return { key, value, op, numericValue };
  }

  // PL-012: contextUsage.state enum guard — same shape as agentActivity.state.
  if (key === "contextUsage.state" && !ALLOWED_CONTEXT_USAGE_STATES.has(value)) {
    return {
      error: `--filter contextUsage.state='${value}' is not a valid context state. ` +
        `Allowed: ${[...ALLOWED_CONTEXT_USAGE_STATES].sort().join(", ")}. ` +
        `Use 'SoftwareTeam ps --nodes --fields contextUsage --json' to see what daemon is reporting.`,
    };
  }

  // PL-019 item 1: agentActivity.state is enum-valued; reject invalid values
  // up-front so operators don't get a silent empty result on a typo. Three-part
  // shape per `feedback_smart_agents_no_bureaucracy.md`: what failed / what's
  // allowed / what to do.
  if (key === "agentActivity.state" && !ALLOWED_AGENT_ACTIVITY_STATES.has(value)) {
    return {
      error: `--filter agentActivity.state='${value}' is not a valid activity state. ` +
        `Allowed: ${[...ALLOWED_AGENT_ACTIVITY_STATES].sort().join(", ")}. ` +
        `Use 'SoftwareTeam ps --nodes --fields agentActivity --json' to see what daemon is reporting.`,
    };
  }

  // Non-numeric keys must use op = "=".
  if (op !== "=") {
    return {
      error: `--filter ${key}${op}... uses a numeric comparator on a non-numeric key. ` +
        `Allowed numeric keys: ${[...NUMERIC_FILTER_KEYS].sort().join(", ")}. ` +
        `Use ${key}=<value> for equality.`,
    };
  }
  return { key, value, op };
}

// PL-012: derive a context-usage tier from a numeric percent. Lockstep
// with daemon-side computeContextHealthSummary thresholds.
function deriveContextUsageState(percent: number | null | undefined): "critical" | "warning" | "low" | "unknown" {
  if (typeof percent !== "number") return "unknown";
  if (percent >= 80) return "critical";
  if (percent >= 60) return "warning";
  return "low";
}

// C9a: validate --fields against a per-level allow-list. Mirrors parseFilter's
// shape: rejects with a sorted-supported-list error message including the
// unknown key(s) quoted. The level-aware "Hint" fires when an operator types
// `--fields name` against a node query (the most likely confusion case
// preserved by the softwareTeamName/name aliasing at software-team-level only).
function parseFields(input: string, allowed: Set<string>, level: "softwareTeam" | "nodes"): string[] | { error: string } {
  const fields = input.split(",").map((f) => f.trim()).filter((f) => f.length > 0);
  if (fields.length === 0) {
    return { error: `--fields cannot be empty` };
  }
  const unknown = fields.filter((f) => !allowed.has(f));
  if (unknown.length > 0) {
    const sorted = [...allowed].sort().join(", ");
    const hint = level === "nodes" && unknown.includes("name")
      ? ` Hint: 'name' is a software-team-level field; use 'softwareTeamName' for node entries.`
      : "";
    const keyWord = unknown.length > 1 ? "keys" : "key";
    return {
      error: `Unknown --fields ${keyWord} ${unknown.map((u) => `'${u}'`).join(", ")}. Supported: ${sorted}.${hint}`,
    };
  }
  return fields;
}

interface ParsedPsControls {
  parsedFilter: ParsedFilter | null;
  limit: number | null;
  fields: string[] | null;
  useEnvelope: boolean;
}

function parsePsControls(opts: PsCliOptions): ParsedPsControls | { error: string } {
  let effectiveFilter = opts.filter;
  if (opts.active) {
    // Slice 15 (finding 5): agent activity is a per-NODE signal; the LOCAL
    // software-team-summary tier carries only an activeCount aggregate and cannot honestly
    // filter on it. A bare local `SoftwareTeam ps --active` used to be a silent no-op that
    // looked like it worked — fail loudly and state the node-only scope. Remote
    // paths (--host/--all-hosts/--hosts) FORWARD --active to the remote, which
    // applies (and re-validates) it there, so they are exempt from the local gate.
    const isRemote = !!(opts.host || opts.allHosts || opts.hosts);
    if (!opts.nodes && !isRemote) {
      return {
        error:
          `--active/--running filters agentActivity.state, a per-node signal available only at the node tier. ` +
          `Add --nodes (software-team-summary rows carry no per-node activity) — nothing was filtered.`,
      };
    }
    if (effectiveFilter) {
      return {
        error:
          `--active and --filter cannot be combined. ` +
          `--active is sugar for --filter agentActivity.state=running. ` +
          `Pick one form, or compose by upgrading to --filter directly.`,
      };
    }
    effectiveFilter = "agentActivity.state=running";
  }

  let parsedFilter: ParsedFilter | null = null;
  if (effectiveFilter) {
    const result = parseFilter(effectiveFilter);
    if ("error" in result) return result;
    parsedFilter = result;
  }

  const limit = opts.limit !== undefined ? Number(opts.limit) : null;
  if (limit !== null && (!Number.isInteger(limit) || limit < 0)) {
    return { error: `--limit must be a non-negative integer; got '${opts.limit}'` };
  }

  let fields: string[] | null = null;
  if (opts.fields !== undefined) {
    const fieldsLevel: "softwareTeam" | "nodes" = opts.nodes ? "nodes" : "softwareTeam";
    const fieldsAllowed = fieldsLevel === "nodes" ? ALLOWED_NODE_FIELDS : ALLOWED_SOFTWARE_TEAM_FIELDS;
    const fieldsResult = parseFields(opts.fields, fieldsAllowed, fieldsLevel);
    if ("error" in fieldsResult) return fieldsResult;
    fields = fieldsResult;
  }

  return {
    parsedFilter,
    limit,
    fields,
    useEnvelope: parsedFilter !== null || limit !== null || fields !== null || opts.summary === true,
  };
}

function applySoftwareTeamFilter(entries: PsEntry[], filter: ParsedFilter): PsEntry[] {
  return entries.filter((e) => {
    if (filter.key === "status") return e.status === filter.value;
    if (filter.key === "lifecycleState") return e.lifecycleState === filter.value;
    if (filter.key === "name-prefix") return (e.softwareTeamName ?? e.name).startsWith(filter.value);
    if (filter.key === "name") return (e.softwareTeamName ?? e.name) === filter.value;
    // PL-019 item 1: agentActivity.state is node-level only; at the softwareTeam
    // level it has no meaning, so the filter passes everything through and
    // the user gets all softwareTeams (the operator can `--nodes` to scope it).
    if (filter.key === "agentActivity.state") return true;
    // PL-012: contextUsage.* filters are node-level only.
    if (filter.key === "contextUsage.percent" || filter.key === "contextUsage.state") return true;
    return true;
  });
}

function applyNodeFilter(entries: NodeEntry[], filter: ParsedFilter): NodeEntry[] {
  return entries.filter((n) => {
    // status maps to sessionStatus for nodes; lifecycleState applies directly.
    if (filter.key === "status") return n.sessionStatus === filter.value;
    if (filter.key === "lifecycleState") return n.lifecycleState === filter.value;
    if (filter.key === "name-prefix") return n.softwareTeamName.startsWith(filter.value);
    if (filter.key === "name") return n.softwareTeamName === filter.value;
    // PL-019 item 1: nested-key traversal for agentActivity.state. Nodes
    // without an agentActivity attachment never match a non-unknown filter
    // value (the daemon reports `unknown` when it has no signal — explicit).
    if (filter.key === "agentActivity.state") return n.agentActivity?.state === filter.value;
    // PL-012: contextUsage.percent — numeric comparison. Nodes with no
    // sample fail every comparator (operator can filter on
    // contextUsage.state=unknown to find them).
    if (filter.key === "contextUsage.percent") {
      const pct = n.contextUsage?.usedPercentage;
      if (typeof pct !== "number" || filter.numericValue === undefined) return false;
      switch (filter.op) {
        case ">=": return pct >= filter.numericValue;
        case ">":  return pct >  filter.numericValue;
        case "<=": return pct <= filter.numericValue;
        case "<":  return pct <  filter.numericValue;
        case "=":  return pct === filter.numericValue;
      }
    }
    if (filter.key === "contextUsage.state") {
      const derived = n.contextUsage?.state ?? deriveContextUsageState(n.contextUsage?.usedPercentage ?? null);
      return derived === filter.value;
    }
    return true;
  });
}

// OPR.0.3.3.19 - build the /api/ps path, opting archived softwareTeams back in when
// --include-archived is set. Default (no flag) leaves the daemon's
// archived-excluding default in force.
function fanOutNodesError(): string {
  return [
    "SoftwareTeam ps --all-hosts/--hosts --nodes: per-node fan-out requires the FULL explicit ladder.",
    "  SoftwareTeam ps --all-hosts --nodes -A             (fleet nodes per host, projected rows)",
    "  SoftwareTeam ps --all-hosts --nodes -A --full      (complete per-node records — the last rung)",
    "One softwareTeam's seats on one host: SoftwareTeam ps --host <id> --nodes --software-team <name>.",
  ].join("\n");
}

/**
 * OPR.0.4.4.21 FR-2/FR-3 — THE centralized disclosure-ladder validator.
 * Runs BEFORE the local/HTTP-host/SSH/fan-out dispatch split so every path
 * obeys one grammar (qa1 plan-review: remote mode bypassed the session-softwareTeam
 * injection and fanned wide). Principle (arch-ratified): IMPLICIT SCOPE
 * DEFAULTS DON'T CROSS HOST BOUNDARIES — the session-softwareTeam default has no
 * stable referent on a remote host (a same-named softwareTeam there would silently
 * misresolve), so remote per-node views are explicit-or-error.
 * Returns the teaching error text, or null when the invocation is valid.
 */
export function validatePsLadder(opts: PsCliOptions, callerSoftwareTeam: string | undefined): string | null {
  const isFanOut = !!(opts.allHosts || opts.hosts);
  const isSingleRemote = !!opts.host;

  // SWEEP-b (shape f2576102) — `--session` is a --nodes filter; on the softwareTeam tier it was
  // accepted-and-dropped (silent all-softwareTeams listing). Reject with the valid form taught.
  if (opts.session !== undefined && !opts.nodes) {
    return [
      "SoftwareTeam ps --session: '--session' filters NODES, so it needs the --nodes tier.",
      "Valid form: SoftwareTeam ps --nodes --session <member@software-team> (add --software-team/-A for scope).",
    ].join("\n");
  }

  // FR-3: -A/--all-software-teams has exactly ONE meaning — the --nodes fleet widener.
  if (opts.allSoftwareTeams && !opts.nodes) {
    return [
      "SoftwareTeam ps -A: '-A/--all-software-teams' now has exactly one meaning — the --nodes fleet widener.",
      "The consolidated all-softwareTeams view IS the default: just run 'SoftwareTeam ps'.",
      "Fleet nodes: SoftwareTeam ps --nodes -A (add --full for complete per-node records).",
      "Archived history: SoftwareTeam ps --include-archived.",
    ].join("\n");
  }

  // FR-5: multi-host fan-out is rollup-only UNLESS the full explicit
  // ladder is requested — `--nodes -A` per host (`--full` for complete
  // records), exactly as the PRD writes it. Anything less explicit under
  // --nodes errors; never silent software-team-tier data under a --nodes flag.
  if (opts.nodes && isFanOut && !opts.allSoftwareTeams) {
    return fanOutNodesError();
  }

  // FR-2: --nodes always names its scope — session default locally,
  // explicit --software-team / -A everywhere else. Never an implicit fan-out.
  if (opts.nodes && !opts.softwareTeam && !opts.allSoftwareTeams) {
    if (isFanOut) {
      return fanOutNodesError();
    }
    if (isSingleRemote) {
      return [
        `SoftwareTeam ps --host ${opts.host} --nodes: no target — the local session's SoftwareTeam is not a remote scope`,
        "(implicit scope defaults don't cross host boundaries; a same-named remote SoftwareTeam would silently misresolve).",
        `Name one: SoftwareTeam ps --host ${opts.host} --nodes --software-team <name>, or that host's fleet explicitly: SoftwareTeam ps --host ${opts.host} --nodes -A.`,
      ].join("\n");
    }
    if (!callerSoftwareTeam) {
      return [
        "SoftwareTeam ps --nodes: no target — outside a managed session there is no current SoftwareTeam to default to.",
        "Name one: SoftwareTeam ps --nodes --software-team <name>, or go fleet-wide explicitly: SoftwareTeam ps --nodes -A.",
      ].join("\n");
    }
  }

  return null;
}

function psApiPath(opts: PsCliOptions): string {
  return opts.includeArchived ? "/api/ps?includeArchived=true" : "/api/ps";
}

function selectFields<T extends Record<string, unknown>>(entries: T[], fields: string[]): Array<Record<string, unknown>> {
  return entries.map((e) => {
    const out: Record<string, unknown> = {};
    for (const f of fields) out[f] = e[f];
    return out;
  });
}

function selectFanOutFields(entries: Array<Record<string, unknown>>, fields: string[]): Array<Record<string, unknown>> {
  return entries.map((e) => {
    const [selected] = selectFields([e], fields);
    return { ...selected, hostId: e.hostId };
  });
}

function needsAttention(node: NodeEntry): boolean {
  return node.lifecycleState === "attention_required"
    || node.startupStatus === "attention_required"
    || node.startupStatus === "failed"
    || node.agentActivity?.state === "needs_input";
}

function hasCurrentUsageLimit(node: NodeEntry): boolean {
  const activity = node.agentActivity;
  return activity?.state === "unknown" && activity.reason === "usage_limit"
    && activity.rawEvent === "at_limit" && activity.evidenceSource === "runtime_hook"
    && activity.stale === false && !activity.fallback;
}

/** One line per community agent app seat: what SoftwareTeam knows about it, and what it doesn't. */
export function formatAgentAppLine(seat: string, app: NonNullable<NodeEntry["agentApp"]>): string {
  if (app.presetError) return `Community app (${seat}): ${app.app}: ${app.presetError}.`;
  const limits = app.limits.length ? `; declared limits: ${app.limits.join("; ")}` : "";
  return `Community app (${seat}): ${app.app}, maintained by ${app.maintainer}, not tested by SoftwareTeam. Identity ${app.identity}; needs-input ${app.needsInput}${limits}.`;
}

function missingSessionGuidance(node: NodeEntry): string | null {
  return node.identityVerdict?.reason === "session_missing"
    ? "tmux session missing; restore or relaunch the seat"
    : null;
}

// OPR.0.4.0.34 — the compact orch field set (PRD FR-4). Carries the
// source-available identity + state + resume-summary fields an orchestrator
// needs at a glance, WITHOUT leaking the resume token value or resumeCommand
// (security). recoveryGuidance/currentUsage stay on the node detail (slice 26).

// 0.5.1 SoftwareTeam ps telemetry (founder-directed): render the DECLARED model.
//
// A blank here must NOT join the em-dash family every other empty cell uses.
// 13 of 15 claude-code seats carry no declared model, and a reader seeing "—"
// would reasonably conclude the seat HAS no model rather than that none was
// declared. "not-declared" is the honest word for an absent declaration.
//
// SCOPE, stated because the column invites a wider reading: this is the
// SPEC-DECLARED model (nodes.model), NOT the model the seat is running. The
// running model has no producer today — it is the ACTIVITY-umbrella rider.
export function formatDeclaredModel(model: string | null | undefined): string {
  const m = (model ?? "").trim();
  return m.length > 0 ? m : "not-declared";
}

export function compactNodeProjection(nodes: NodeEntry[]): Array<Record<string, unknown>> {
  return nodes.map((n) => {
    const attention = needsAttention(n);
    const compact: Record<string, unknown> = {
      // identity (softwareTeamId/softwareTeamName + logicalId + session) — disambiguates under -A.
      softwareTeamId: n.softwareTeamId,
      softwareTeamName: n.softwareTeamName,
      logicalId: n.logicalId,
      canonicalSessionName: n.canonicalSessionName,
      // Slice 13 fix 2 — host attribution rides the compact projection too; a
      // projected roster must stay attributable or partial reads as authoritative.
      hostSelfId: n.hostSelfId ?? null,
      // 0.5.1 founder-directed telemetry: runtime + DECLARED model.
      // node-inventory carries both; this projection dropped them, which is why
      // an orchestrator could not tell a rate-limited seat from a stalled one.
      // runtime is complete fleet-wide; model is a DECLARATION, absent on 13 of
      // 15 claude-code seats — see formatDeclaredModel for the render rule.
      runtime: n.runtime ?? null,
      ...(n.agentApp ? { agentApp: n.agentApp } : {}),
      model: n.model ?? null,
      // lifecycle + session/startup state.
      sessionStatus: n.sessionStatus,
      startupStatus: n.startupStatus,
      // OPR.0.4.3.06 — challenge-verified orientation, distinct from ready.
      oriented: n.oriented ?? "n-a",
      lifecycleState: n.lifecycleState,
      // Keep the current usage limit visible without classifying it as human attention.
      agentActivity: attention || hasCurrentUsageLimit(n)
        ? { state: n.agentActivity?.state ?? "unknown", reason: n.agentActivity?.reason }
        : { state: n.agentActivity?.state ?? "unknown" },
      // Work counts. Compact keeps the base pending-only key plus the active
      // total needed for honest rendering; exact state siblings remain on
      // --full and explicit --fields.
      hasAssignedWork: n.hasAssignedWork,
      assignedWorkCount: n.assignedWorkCount,
      pendingWorkCount: n.pendingWorkCount,
      // resume summary — type + PRESENT boolean only (never the token value).
      resumeType: n.resumeType ?? null,
      resumeTokenPresent: Boolean(n.resumeToken),
      // updated/age proxy. The node-list emits no dedicated `updatedAt`; the
      // freshest signal is agentActivity.sampledAt, then startupCompletedAt,
      // else null (documented FR-4 fallback — not a fabricated timestamp).
      lastActivity: n.agentActivity?.sampledAt ?? n.startupCompletedAt ?? null,
    };
    if (n.intentionallyStopped !== undefined) compact.intentionallyStopped = n.intentionallyStopped;
    // held/attention reason (short) when present.
    if (n.heldReason) compact.heldReason = n.heldReason;
    if (attention && n.latestError) {
      compact.latestError = n.latestError;
    }
    return compact;
  });
}

function summarizeSoftwareTeams(entries: PsEntry[]): {
  totalSoftwareTeams: number;
  totalRunning: number;
  byLifecycle: Record<string, number>;
  byStatus: Record<string, number>;
} {
  const byLifecycle: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  let totalRunning = 0;
  for (const e of entries) {
    const ls = e.lifecycleState ?? "unknown";
    byLifecycle[ls] = (byLifecycle[ls] ?? 0) + 1;
    byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;
    if (e.status === "running") totalRunning++;
  }
  return { totalSoftwareTeams: entries.length, totalRunning, byLifecycle, byStatus };
}

function summarizeNodes(entries: NodeEntry[]): {
  totalNodes: number;
  byLifecycle: Record<string, number>;
  bySessionStatus: Record<string, number>;
} {
  const byLifecycle: Record<string, number> = {};
  const bySessionStatus: Record<string, number> = {};
  for (const n of entries) {
    const ls = n.lifecycleState ?? "unknown";
    byLifecycle[ls] = (byLifecycle[ls] ?? 0) + 1;
    const ss = n.sessionStatus ?? "unknown";
    bySessionStatus[ss] = (bySessionStatus[ss] ?? 0) + 1;
  }
  return { totalNodes: entries.length, byLifecycle, bySessionStatus };
}

// Compact software-team-level lifecycle codes for the softwareTeam table header (3-char fixed width).
function abbrevSoftwareTeamLifecycle(state: PsEntry["lifecycleState"] | undefined): string {
  if (!state) return "—";
  if (state === "running") return "run";
  if (state === "recoverable") return "rec";
  if (state === "stopped") return "stp";
  if (state === "degraded") return "deg";
  if (state === "attention_required") return "att";
  return "—";
}

// Compact per-node lifecycle codes for the nodes table.
function abbrevNodeLifecycle(state: NodeEntry["lifecycleState"] | undefined): string {
  if (!state) return "—";
  if (state === "running") return "run";
  if (state === "recoverable") return "rec";
  if (state === "detached") return "det";
  if (state === "attention_required") return "att";
  return "—";
}

/**
 * `SoftwareTeam ps` — the consolidated fleet map + explicit disclosure ladder.
 *
 * OPR.0.4.4.21: the default is ALL active softwareTeams, one compact O(softwareTeams) row each
 * (the current-software-team-only default is retired). The token-safety invariant: no
 * invocation returns per-node detail across all softwareTeams unless explicitly
 * flagged (--nodes -A), and even then rows are projected unless --full.
 * Default `SoftwareTeam ps --json` keeps the bare-array shape for back-compat; the
 * truncation/envelope shape only applies when at least one of
 * `--limit`/`--summary`/`--fields`/`--filter` is specified.
 */
export function psCommand(depsOverride?: PsDeps): Command {
  const cmd = new Command("ps")
    .description("List softwareTeams and their status")
    .addHelpText("after", `
Default (OPR.0.4.4.21): ALL active softwareTeams, ONE compact row each — O(softwareTeams), never
a fleet node fan-out — plus the host rollup line ("N softwareTeams · M seats · K need
attention"), the archived/stopped count line, and the drill-ladder footer.
STATED contract: default --json is a bare array of ALL non-archived softwareTeams
INCLUDING stopped ones (existing keys preserved; additive attentionCount);
only the HUMAN table folds stopped softwareTeams into the count line.

The disclosure ladder (each heavier view is an explicit step):
  SoftwareTeam ps                      the consolidated map (this default)
  SoftwareTeam ps --software-team <name>         one softwareTeam's detail
  SoftwareTeam ps --nodes              per-node, CURRENT softwareTeam (session default, local only)
  SoftwareTeam ps --nodes --software-team <name> per-node, named softwareTeam
  SoftwareTeam ps --nodes -A           fleet nodes, projected rows
  SoftwareTeam ps --nodes -A --full    complete per-node records (the only full fan-out)

-A/--all-software-teams has exactly ONE meaning: the --nodes fleet widener. Bare -A
errors (all-softwareTeams IS the default; archived history stays behind
--include-archived). The session-software-team default never crosses host boundaries:
remote --nodes requires an explicit --software-team or -A.

Compact defaults: 'SoftwareTeam ps --nodes' shows a compact summary per node
(softwareTeam, session, lifecycle, activity state, reason when attention, queue counts,
resume type + present indicator). Resume token values and resumeCommand are
excluded from compact output (security); use --full to see them.

Use '--full' (or '--verbose') for the uncompacted per-node payload (contextUsage
scalars, resume commands/tokens, agent references). Note (OPR.0.4.0.26): the
node-list payload carries recoveryGuidance: null and contextUsage.currentUsage:
null even with --full; fetch the full recovery guidance + currentUsage from the
single-node detail (/api/software-teams/:softwareTeamId/nodes/:logicalId) or 'SoftwareTeam whoami'.

Examples:
  SoftwareTeam ps                                          All active softwareTeams, one row each + rollup
  SoftwareTeam ps --software-team <name>                             One softwareTeam's detail
  SoftwareTeam ps --full                                   All softwareTeams, no table truncation
  SoftwareTeam ps --json                                   All non-archived softwareTeams, bare JSON array
  SoftwareTeam ps --json --limit 20                        Bounded JSON envelope
  SoftwareTeam ps --json --summary                         Aggregate-only JSON
  SoftwareTeam ps --json --fields softwareTeamName,status,lifecycleState
                                                  Project JSON to named fields
  SoftwareTeam ps --filter lifecycleState=attention_required
                                                  Show only softwareTeams needing attention
  SoftwareTeam ps --filter status=running                  Show only running softwareTeams
  SoftwareTeam ps --filter name-prefix=demo                Filter by software-team-name prefix
  SoftwareTeam ps --nodes                                  Current SoftwareTeam per-node compact summary
  SoftwareTeam ps --nodes -A                               All softwareTeams per-node compact summary
  SoftwareTeam ps --nodes --json                           Current SoftwareTeam per-node compact JSON
  SoftwareTeam ps --nodes --json --full                    Complete per-node LIST payload (guidance/currentUsage relocated to node detail)
  SoftwareTeam ps --nodes --json --software-team softwareteam-build       Compact nodes for a specific softwareTeam
  SoftwareTeam ps --nodes --json --session dev1-impl@myrig Filter to a single session (within current softwareTeam; use -A for cross-software-team)
  SoftwareTeam ps --nodes --json --limit 50                Bounded per-node JSON envelope
  SoftwareTeam ps --nodes --active                         Only nodes with agentActivity.state=running
  SoftwareTeam ps --nodes --running                        Same as --active
  SoftwareTeam ps --nodes --filter agentActivity.state=running
                                                  Same as --active (the explicit form)
  SoftwareTeam ps --host vm-1 --nodes --software-team <name> --json  Remote host per-node (explicit target required)
  SoftwareTeam ps --all-hosts                              Per-host O(softwareTeams) rollups (AggregatedPayload JSON)
  SoftwareTeam ps --include-archived                       Include archived softwareTeams (marked with *); hidden by default

--software-team <name> scopes to one softwareTeam. -A/--all-software-teams is ONLY the --nodes fleet widener.
--session <name> filters within the effective SoftwareTeam scope; use --nodes -A if the
target session is in a different softwareTeam.
Multi-host fan-out (--all-hosts/--hosts) is rollup-only by default; the full
explicit ladder (--all-hosts --nodes -A, --full for complete records) fans out
per-node with hostId-stamped projected rows.

--active/--running narrow to agentActivity.state=running. NODE-TIER ONLY: requires --nodes
(software-team-summary rows carry no per-node activity). Cannot combine with --filter.

--filter accepts: status, lifecycleState, name-prefix, name, agentActivity.state,
contextUsage.percent, contextUsage.state. Other keys are rejected.

--fields accepts (software-team-level): softwareTeamId, name, softwareTeamName, nodeCount, runningCount,
activeCount, hasWorkCount, attentionCount, status, lifecycleState, uptime,
latestSnapshot.
--fields accepts (node-level, with --nodes): softwareTeamId, softwareTeamName, logicalId, podId,
podNamespace, hostSelfId, canonicalSessionName, nodeKind, runtime, agentApp, model, sessionStatus,
intentionallyStopped, startupStatus, restoreOutcome, lifecycleState, tmuxAttachCommand,
resumeCommand, latestError, terminalActive, hasAssignedWork,
assignedWorkCount, pendingWorkCount, inProgressWorkCount, blockedWorkCount,
agentActivity, contextUsage, heldReason.

--host runs on a remote host declared in ~/.softwareteam/hosts.yaml (no current-software-team
default applied; the remote host's softwareTeams are shown).

Exit codes:
  0  Success
  1  Daemon not running, or invalid --filter / --limit / --fields
  2  Failed to fetch data from daemon`);
  const getDepsF = (): PsDeps => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  cmd
    .option("--json", "JSON output for agents")
    .option("--no-cleanup", "Preserve stale daemon state files during observation")
    .option("--resources", "Show this host’s load and transcript capture cost (also supports --host)")
    .option("--nodes", "Show per-node detail (current softwareTeam; -A for all softwareTeams)")
    .option("--full", "Show all SoftwareTeam rows without cell truncation, or all node-list fields with --nodes (recoveryGuidance/currentUsage live on node detail)")
    .option("--verbose", "Alias for --full")
    .option("--limit <n>", "Limit number of entries (softwareTeams or nodes)")
    .option("--fields <list>", "Comma-separated field list to project (JSON only)")
    .option("--summary", "Emit aggregate-only output (counts by status/lifecycle)")
    .option("--filter <key=value>", "Filter entries; supported keys: status, lifecycleState, name-prefix, name, agentActivity.state")
    .option("--active", "Shortcut for --filter agentActivity.state=running (PL-019)")
    .option("--running", "Alias for --active")
    .option("-A, --all-software-teams", "Show all softwareTeams (default is current SoftwareTeam only)")
    .option("--software-team <name>", "Show only nodes belonging to the named softwareTeam")
    .option("--session <name>", "Show only the node matching this canonical session name")
    .option("--include-archived", "Include archived softwareTeams (default hides them); parity with 'SoftwareTeam stream list --include-archived'")
    .option("--host <id>", "Run on a remote host declared in ~/.softwareteam/hosts.yaml")
    .option("--all-hosts", "Fan out to all registered HTTP hosts (observation-only)")
    .option("--hosts <ids>", "Fan out to specific hosts (comma-separated)")
    .action(async (opts: PsCliOptions) => {
      // OPR.0.4.6.MH1 FR-2: selected-host routing — explicit --host wins;
      // else the persisted selection feeds the SHIPPED --host path; no
      // selection = today exactly. Fan-out
      // flags are their OWN explicit scope — never mixed with selection.
      if (!opts.allHosts && !opts.hosts) opts.host = resolveEffectiveHost(opts.host);
      if (opts.verbose) opts.full = true;
      if (opts.running) opts.active = true;
      const isRemote = !!(opts.host || opts.allHosts || opts.hosts);
      // OPR.0.4.4.21 FR-1: the softwareTeam tier is consolidated ALL-ACTIVE-SOFTWARE_TEAMS by
      // default (the current-software-team-only default is RETIRED — it hid running
      // softwareTeams from the operator's field of view). The session-softwareTeam default
      // now applies ONLY to the node tier (FR-2's scoped --nodes), and
      // ONLY locally (the ladder validator enforces explicit-or-error on
      // every remote path).
      const sessionName = readSoftwareTeamEnv("SOFTWARETEAM_SESSION_NAME");
      const callerSoftwareTeam = sessionName ? extractSoftwareTeamName(sessionName) : undefined;
      if (opts.resources && (opts.nodes || opts.allSoftwareTeams || opts.softwareTeam || opts.session || opts.allHosts || opts.hosts || opts.limit || opts.fields || opts.filter || opts.summary || opts.active || opts.includeArchived || opts.full || opts.verbose)) {
        console.error("SoftwareTeam ps --resources supports --json and one --host; softwareTeam/node filters and fan-out do not apply to host measurements.");
        process.exitCode = 1;
        return;
      }
      const ladderError = validatePsLadder(opts, callerSoftwareTeam);
      if (ladderError) {
        console.error(ladderError);
        process.exitCode = 1;
        return;
      }
      // OPR.0.5.0 scope-honesty: capture WHEN --nodes defaulted to the session softwareTeam, so the
      // (correct) current-software-team-only scope is DECLARED in the output — silent completeness is
      // silent loss (a restoring agent must not read a scoped list as the whole host).
      let scopedToSessionSoftwareTeam = false;
      if (opts.nodes && !opts.allSoftwareTeams && !opts.softwareTeam && !isRemote && callerSoftwareTeam) {
        opts.softwareTeam = callerSoftwareTeam;
        scopedToSessionSoftwareTeam = true;
      }
      const deps = getDepsF();

      // OPR.0.4.4.21 rev1-r2 fixback: the shared shaping controls
      // (--active/--filter/--limit/--fields/--summary) parse + validate
      // BEFORE any dispatch — local, single-host, or fan-out — so every
      // path honors the same composition contract and rejections stay
      // pre-HTTP on remote paths too.
      // Parse shared composition controls once up front so local, single-host,
      // and fan-out paths reject malformed --filter/--limit/--fields before
      // any HTTP call and apply the same shaping semantics.
      const controls = parsePsControls(opts);
      if ("error" in controls) {
        console.error(controls.error);
        process.exitCode = 1;
        return;
      }
      const { parsedFilter, limit, fields, useEnvelope } = controls;

      if (opts.allHosts || opts.hosts) {
        // AggregatedPayload is the closed fan-out contract (items + hosts).
        // Do not add an ad-hoc summary member here; teach the per-host form.
        if (opts.summary) {
          console.error(
            "SoftwareTeam ps --all-hosts/--hosts --summary: summary does not compose with the merged fan-out payload.\n" +
            "Summarize one host: SoftwareTeam ps --host <id> --summary; or drop --summary for the merged AggregatedPayload.",
          );
          process.exitCode = 1;
          return;
        }
        await runFanOutPs(opts, deps, { parsedFilter, limit, fields });
        return;
      }

      if (opts.host) {
        await runCrossHostPs(opts.host, opts, deps);
        return;
      }

      const status = await getDaemonStatus(deps.lifecycleDeps, { cleanupStaleState: opts.cleanup });
      if (!daemonStatusGuard(status)) return;

      const client = deps.clientFactory(getDaemonUrl(status));

      if (opts.resources) {
        await handleResources(client, opts.json);
        return;
      }
      if (opts.nodes) {
        await handleNodes(client, opts, parsedFilter, limit, fields, useEnvelope, undefined, scopedToSessionSoftwareTeam);
        return;
      }

      // OPR.0.4.4.21 FR-1: ONE O(softwareTeams) fetch including archived so the
      // count line can be computed; visibility is split client-side below
      // (JSON keeps today's default of excluding archived — parity).
      const res = await client.get<PsEntry[]>("/api/ps?includeArchived=true");

      if (res.status >= 400) {
        const reason = (res.data as unknown as { error?: unknown } | null)?.error;
        if (typeof reason === "string" && reason) console.error(reason);
        console.error(`Failed to fetch SoftwareTeam list from daemon (HTTP ${res.status}). Check daemon status with: SoftwareTeam status`);
        process.exitCode = 2;
        return;
      }

      const all = res.data;

      // OPR.0.4.4.21 — archived visibility parity: the daemon call above
      // always includes archived (for the count line); without
      // --include-archived they are dropped from BOTH renders here, exactly
      // as the daemon default used to do. archivedCount feeds the FR-1
      // count line only.
      const archivedCount = all.filter((e) => e.isArchived === true).length;
      const visible = opts.includeArchived ? all : all.filter((e) => e.isArchived !== true);

      const softwareTeamScoped = opts.softwareTeam
        ? visible.filter((e) => (e.softwareTeamName ?? e.name) === opts.softwareTeam)
        : visible;

      // Apply CLI-side filter (Amendment A: prefer CLI shaping).
      const filtered = parsedFilter ? applySoftwareTeamFilter(softwareTeamScoped, parsedFilter) : softwareTeamScoped;

      // Summary mode short-circuits per-entry output.
      if (opts.summary) {
        const summary = summarizeSoftwareTeams(filtered);
        if (opts.json) {
          console.log(JSON.stringify(summary));
        } else {
          console.log(`totalSoftwareTeams: ${summary.totalSoftwareTeams}`);
          console.log(`totalRunning: ${summary.totalRunning}`);
          console.log(`byStatus: ${JSON.stringify(summary.byStatus)}`);
          console.log(`byLifecycle: ${JSON.stringify(summary.byLifecycle)}`);
        }
        return;
      }

      // Apply --limit on top of filter (CLI side; daemon stays bare-array).
      const limited = limit !== null ? filtered.slice(0, limit) : filtered;
      const truncated = limit !== null && filtered.length > limit;

      // Field projection runs last so requested fields apply to the limited set.
      const projected = fields ? selectFields(limited as unknown as Array<Record<string, unknown>>, fields) : limited;

      if (opts.json) {
        if (useEnvelope) {
          // Envelope only on flag use; default JSON stays a bare array for compat.
          const envelope: Record<string, unknown> = {
            entries: projected,
            totalSoftwareTeams: filtered.length,
            truncated,
          };
          if (truncated) envelope.hint = "SoftwareTeam ps --full --json";
          console.log(JSON.stringify(envelope));
        } else {
          console.log(JSON.stringify(projected));
        }
        return;
      }

      if (limited.length === 0) {
        if (parsedFilter) {
          console.log(`No softwareTeams match --filter ${parsedFilter.key}=${parsedFilter.value}`);
        } else if (archivedCount > 0 && !opts.includeArchived) {
          // Proven-empty with the history pointer, never a bare "No softwareTeams"
          // while archived history exists.
          console.log(`No active softwareTeams · ${archivedCount} archived (SoftwareTeam ps --include-archived)`);
        } else {
          console.log("No softwareTeams");
        }
        return;
      }

      // OPR.0.4.4.21 FR-1 (human table ONLY — JSON keeps ALL non-archived
      // entries including stopped; this scope split is a STATED contract
      // sentence in the help text): on the BARE default (no filter, no
      // --software-team, no --include-archived) stopped softwareTeams fold into the count
      // line — history is what the default drops, not field of view.
      const bareDefault = !parsedFilter && !opts.softwareTeam && !opts.includeArchived;
      const tableRows = bareDefault ? limited.filter(isActiveSoftwareTeam) : limited;
      const stoppedCount = bareDefault ? limited.length - tableRows.length : 0;

      // FR-1 display element 1: the host rollup line.
      const rollupSeats = tableRows.reduce((n, e) => n + e.nodeCount, 0);
      const rollupAttention = tableRows.reduce((n, e) => n + (e.attentionCount ?? 0), 0);
      console.log(`${tableRows.length} softwareTeam${tableRows.length === 1 ? "" : "s"} · ${rollupSeats} seat${rollupSeats === 1 ? "" : "s"} · ${rollupAttention} need${rollupAttention === 1 ? "s" : ""} attention`);

      // Human output: apply default truncation budget unless --full.
      const humanList = (opts.full || limit !== null) ? tableRows : tableRows.slice(0, HUMAN_SOFTWARE_TEAM_BUDGET);
      const humanTruncated = !opts.full && limit === null && tableRows.length > HUMAN_SOFTWARE_TEAM_BUDGET;

      const headers = ["SOFTWARE_TEAM", "NODES", "RUNNING", "ACTIVE", "WORK", "ATTN", "STATUS", "LIFECYCLE", "UPTIME", "SNAPSHOT"];
      const rows = (humanList as PsEntry[]).map((e) => [
        e.isArchived ? `${e.softwareTeamName ?? e.name} *` : (e.softwareTeamName ?? e.name),
        String(e.nodeCount),
        String(e.runningCount),
        e.activeCount !== undefined ? String(e.activeCount) : "—",
        e.hasWorkCount !== undefined ? String(e.hasWorkCount) : "—",
        e.attentionCount !== undefined ? (e.attentionCount > 0 ? `▲${e.attentionCount}` : "0") : "—",
        e.status,
        abbrevSoftwareTeamLifecycle(e.lifecycleState),
        e.uptime ?? "—",
        e.latestSnapshot ?? "—",
      ]);
      const widths = [24, 7, 9, 8, 6, 6, 10, 11, 11];
      if (opts.full) {
        for (const row of rows) {
          for (let i = 0; i < widths.length; i++) {
            widths[i] = Math.max(widths[i]!, stringWidth(row[i]!));
          }
        }
      } else {
        for (let i = 0; i < widths.length; i++) widths[i] = widths[i]! - SOFTWARE_TEAM_COLUMN_SEPARATOR.length;
      }
      console.log(padSoftwareTeamRow(headers, widths));
      for (const row of rows) console.log(padSoftwareTeamRow(row, widths));
      const anyArchivedShown = humanList.some((e) => e.isArchived);
      const hiddenHistory = stoppedCount > 0 || (!opts.includeArchived && archivedCount > 0);
      if (anyArchivedShown || hiddenHistory || bareDefault || humanTruncated || truncated) console.log("");
      if (anyArchivedShown) {
        console.log("* = archived (hidden from the default view; shown via --include-archived). Reverse with: SoftwareTeam unarchive <softwareTeam>");
      }
      // FR-1 display element 2: history as ONE count line, never rows.
      if (hiddenHistory) {
        const parts: string[] = [];
        if (stoppedCount > 0) parts.push(`${stoppedCount} stopped (SoftwareTeam ps --filter status=stopped)`);
        if (!opts.includeArchived && archivedCount > 0) parts.push(`${archivedCount} archived (SoftwareTeam ps --include-archived)`);
        console.log(`not shown: ${parts.join(" · ")}`);
      }
      // FR-1 display element 3: the affordance footer — the drill ladder.
      if (bareDefault) {
        console.log("drill: SoftwareTeam ps --software-team <name> (one softwareTeam) · SoftwareTeam ps --nodes --software-team <name> (its seats) · --full (everything)");
      }
      if (humanTruncated) {
        const remaining = filtered.length - HUMAN_SOFTWARE_TEAM_BUDGET;
        console.log(`... and ${remaining} more softwareTeam${remaining === 1 ? "" : "s"} (truncated at ${HUMAN_SOFTWARE_TEAM_BUDGET}).`);
        console.log("Run 'SoftwareTeam ps --full' to see all, or 'SoftwareTeam ps --filter lifecycleState=attention_required' to narrow.");
      } else if (truncated) {
        const remaining = filtered.length - (limit ?? 0);
        console.log(`... and ${remaining} more softwareTeam${remaining === 1 ? "" : "s"} (--limit ${limit}).`);
      }
    });

  return cmd;
}

async function handleNodes(
  client: DaemonClient,
  opts: PsCliOptions,
  parsedFilter: ParsedFilter | null,
  limit: number | null,
  fields: string[] | null,
  useEnvelope: boolean,
  requestHeaders?: Record<string, string>,
  scopedToSessionSoftwareTeam?: boolean,
): Promise<void> {
  const softwareTeamRes = await client.get<PsEntry[]>(psApiPath(opts), requestHeaders ? { headers: requestHeaders } : undefined);
  if (softwareTeamRes.status >= 400) {
    const reason = (softwareTeamRes.data as unknown as { error?: unknown } | null)?.error;
    if (typeof reason === "string" && reason) console.error(reason);
    console.error(`Failed to fetch SoftwareTeam list from daemon (HTTP ${softwareTeamRes.status}). Check daemon status with: SoftwareTeam status`);
    process.exitCode = 2;
    return;
  }

  const effectiveSoftwareTeams = opts.softwareTeam
    ? softwareTeamRes.data.filter((r) => (r.softwareTeamName ?? r.name) === opts.softwareTeam)
    : softwareTeamRes.data;

  // OPR.0.4.3 healthz-wedge: the daemon nodes route is CHEAP by default (no
  // per-node tmux capture) — `SoftwareTeam ps --nodes` gets snapshot-based activity. Pass
  // ?full=true only when the operator asks for --full, which opts into the
  // per-node pane-heuristic (freshest needs_input) at the fan-out's cost.
  const nodesQuery = opts.full ? "?full=true" : "";
  const allNodes: NodeEntry[] = [];
  for (const softwareTeam of effectiveSoftwareTeams) {
    const nodesRes = await client.get<NodeEntry[]>(`/api/software-teams/${encodeURIComponent(softwareTeam.softwareTeamId)}/nodes${nodesQuery}`, requestHeaders ? { headers: requestHeaders } : undefined);
    if (nodesRes.status >= 400) {
      console.error(`Warning: failed to fetch nodes for softwareTeam "${softwareTeam.softwareTeamName ?? softwareTeam.name}" (HTTP ${nodesRes.status}). List softwareTeams with: SoftwareTeam ps`);
      continue;
    }
    const parentSoftwareTeamName = softwareTeam.softwareTeamName ?? softwareTeam.name;
    allNodes.push(...nodesRes.data.map((n) => ({
      ...n,
      softwareTeamId: n.softwareTeamId ?? softwareTeam.softwareTeamId,
      softwareTeamName: n.softwareTeamName ?? parentSoftwareTeamName,
    })));
  }

  let narrowed = allNodes;
  if (opts.softwareTeam) narrowed = narrowed.filter((n) => n.softwareTeamName === opts.softwareTeam);
  if (opts.session) narrowed = narrowed.filter((n) => n.canonicalSessionName === opts.session);

  const filtered = parsedFilter ? applyNodeFilter(narrowed, parsedFilter) : narrowed;

  if (opts.summary) {
    const summary = summarizeNodes(filtered);
    if (opts.json) {
      console.log(JSON.stringify(summary));
    } else {
      console.log(`totalNodes: ${summary.totalNodes}`);
      console.log(`bySessionStatus: ${JSON.stringify(summary.bySessionStatus)}`);
      console.log(`byLifecycle: ${JSON.stringify(summary.byLifecycle)}`);
    }
    return;
  }

  const limited = limit !== null ? filtered.slice(0, limit) : filtered;
  const limitTruncated = limit !== null && filtered.length > limit;
  const useCompact = !opts.full && !fields;
  const projected = fields
    ? selectFields(limited as unknown as Array<Record<string, unknown>>, fields)
    : useCompact
      ? compactNodeProjection(limited)
      : limited;

  // OPR.0.5.0 scope-honesty: when --nodes defaulted to the session softwareTeam AND other softwareTeams exist on the
  // host, DECLARE the scope so a scoped list is never read as the whole host. Single-softwareTeam hosts and
  // explicit --software-team/-A paths stay byte-stable (nothing hidden -> no scope envelope, no stderr hint).
  // The count MUST match the surface the hint cites: `SoftwareTeam ps`'s bare-default header renders the
  // ACTIVE-softwareTeam projection — stopped softwareTeams fold into a count line, not the field of view (the FR-1
  // contract at ~L942). So softwareTeamsOnHost counts that SAME active set; counting every non-archived
  // entry (stopped included) would make "1 of N" disagree with what the operator sees when they
  // follow the hint (the derived-label-must-carry-liveness / width-clip-honesty class).
  const softwareTeamsOnHost = softwareTeamRes.data.filter(isActiveSoftwareTeam).length;
  const scope = scopedToSessionSoftwareTeam && softwareTeamsOnHost > 1
    ? { softwareTeam: opts.softwareTeam as string, softwareTeamsOnHost, hint: `1 of ${softwareTeamsOnHost} softwareTeams shown; SoftwareTeam ps lists all; --software-team NAME or -A for others` }
    : null;

  if (opts.json) {
    if (useEnvelope || scope) {
      const envelope: Record<string, unknown> = {
        entries: projected,
        totalNodes: filtered.length,
        truncated: limitTruncated,
      };
      if (limitTruncated) envelope.hint = "SoftwareTeam ps --nodes --full --json";
      if (scope) envelope.scope = scope;
      console.log(JSON.stringify(envelope));
    } else {
      console.log(JSON.stringify(projected));
    }
    return;
  }

  // The matching human-path line (stderr, so it never pollutes piped stdout).
  if (scope) {
    console.error(`1 of ${softwareTeamsOnHost} softwareTeams shown (scoped to ${opts.softwareTeam}); SoftwareTeam ps lists all — use --software-team NAME or -A for others`);
  }

  if (limited.length === 0) {
    if (parsedFilter) {
      console.log(`No nodes match --filter ${parsedFilter.key}=${parsedFilter.value}`);
    } else {
      console.log("No nodes");
    }
    return;
  }

  const humanList = (opts.full || limit !== null) ? limited : limited.slice(0, HUMAN_NODE_BUDGET);
  const humanTruncated = !opts.full && limit === null && filtered.length > HUMAN_NODE_BUDGET;

  if (useCompact) {
    console.log(padCompactNodeRow("SOFTWARE_TEAM", "SESSION", "LIFECYCLE", "ACTIVITY", "WORK", "REASON"));
    for (const n of humanList as NodeEntry[]) {
      const attn = needsAttention(n);
      const reason = missingSessionGuidance(n) ?? (attn || hasCurrentUsageLimit(n)
        ? (n.latestError ? truncate(n.latestError, 40) : n.agentActivity?.reason ?? "—")
        : "—");
      console.log(padCompactNodeRow(
        n.softwareTeamName,
        n.canonicalSessionName ?? "—",
        abbrevNodeLifecycle(n.lifecycleState),
        formatActivity(n),
        formatHasWork(n.hasAssignedWork, n.assignedWorkCount ?? n.pendingWorkCount),
        reason,
      ));
    }
  } else {
    const identityWidth = Math.max(30, ...humanList.map(n => `${n.softwareTeamName}#${n.softwareTeamId}`.length + 2));
    const header = padNodeRow("SOFTWARE_TEAM", "POD", "MEMBER", "SESSION", "RUNTIME", "MODEL(DECLARED)", "STATUS", "STARTUP", "ORIENTED", "LIFECYCLE", "TERMINAL", "WORK", "ACTIVITY", "CTX", "RESTORE", "ERROR", identityWidth);
    console.log(header);
    for (const n of humanList as NodeEntry[]) {
      const parts = n.logicalId.split(".");
      const pod = n.podNamespace ?? (parts.length > 1 ? parts[0]! : "—");
      const member = parts.length > 1 ? parts.slice(1).join(".") : n.logicalId;
      const softwareTeam = `${n.softwareTeamName}#${n.softwareTeamId}`;
      console.log(padNodeRow(
        softwareTeam,
        pod,
        member,
        n.canonicalSessionName ?? "—",
        n.runtime ?? "—",
        formatDeclaredModel(n.model),
        n.sessionStatus ?? "—",
        n.startupStatus ?? "—",
        n.oriented ?? "—",
        abbrevNodeLifecycle(n.lifecycleState),
        formatTerminalActive(n.terminalActive),
        formatHasWork(n.hasAssignedWork, n.assignedWorkCount ?? n.pendingWorkCount),
        formatActivity(n),
        formatContextUsage(n.contextUsage),
        n.restoreOutcome,
        missingSessionGuidance(n) ?? (n.latestError ? truncate(n.latestError, 30) : n.heldReason ? `held: ${truncate(n.heldReason, 25)}` : "—"),
        identityWidth,
      ));
    }
  }
  // Keep an actionable startup continuation outside the table's clipped cells.
  for (const n of humanList as NodeEntry[]) {
    if (n.startupStatus === "attention_required" && n.latestError?.includes("SoftwareTeam seat continue ")) {
      console.log(`Startup details (${n.canonicalSessionName ?? n.logicalId}): ${n.latestError}`);
    }
  }
  for (const n of humanList as NodeEntry[]) {
    if (n.agentApp) console.log(formatAgentAppLine(n.canonicalSessionName ?? n.logicalId, n.agentApp));
  }
  if (humanTruncated) {
    const remaining = filtered.length - HUMAN_NODE_BUDGET;
    console.log(`... and ${remaining} more node${remaining === 1 ? "" : "s"} (truncated at ${HUMAN_NODE_BUDGET}).`);
    console.log("Run 'SoftwareTeam ps --nodes --full' to see all, or '--filter lifecycleState=attention_required' to narrow.");
  } else if (limitTruncated) {
    const remaining = filtered.length - (limit ?? 0);
    console.log(`... and ${remaining} more node${remaining === 1 ? "" : "s"} (--limit ${limit}).`);
  }
}

function formatActivity(n: Pick<NodeEntry, "agentActivity" | "activityState" | "agentApp">): string {
  // S19 — render from the served taxonomy state when present: needs-input as
  // count(+reason), otherwise the bridge's display value. No local arbitration.
  const tax = n.activityState;
  if (tax) {
    if (tax.needsInput.count > 0) return `needs-input x${tax.needsInput.count}`;
    // A community agent app has no needs-input source in that state, so its zero isn't a clearance: a prompt the
    // screen shows is kept.
    if (n.agentApp && n.agentActivity?.state === "needs_input") return "needs-input (screen)";
    return tax.display;
  }
  // Legacy fallback (a daemon without the S19 enrichment) — retires with the
  // pre-taxonomy surfaces per the ladder-as-migration rule.
  const activity = n.agentActivity;
  if (!activity) return "unknown";
  if (activity.state === "running") return "running";
  if (activity.state === "needs_input") return "needs_input";
  if (activity.state === "idle") return "idle";
  return "unknown";
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function fitCell(value: string, width: number): string {
  return truncate(value, width).padEnd(width);
}

const SOFTWARE_TEAM_COLUMN_SEPARATOR = "  ";
const softwareTeamCellSegmenter = new Intl.Segmenter();

function fitSoftwareTeamCell(value: string, width: number): string {
  if (stringWidth(value) > width) {
    const limit = width - 1;
    let prefix = "";
    let used = 0;
    for (const { segment } of softwareTeamCellSegmenter.segment(value)) {
      const segmentWidth = stringWidth(segment);
      if (used + segmentWidth > limit) break;
      prefix += segment;
      used += segmentWidth;
    }
    value = prefix + "…";
  }
  return value + " ".repeat(width - stringWidth(value));
}

function padSoftwareTeamRow(cells: string[], widths: number[]): string {
  return cells.map((cell, i) => i < widths.length ? fitSoftwareTeamCell(cell, widths[i]!) : cell).join(SOFTWARE_TEAM_COLUMN_SEPARATOR);
}

export function padNodeRow(softwareTeam: string, pod: string, member: string, session: string, runtime: string, model: string, status: string, startup: string, oriented: string, lifecycle: string, terminal: string, work: string, activity: string, ctx: string, restore: string, error: string, identityWidth = 30): string {
  return [
    fitCell(softwareTeam, identityWidth),
    fitCell(pod, 10),
    fitCell(member, 14),
    fitCell(session, 34),
    fitCell(runtime, 12),
    fitCell(model, 17),
    fitCell(status, 10),
    fitCell(startup, 10),
    // OPR.0.4.3.06 — challenge-verified orientation, distinct from STARTUP.
    fitCell(oriented, 9),
    fitCell(lifecycle, 11),
    // Slice 15 — distinct TERMINAL + WORK columns.
    fitCell(terminal, 9),
    fitCell(work, 6),
    fitCell(activity, 12),
    fitCell(ctx, 6),
    fitCell(restore, 10),
    error,
  ].join("");
}

export function padCompactNodeRow(softwareTeam: string, session: string, lifecycle: string, activity: string, work: string, reason: string): string {
  return [
    fitCell(softwareTeam, 22),
    fitCell(session, 38),
    fitCell(lifecycle, 11),
    fitCell(activity, 14),
    fitCell(work, 6),
    reason,
  ].join("");
}

// Slice 15 — render the terminal-active primitive honestly.
// `null` (no signal) is rendered distinctly from `false` (silent past
// threshold) so an operator can see whether the daemon hasn't observed
// the seat yet vs has observed and seen no output.
function formatTerminalActive(t: boolean | null | undefined): string {
  if (t === true) return "active";
  if (t === false) return "idle";
  return "—"; // null / undefined → no signal
}

// Slice 17 — render the total active assignment count. pendingWorkCount remains
// pending-only and is never substituted here because claimed/blocked work must
// stay visible after it leaves pending. pendingWorkCount is only a compatibility
// fallback for an older daemon that predates assignedWorkCount.
function formatHasWork(has: boolean | undefined, count: number | undefined): string {
  if (has === undefined) return "—";
  if (!has) return "no";
  if (typeof count === "number" && count > 1) return `${count}`;
  return "yes";
}

// PL-012: render context-usage as a 5-char cell — "<percent>%" when
// known + fresh, "<percent>%*" when known but stale, "??" when unknown.
// 4-char width keeps the table compact without truncating two-digit
// percentages (e.g., "98%*" or "5%").
function formatContextUsage(ctx: NodeEntry["contextUsage"]): string {
  if (!ctx || ctx.availability !== "known" || typeof ctx.usedPercentage !== "number") {
    return "??";
  }
  const stale = ctx.fresh === false ? "*" : "";
  return `${ctx.usedPercentage}%${stale}`;
}


async function runCrossHostPs(
  hostId: string,
  opts: PsCliOptions,
  deps: PsDeps,
): Promise<void> {
  const loader = deps.hostRegistryLoader ?? loadHostRegistry;
  const runner = deps.crossHostRun ?? runCrossHostCommand;

  const registry = loader();
  if (!registry.ok) {
    emitCrossHostError(hostId, "registry-load-failed", registry.error, opts.json);
    return;
  }
  const resolved = resolveHost(registry.registry, hostId);
  if (!resolved.ok) {
    emitCrossHostError(hostId, "unknown-host", resolved.error, opts.json);
    return;
  }
  const host = resolved.host;

  if (host.transport === "http") {
    await runHttpPs(host, opts, deps);
    return;
  }

  // SSH path — reconstruct argv
  const argv: string[] = ["SoftwareTeam", "ps"];
  if (opts.cleanup === false) argv.push("--no-cleanup");
  if (opts.resources) argv.push("--resources");
  if (opts.nodes) argv.push("--nodes");
  if (opts.full) argv.push("--full");
  // OPR.0.4.0.34: forward the breadth flag so `--host h -A` keeps all-softwareTeams
  // breadth across the hop (the current-softwareTeam default is local-only and never
  // applied to a remote call, but an explicit -A must still reach the remote).
  // OPR.0.4.4.21 FR-3: -A is legal only alongside --nodes (the validator
  // already rejected the bare form before any dispatch; this guard keeps
  // the reconstructed remote argv obeying the same grammar).
  if (opts.allSoftwareTeams && opts.nodes) argv.push("--all-software-teams");
  if (opts.limit !== undefined) argv.push("--limit", opts.limit);
  if (opts.fields !== undefined) argv.push("--fields", opts.fields);
  if (opts.summary) argv.push("--summary");
  if (opts.filter !== undefined) argv.push("--filter", opts.filter);
  // OPR.0.4.0.34: opts.active is the normalized form (set by --active OR
  // --running). Forward it so the state filter survives the hop.
  if (opts.active) argv.push("--active");
  if (opts.softwareTeam !== undefined) argv.push("--software-team", opts.softwareTeam);
  if (opts.session !== undefined) argv.push("--session", opts.session);
  if (opts.includeArchived) argv.push("--include-archived");
  if (opts.json) argv.push("--json");

  const result = await runner(host, argv);

  if (opts.json) {
    if (result.ok) {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      return;
    }
    emitCrossHostFailure(host.id, hostDisplayTarget(host), result, true);
    return;
  }

  console.log(`[via host=${host.id} (${hostDisplayTarget(host)})]`);
  if (result.ok) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return;
  }
  emitCrossHostFailure(host.id, hostDisplayTarget(host), result, false);
}

function buildRemoteHeaders(token: string | undefined): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function runHttpPs(
  host: HttpHostEntry,
  opts: PsCliOptions,
  deps: PsDeps,
): Promise<void> {
  const bearerResult = resolveRemoteBearer(host);
  if (!bearerResult.ok) {
    emitCrossHostError(host.id, bearerResult.failedStep, bearerResult.error, opts.json);
    process.exitCode = 1;
    return;
  }

  const controls = parsePsControls(opts);
  if ("error" in controls) {
    console.error(controls.error);
    process.exitCode = 1;
    return;
  }
  const { parsedFilter, limit, fields, useEnvelope } = controls;

  // A4: stamp the origin triple on this remote read (fail-open to 2-part when unavailable).
  const originSelfHostId = await resolveOriginSelfHostId(deps.lifecycleDeps);
  const client = remoteDaemonClient(deps.clientFactory, host.url, originSelfHostId);
  const headers = buildRemoteHeaders(bearerResult.token);

  try {
    if (opts.resources) {
      await handleResources(client, opts.json, headers, host.id);
      return;
    }
    if (opts.nodes) {
      await handleNodes(client, opts, parsedFilter, limit, fields, useEnvelope, headers);
      return;
    }

    const res = await client.get<PsEntry[]>(psApiPath(opts), { headers });
    const failedStep = classifyHttpFailedStep(res.status);
    if (failedStep !== "none") {
      emitCrossHostError(host.id, failedStep, `HTTP ${res.status}`, opts.json);
      process.exitCode = 1;
      return;
    }

    const all = Array.isArray(res.data) ? res.data : [];
    const filtered = parsedFilter ? applySoftwareTeamFilter(all, parsedFilter) : all;

    if (opts.summary) {
      const summary = summarizeSoftwareTeams(filtered);
      if (opts.json) {
        console.log(JSON.stringify(summary));
      } else {
        console.log(`[via host=${host.id} (${host.url})]`);
        console.log(JSON.stringify(summary, null, 2));
      }
      return;
    }

    const limited = limit !== null ? filtered.slice(0, limit) : filtered;
    const truncated = limit !== null && filtered.length > limit;
    const projected = fields ? selectFields(limited as unknown as Array<Record<string, unknown>>, fields) : limited;

    if (opts.json) {
      if (useEnvelope) {
        const envelope: Record<string, unknown> = { entries: projected, totalSoftwareTeams: filtered.length, truncated };
        console.log(JSON.stringify(envelope));
      } else {
        console.log(JSON.stringify(projected));
      }
    } else {
      console.log(`[via host=${host.id} (${host.url})]`);
      console.log(JSON.stringify(projected, null, 2));
    }
  } catch (err) {
    const failedStep = classifyHttpError(err);
    emitCrossHostError(host.id, failedStep, (err as Error).message, opts.json);
    process.exitCode = 1;
  }
}

/** INTERNAL transport result of one fan-out leg (arch adjudication: the
 *  shared P4 contract is fanout-contract's AggregatedPayload/PerHostStatus;
 *  this shape survives only as the fan-out's internal carriage, adapted
 *  below before anything is emitted). */
interface FanOutHostResult {
  host: string;
  ok: boolean;
  failedStep: import("../cross-host-types.js").FailedStep | "unsupported-transport";
  data?: unknown;
  error?: string;
}

/** OPR.0.4.4.21 FR-5 — adapter to the intra-P4 shared contract
 *  (fanout-contract.ts, slice 15 first-lander at 0ecd329b; the closed
 *  status enum is THE contract, failedStep rides as additive detail). */
function toPerHostStatus(r: FanOutHostResult): PerHostStatus {
  const status: PerHostStatus["status"] =
    r.ok ? "ok"
    : r.failedStep === "unsupported-transport" ? "unsupported-transport"
    : r.failedStep === "permission-gate" ? "auth-failed"
    : "unreachable";
  const out: PerHostStatus = { hostId: r.host, status };
  if (r.error) out.error = r.error;
  if (!r.ok && r.failedStep !== "unsupported-transport") out.failedStep = r.failedStep;
  return out;
}

async function runFanOutPs(
  opts: PsCliOptions,
  deps: PsDeps,
  shaping: { parsedFilter: ParsedFilter | null; limit: number | null; fields: string[] | null },
): Promise<void> {
  const loader = deps.hostRegistryLoader ?? loadHostRegistry;
  const registry = loader();
  if (!registry.ok) {
    console.error(`Error: ${registry.error}`);
    process.exitCode = 1;
    return;
  }

  const allHosts = registry.registry.hosts;
  let targetIds: string[];
  if (opts.hosts) {
    targetIds = opts.hosts.split(",").map((s) => s.trim()).filter(Boolean);
    const unknown = targetIds.filter((id) => !allHosts.some((h) => h.id === id));
    if (unknown.length > 0) {
      console.error(`Error: unknown host ids: ${unknown.join(", ")}`);
      process.exitCode = 1;
      return;
    }
  } else {
    // OPR.0.4.4.21 fixback (qa1 F1): target EVERY declared host — non-HTTP
    // hosts must appear in hosts[] as unsupported-transport (R15-2), never
    // be silently absent. The per-host leg classifies transport.
    targetIds = allHosts.map((h) => h.id);
  }

  // A4: resolve the origin triple ONCE (it is THIS host's id, identical for every fan-out leg), then
  // stamp it on each remote client — fail-open to 2-part when the local selfHostId is unavailable.
  const originSelfHostId = await resolveOriginSelfHostId(deps.lifecycleDeps);
  const results: FanOutHostResult[] = await Promise.all(
    targetIds.map(async (id): Promise<FanOutHostResult> => {
      const host = allHosts.find((h) => h.id === id);
      if (!host) return { host: id, ok: false, failedStep: "remote-daemon-unreachable", error: `unknown host ${id}` };
      if (host.transport !== "http") {
        // R15-2 (shared contract): an SSH-declared host is a STRUCTURED
        // unsupported-transport status — never prose-only, never silently
        // thinner output.
        return { host: id, ok: false, failedStep: "unsupported-transport", error: `host ${id} uses transport ${host.transport}; HTTP fan-out requires transport: http` };
      }
      const httpHost = host as HttpHostEntry;
      const bearerResult = resolveRemoteBearer(httpHost);
      if (!bearerResult.ok) {
        return { host: id, ok: false, failedStep: bearerResult.failedStep, error: bearerResult.error };
      }
      const client = remoteDaemonClient(deps.clientFactory, httpHost.url, originSelfHostId);
      const headers = buildRemoteHeaders(bearerResult.token);
      try {
        const psQuery = opts.includeArchived ? "?includeArchived=true" : "";
        const res = await client.get<unknown>(`/api/ps${psQuery}`, { headers });
        const failedStep = classifyHttpFailedStep(res.status);
        if (failedStep !== "none") {
          return { host: id, ok: false, failedStep, error: `HTTP ${res.status}` };
        }
        if (!opts.nodes) {
          return { host: id, ok: true, failedStep: "none", data: res.data };
        }
        // OPR.0.4.4.21 FR-5 — the full explicit ladder (--nodes -A, --full
        // for complete records): per-host node fan-out, projected unless
        // --full (the invariant's last rung; validated as -A-only upstream).
        const softwareTeams = Array.isArray(res.data) ? (res.data as PsEntry[]) : [];
        const nodes: NodeEntry[] = [];
        for (const softwareTeam of softwareTeams) {
          const nodesRes = await client.get<NodeEntry[]>(`/api/software-teams/${encodeURIComponent(softwareTeam.softwareTeamId)}/nodes`, { headers });
          if (nodesRes.status >= 400) {
            return { host: id, ok: false, failedStep: classifyHttpFailedStep(nodesRes.status), error: `HTTP ${nodesRes.status} fetching nodes for softwareTeam ${softwareTeam.softwareTeamName ?? softwareTeam.name}` };
          }
          const parentSoftwareTeamName = softwareTeam.softwareTeamName ?? softwareTeam.name;
          nodes.push(...nodesRes.data.map((n) => ({
            ...n,
            softwareTeamId: n.softwareTeamId ?? softwareTeam.softwareTeamId,
            softwareTeamName: n.softwareTeamName ?? parentSoftwareTeamName,
          })));
        }
        return { host: id, ok: true, failedStep: "none", data: nodes };
      } catch (err) {
        return { host: id, ok: false, failedStep: classifyHttpError(err), error: (err as Error).message };
      }
    }),
  );

  const hasFailure = results.some((r) => !r.ok);

  if (opts.json) {
    // OPR.0.4.4.21 FR-5 — the intra-P4 shared payload (ONE contract with
    // slice 15): items = each host's rows stamped with their origin hostId
    // (flat-mergeable; origin never positional), hosts = the per-host
    // structured status array. EVERY targeted host appears in hosts[] —
    // ok or not (no silent thinning).
    const rawItems: Array<Record<string, unknown>> = results.flatMap((r) =>
      r.ok && Array.isArray(r.data)
        ? (r.data as Array<Record<string, unknown>>).map((row) => ({ ...row, hostId: r.host }))
        : [],
    );
    const hostStatuses = results.map(toPerHostStatus);
    let narrowed = rawItems;
    if (opts.softwareTeam) narrowed = narrowed.filter((e) => (e.softwareTeamName ?? e.name) === opts.softwareTeam);
    if (opts.nodes && opts.session) narrowed = narrowed.filter((n) => n.canonicalSessionName === opts.session);

    const filtered = shaping.parsedFilter
      ? opts.nodes
        ? (applyNodeFilter(narrowed as unknown as NodeEntry[], shaping.parsedFilter) as unknown as Array<Record<string, unknown>>)
        : (applySoftwareTeamFilter(narrowed as unknown as PsEntry[], shaping.parsedFilter) as unknown as Array<Record<string, unknown>>)
      : narrowed;

    let items: Array<Record<string, unknown>>;
    if (opts.summary) {
      items = [
        opts.nodes
          ? summarizeNodes(filtered as unknown as NodeEntry[])
          : summarizeSoftwareTeams(filtered as unknown as PsEntry[]),
      ];
    } else {
      const limited = shaping.limit !== null ? filtered.slice(0, shaping.limit) : filtered;
      items = shaping.fields
        ? selectFanOutFields(limited, shaping.fields)
        : opts.nodes && !opts.full
          ? compactNodeProjection(limited as unknown as NodeEntry[]).map((row, i) => ({
              ...row,
              hostId: limited[i]?.hostId,
            }))
          : limited;
    }

    const payload: AggregatedPayload<Record<string, unknown>> = {
      items,
      hosts: hostStatuses,
    };
    console.log(JSON.stringify(payload));
  } else {
    for (const r of results) {
      if (r.ok) {
        console.log(`\n[host=${r.host}]`);
        console.log(JSON.stringify(r.data, null, 2));
      } else {
        console.log(`\n[host=${r.host}] FAILED (${r.failedStep}): ${r.error}`);
      }
    }
  }

  if (hasFailure) process.exitCode = 3;
}


interface HostResources {
  sampledAt: string; cpuCount: number; runningSeats: number;
  loadAverage: number[] | null; loadPerCpu: number[] | null;
  capture: {
    rotatingSeats: number; idleSeats: number; captures: number; failures: number;
    capturedBytes: number; captureDurationMs: number;
    activeIntervalMs: number | null; lines: number | null; maxIdleIntervalMs: number | null;
    settingsReloadError?: string | null;
  };
}

async function handleResources(client: DaemonClient, json?: boolean, headers?: Record<string, string>, hostId?: string): Promise<void> {
  const response = await client.get<HostResources>("/api/ps/resources", headers ? { headers } : undefined);
  if (response.status >= 400) {
    if (hostId && response.status !== 404) {
      emitCrossHostError(hostId, classifyHttpFailedStep(response.status), `HTTP ${response.status}`, json);
      return;
    }
    console.error(`Host resource measurements unavailable (HTTP ${response.status}); this host may need a newer daemon.`);
    process.exitCode = 2;
    return;
  }
  const data = response.data;
  if (json) { console.log(JSON.stringify(data)); return; }
  console.log(`Host: ${hostId ? `${hostId} · ` : ""}${data.cpuCount} available CPUs · ${data.runningSeats} running seats`);
  console.log(data.loadAverage && data.loadPerCpu
    ? `Load (1/5/15m): ${data.loadAverage.map((n) => n.toFixed(2)).join(" / ")} · per CPU: ${data.loadPerCpu.map((n) => n.toFixed(2)).join(" / ")} (not CPU utilization)`
    : "Load average: unavailable on this platform");
  const capture = data.capture;
  console.log(`Transcript capture: ${capture.rotatingSeats} rotating · ${capture.idleSeats} backed off · ${capture.captures} attempts · ${capture.failures} failures`);
  console.log(`Capture cost for currently rotating seats: ${capture.capturedBytes} bytes · ${capture.captureDurationMs.toFixed(1)} ms elapsed across captures (not daemon CPU time)`);
  console.log(`Effective capture: ${capture.activeIntervalMs ?? "unavailable"} ms active · ${capture.maxIdleIntervalMs ?? "unavailable"} ms idle ceiling · ${capture.lines ?? "unavailable"} trailing lines`);
  if (capture.settingsReloadError) console.log(capture.settingsReloadError);
}
