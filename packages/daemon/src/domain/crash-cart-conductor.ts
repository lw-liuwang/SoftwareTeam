// B1 — Crash-cart RESTORE CONDUCTOR (daemon-side batch verb). Plan-locked
// (workspace/missions/release-0.5.2/B1-CRASH-CART-CONDUCTOR-PLAN-2026-08-21, content-hash 84401cd4).
//
// Atom B — the conductor CORE. It restores the fleet's softwareTeams in the founder's
// order (kernel softwareTeam first, then the rest, sequential v1), COMPOSING the shipped
// per-SoftwareTeam restore (findLatestRestoreUsable + RestoreOrchestrator.restore) via an
// injectable `restoreSoftwareTeam` dep — it does NOT re-author restore logic. Best-effort:
// one softwareTeam's failure never halts the fleet. Cancel is STOP-BEFORE-NEXT-SOFTWARE_TEAM: the
// in-flight softwareTeam runs to its own outcome; softwareTeams not yet started become
// `not_attempted` (Atom A/C wire discovery + the fleet rollup; Atom D the TUI ⏎).

/** The shipped closed per-softwareTeam union (never widened at the fleet layer). `not_attempted`
 *  is first-class — a softwareTeam the conductor did not reach (no usable snapshot, or cancelled). */
export type PerSoftwareTeamOutcome = "fully_restored" | "partially_restored" | "failed" | "not_attempted";

/** One softwareTeam's conductor result. `receiptRef` references the durable restore event/attempt
 *  seq (the ledger lineage) — the conductor RENDERS receipts, it never re-authors them. */
export interface ConductorSoftwareTeamResult {
  softwareTeamId: string;
  outcome: PerSoftwareTeamOutcome;
  receiptRef?: string | number;
  /** Per-softwareTeam triage rows (seats needing operator action) — the fleet
   *  attention_required is the UNION of these across the sequence. */
  attention?: AttentionRow[];
  /** R3 — for a `not_attempted` softwareTeam, WHY it was skipped (no honest gap left blank). */
  reason?: string;
  /** R3 — the operator action that would let this softwareTeam be restored next time. */
  remediation?: string;
}

export interface RestoreConductorDeps {
  /** SoftwareTeams in restore order — KERNEL FIRST (the supervisor), then the rest. */
  listSoftwareTeamsInOrder: () => Array<{ softwareTeamId: string; isKernel: boolean }>;
  /** Restore ONE softwareTeam. Default (wired at the route) = findLatestRestoreUsable(softwareTeamId) →
   *  RestoreOrchestrator.restore(snapshotId) → rollupRestoreSoftwareTeamResult; a softwareTeam with no
   *  usable snapshot returns `not_attempted` (never a silent older/partial substitute). */
  restoreSoftwareTeam: (
    softwareTeamId: string,
  ) => Promise<{ outcome: PerSoftwareTeamOutcome; receiptRef?: string | number; attention?: AttentionRow[]; reason?: string; remediation?: string }>;
  /** Cancel signal, polled at each softwareTeam BOUNDARY (stop-before-next-softwareTeam). Optional. */
  isCancelled?: () => boolean;
}

export class RestoreConductor {
  constructor(private readonly deps: RestoreConductorDeps) {}

  /** Restore the fleet, kernel-first, best-effort, honoring stop-before-next-softwareTeam cancel.
   *  Returns the ordered per-softwareTeam sequence (Atom C aggregates it into the FleetRollup). */
  async restoreFleet(opts?: { onSoftwareTeamDone?: (result: ConductorSoftwareTeamResult) => void }): Promise<ConductorSoftwareTeamResult[]> {
    const softwareTeams = this.deps.listSoftwareTeamsInOrder(); // kernel first, then the rest
    const results: ConductorSoftwareTeamResult[] = [];
    // Progress "stream": each softwareTeam's result is emitted as it completes so the
    // route can update a pollable rollup while the fleet restore continues
    // (the locked async shape — the route answers on-commit, never blocks to
    // completion). onSoftwareTeamDone stubbed until wired below (RED-first).
    const record = (result: ConductorSoftwareTeamResult) => {
      results.push(result);
      opts?.onSoftwareTeamDone?.(result); // emit progress as each softwareTeam completes
    };
    for (const softwareTeam of softwareTeams) {
      // Stop-before-next-softwareTeam: poll cancel at the softwareTeam BOUNDARY, before this softwareTeam
      // starts. A softwareTeam already in flight is never interrupted; softwareTeams not yet
      // reached become `not_attempted` (honest, never silently dropped).
      if (this.deps.isCancelled?.()) {
        record({
          softwareTeamId: softwareTeam.softwareTeamId,
          outcome: "not_attempted",
          reason: "cancelled before this SoftwareTeam started (stop-before-next-software-team)",
          remediation: "re-run the fleet restore to attempt this softwareTeam",
        });
        continue;
      }
      try {
        const r = await this.deps.restoreSoftwareTeam(softwareTeam.softwareTeamId);
        record({
          softwareTeamId: softwareTeam.softwareTeamId,
          outcome: r.outcome,
          receiptRef: r.receiptRef,
          attention: r.attention,
          reason: r.reason,
          remediation: r.remediation,
        });
      } catch {
        // Best-effort continue: one softwareTeam's failure never halts the fleet.
        record({ softwareTeamId: softwareTeam.softwareTeamId, outcome: "failed" });
      }
    }
    return results;
  }
}

/** Deps for the DEFAULT per-SoftwareTeam restore — structurally typed so the conductor stays
 *  decoupled from the full orchestrator (the real wiring passes
 *  `snapshotRepo.findLatestRestoreUsable` and `RestoreOrchestrator.restore`, whose
 *  RestoreOutcome satisfies this shape). */
export interface RestoreSoftwareTeamDeps {
  /** Newest restore-usable snapshot for the softwareTeam, or null (→ `not_attempted`; never a silent substitute). */
  findLatestRestoreUsable: (softwareTeamId: string) => { id: string } | null;
  /** Optional richer selector. Production supplies it so the restore attempt
   * records why crash-cart chose this source; legacy test/integration callers
   * may keep the historical finder-only shape. */
  selectRestoreUsable?: (softwareTeamId: string) =>
    | { ok: true; snapshot: { id: string }; selection: import("./types.js").RestoreSnapshotSelection }
    | { ok: false };
  /** The shipped per-SoftwareTeam restore. `onAttemptStarted` yields the restore-started event seq = the receipt ref. */
  restore: (
    snapshotId: string,
    opts?: {
      onAttemptStarted?: (attemptId: number) => void;
      snapshotSelection?: import("./types.js").RestoreSnapshotSelection;
    },
  ) => Promise<{ ok: boolean; result?: { softwareTeamResult: PerSoftwareTeamOutcome; nodes?: RestoreNodeLite[] } }>;
}

// ── AMENDMENT 2 (stamped, body hash 72757e81) — the surviving-panes ADOPT branch ──
// The contradiction it resolves: for a daemon-only crash (panes SURVIVE), restore()
// fail-closes 409 `software_team_not_stopped` BY DESIGN, yet the locked acceptance requires
// resumable seats to RETURN in their panes — achievable only by ADOPTION. Per softwareTeam:
// LIVE panes compose the SHIPPED reconcile/adopt + per-seat resume verification;
// DEAD panes take the restore composition below byte-unchanged. R9 boundary: adoption
// touches SESSION state only (bindings/sessions/events) — never queue state.

/** One seat of the subset-launch result, structurally the shipped RestoreNodeResult
 *  subset the triage mapper reads. */
export interface AdoptSubsetSeat extends RestoreNodeLite {
  logicalId: string;
}

/** Structural slice of RestoreOrchestrator.launchNodeSubset's result — the shipped
 *  per-seat resume-verification machinery (FR-7: an unverifiable resume fail-closes
 *  to awaiting-decision carrying the exact `--fresh <logicalId>` remediation). */
export interface AdoptSubsetResult {
  ok: boolean;
  code?: string;
  message?: string;
  launched?: AdoptSubsetSeat[];
  held?: Array<{ logicalId: string; reason: string }>;
  alreadyRunning?: Array<{ logicalId: string }>;
  failedTargets?: Array<{ logicalId: string; reason: string }>;
}

export interface AdoptSoftwareTeamDeps {
  /** The softwareTeam's DB-running sessions whose tmux panes are ALIVE — the same
   *  classification restore's 409 guard runs (sessionRegistry rows ×
   *  tmuxAdapter.hasSession); the conductor never invents a probe. */
  probeLiveSessions: (softwareTeamId: string) => Promise<Array<{ sessionName: string; logicalId: string }>>;
  /** The shipped no-launch adopt (ClaimService.reconcileSession — the
   *  `softwareTeam reconcile-session` precedent): session state only, never input. */
  reconcileSession: (sessionName: string) => Promise<{ ok: boolean; code?: string; message?: string }>;
  /** The softwareTeam's full seat roster (logical ids) — adoption's complement is what
   *  per-seat resume verification must cover. */
  listSoftwareTeamSeats: (softwareTeamId: string) => string[];
  /** The shipped subset launcher over the NOT-adopted seats. */
  launchNodeSubset: (softwareTeamId: string, logicalIds: string[]) => Promise<AdoptSubsetResult>;
}

/** LIVE-panes branch: adopt every surviving session, then per-seat resume
 *  verification for the rest, folding into the UNCHANGED closed union. A seat is
 *  OK iff it yields no triage row (attentionRowsFromNodes is the single non-OK
 *  authority, so the fold cannot invent a fifth outcome or a second mapping). */
async function adoptLivePanesSoftwareTeam(
  softwareTeamId: string,
  live: Array<{ sessionName: string; logicalId: string }>,
  deps: AdoptSoftwareTeamDeps,
): Promise<{ outcome: PerSoftwareTeamOutcome; attention?: AttentionRow[]; reason?: string; remediation?: string }> {
  const nodes: RestoreNodeLite[] = [];
  const adoptedIds = new Set<string>();
  for (const seat of live) {
    const adopted = await deps.reconcileSession(seat.sessionName);
    if (adopted.ok) {
      adoptedIds.add(seat.logicalId);
      nodes.push({ logicalId: seat.logicalId, status: "resumed" });
    } else {
      nodes.push({
        logicalId: seat.logicalId,
        status: "failed",
        error: `adopt failed for surviving session "${seat.sessionName}": ${adopted.message ?? adopted.code ?? "unknown"}`,
      });
    }
  }
  if (adoptedIds.size === 0) {
    // The stamped mis-probe analysis: probe-says-LIVE on a dead softwareTeam → adopt fails
    // EMPTY (honest). Never proceed to launches on a softwareTeam the adoption itself just
    // proved has no surviving session — re-running takes the restore path.
    return {
      outcome: "not_attempted",
      reason: "probe saw live panes but no surviving session could be adopted (panes likely died between probe and adopt)",
      remediation: "re-run the fleet restore — a genuinely stopped SoftwareTeam takes the snapshot-restore path",
      attention: attentionRowsFromNodes(softwareTeamId, nodes),
    };
  }
  const remaining = deps.listSoftwareTeamSeats(softwareTeamId).filter((id) => !adoptedIds.has(id));
  if (remaining.length > 0) {
    const subset = await deps.launchNodeSubset(softwareTeamId, remaining);
    if (subset.ok) {
      for (const n of subset.launched ?? []) nodes.push(n);
      for (const a of subset.alreadyRunning ?? []) {
        // r1 LOW: a seat whose ADOPT failed can still be proven LIVE by the launcher
        // (it classifies targets against tmux itself). The seat is RUNNING — drop the
        // stale adopt-failure node, or triage would name a running seat as its "need".
        const staleFailed = nodes.findIndex((n) => n.logicalId === a.logicalId && n.status === "failed");
        if (staleFailed >= 0) nodes.splice(staleFailed, 1);
        nodes.push({ logicalId: a.logicalId, status: "resumed" });
      }
      for (const f of subset.failedTargets ?? [])
        nodes.push({ logicalId: f.logicalId, status: "failed", error: `resume verification could not run: ${f.reason}` });
      for (const h of subset.held ?? [])
        nodes.push({ logicalId: h.logicalId, status: "attention_required", attentionEvidence: `held from launch — ${h.reason}` });
    } else {
      // A whole-subset refusal (e.g. no usable snapshot) leaves every remaining seat
      // unverified — each gets a NAMED row; silence here would be the round-10 gap again.
      for (const id of remaining)
        nodes.push({ logicalId: id, status: "failed", error: `per-seat resume verification unavailable: ${subset.message ?? subset.code ?? "launch subset failed"}` });
    }
  }
  const attention = attentionRowsFromNodes(softwareTeamId, nodes);
  // R6 closed union, per the amendment: all seats re-attached+verified →
  // fully_restored; some non-resumable → partially_restored (their exact needs ride
  // the triage rows). adoptedIds.size > 0 guarantees at least one OK seat here.
  return attention.length === 0
    ? { outcome: "fully_restored", attention }
    : { outcome: "partially_restored", attention };
}

/** Build the default `restoreSoftwareTeam` dep: COMPOSE findLatestRestoreUsable → restore →
 *  softwareTeamResult. A softwareTeam with no usable snapshot is `not_attempted` (restore never runs);
 *  a restore that fails outright is `failed`. Never re-authors restore logic.
 *  With `adoptDeps` wired (Amendment 2), a softwareTeam whose panes survived takes the ADOPT
 *  branch above; DEAD panes (and callers without adoptDeps) run unchanged. */
export function createDefaultRestoreSoftwareTeam(
  _deps: RestoreSoftwareTeamDeps,
  adoptDeps?: AdoptSoftwareTeamDeps,
): (softwareTeamId: string) => Promise<{ outcome: PerSoftwareTeamOutcome; receiptRef?: number; attention?: AttentionRow[]; reason?: string; remediation?: string }> {
  return async (softwareTeamId) => {
    if (adoptDeps) {
      const live = await adoptDeps.probeLiveSessions(softwareTeamId);
      // Adopt has NO restore-attempt receipt: its ledger lineage is the
      // node.reconciled events the shipped adopt emits per seat.
      if (live.length > 0) return adoptLivePanesSoftwareTeam(softwareTeamId, live, adoptDeps);
    }
    const selected = _deps.selectRestoreUsable?.(softwareTeamId);
    const snapshot = selected?.ok ? selected.snapshot : _deps.findLatestRestoreUsable(softwareTeamId);
    if (!snapshot)
      // no usable snapshot — never a silent substitute; R3: carry WHY + the fix.
      return {
        outcome: "not_attempted",
        reason: "no restore-usable snapshot for this softwareTeam",
        remediation: `take a snapshot (SoftwareTeam snapshot ${softwareTeamId}) or mark an existing one restore-usable`,
      };
    let receiptRef: number | undefined;
    const outcome = await _deps.restore(snapshot.id, {
      ...(selected?.ok ? { snapshotSelection: selected.selection } : {}),
      onAttemptStarted: (attemptId) => {
        receiptRef = attemptId;
      },
    });
    // ok:true → result.softwareTeamResult; ok:false WITH a result (e.g. pre-restore validation
    // fail → `not_attempted`) → its softwareTeamResult; ok:false with no result (a hard failure:
    // snapshot/softwareTeam not found, softwareTeam not stopped, restore in progress) → `failed`.
    const outcomeResult: PerSoftwareTeamOutcome = outcome.result?.softwareTeamResult ?? "failed";
    // Triage rows for this softwareTeam's seats that need operator action (from the restore
    // result's nodes) — the shipped per-softwareTeam attention, unioned at the fleet layer.
    const attention = outcome.result?.nodes ? attentionRowsFromNodes(softwareTeamId, outcome.result.nodes) : [];
    return { outcome: outcomeResult, receiptRef, attention };
  };
}

export interface SoftwareTeamOrderDeps {
  /** All (non-archived) softwareTeams on this host — the conductor's fleet scope, v1. */
  listSoftwareTeams: () => Array<{ id: string; name: string }>;
}

/** R2 — the founder's order: the KERNEL softwareTeam (the supervisor, name "kernel") restores
 *  FIRST, then the remaining softwareTeams in listSoftwareTeams order. No kernel softwareTeam → all softwareTeams, none
 *  flagged kernel (honest, never fabricated). This is the `listSoftwareTeamsInOrder` source the
 *  conductor consumes. */
export function listSoftwareTeamsInKernelFirstOrder(
  deps: SoftwareTeamOrderDeps,
): Array<{ softwareTeamId: string; isKernel: boolean }> {
  const all = deps.listSoftwareTeams();
  const kernel = all.filter((r) => r.name === "kernel");
  const rest = all.filter((r) => r.name !== "kernel");
  return [...kernel, ...rest].map((r) => ({ softwareTeamId: r.id, isKernel: r.name === "kernel" }));
}

// ── Atom C — fleet rollup (PURE AGGREGATION, ARCH-RULING Q2) ──────────────────

/** A triage row: a seat + exactly what it needs (picker/auth/remediation), sourced
 *  from the shipped per-SoftwareTeam restore-check attention projection. The fleet
 *  `attention_required` is the UNION of these across softwareTeams — a VIEW, not a parallel record. */
export interface AttentionRow {
  softwareTeamId: string;
  seat: string;
  need: string;
}

/** Fleet rollup — PURE AGGREGATION over the conductor's per-softwareTeam sequence. The per-softwareTeam
 *  outcome stays the shipped CLOSED union (never widened). NO fleet verdict is stored
 *  here — a stored verdict could drift from the per-softwareTeam truth; derive it on demand via
 *  {@link deriveFleetVerdict}. `not_attempted` is first-class (never folded into failed). */
export interface FleetRollup {
  counts: Record<PerSoftwareTeamOutcome, number>;
  sequence: ConductorSoftwareTeamResult[];
  attention_required: AttentionRow[];
}

/** The fleet verdict is a DERIVED function of the counts — never a stored field. */
export type FleetVerdict = "all_fully_restored" | "all_failed" | "none_attempted" | "mixed";

/** A restore node (structural subset of the shipped RestoreNodeResult) — enough to
 *  build a triage row from the seats that need operator action. */
export interface RestoreNodeLite {
  logicalId: string;
  status: string;
  error?: string;
  attentionEvidence?: string | null;
}

/** R5 — map a softwareTeam's restore nodes → triage rows: the seats needing operator action
 *  (a LIVE runtime prompt, an unresumable session, or a hard failure), each with its
 *  EXACT need. Running/resumed nodes are excluded. Never fabricates a need. */
export function attentionRowsFromNodes(softwareTeamId: string, nodes: RestoreNodeLite[]): AttentionRow[] {
  const rows: AttentionRow[] = [];
  for (const n of nodes) {
    if (n.status === "attention_required") {
      rows.push({
        softwareTeamId,
        seat: n.logicalId,
        // Prefer the node's exact need, as awaiting-decision does (BLOCKER 3): an exited agent in a preserved pane
        // carries its text in `error`, and calling it a live prompt would send the operator to the wrong fix.
        need: n.attentionEvidence
          ? `live runtime prompt — ${n.attentionEvidence}`
          : n.error || "live runtime prompt (resume selection / auth) — needs operator",
      });
    } else if (n.status === "awaiting-decision") {
      // BLOCKER 3 — preserve the shipped orchestrator's EXACT error/remediation (it carries the concrete
      // `--fresh <logicalId>` command and reason); only fall back to the generic sentence when the node
      // carried none. The exact need reaching the operator IS the door's "seat + exact need" acceptance.
      rows.push({
        softwareTeamId,
        seat: n.logicalId,
        need: n.error ? n.error : "original session not resumable and no --fresh — choose fresh-prime or skip",
      });
    } else if (n.status === "failed") {
      rows.push({ softwareTeamId, seat: n.logicalId, need: n.error ? `restore failed: ${n.error}` : "restore failed" });
    }
  }
  return rows;
}

export function aggregateFleetRollup(sequence: ConductorSoftwareTeamResult[]): FleetRollup {
  // All four closed-union keys initialized — `not_attempted` is first-class, never
  // absent and never folded into `failed`.
  const counts: Record<PerSoftwareTeamOutcome, number> = {
    fully_restored: 0,
    partially_restored: 0,
    failed: 0,
    not_attempted: 0,
  };
  for (const r of sequence) counts[r.outcome] += 1;
  // attention_required = the UNION of per-softwareTeam triage rows carried in the sequence (a view).
  const attention_required = sequence.flatMap((r) => r.attention ?? []);
  return { counts, sequence, attention_required };
}

/** DERIVED f(counts) — computed, never stored (a stored verdict could drift). */
export function deriveFleetVerdict(counts: Record<PerSoftwareTeamOutcome, number>): FleetVerdict {
  const total = counts.fully_restored + counts.partially_restored + counts.failed + counts.not_attempted;
  if (total === 0 || counts.not_attempted === total) return "none_attempted";
  if (counts.fully_restored === total) return "all_fully_restored";
  if (counts.failed === total) return "all_failed";
  return "mixed";
}
