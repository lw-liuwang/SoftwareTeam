// B1 Atom B — the crash-cart RESTORE CONDUCTOR core. RED-first pins for the
// three plan behaviors: kernel-first order (R2), best-effort continue (R5),
// stop-before-next-softwareTeam cancel (R8). The per-SoftwareTeam restore is injected so this unit
// observes ORDER / FAILURE / CANCEL without the full restore machinery (the real
// dep wraps findLatestRestoreUsable + RestoreOrchestrator.restore; verified by the
// integration + door test).
import { describe, it, expect } from "vitest";
import {
  RestoreConductor,
  createDefaultRestoreSoftwareTeam,
  listSoftwareTeamsInKernelFirstOrder,
  aggregateFleetRollup,
  deriveFleetVerdict,
  attentionRowsFromNodes,
  type PerSoftwareTeamOutcome,
  type ConductorSoftwareTeamResult,
} from "../src/domain/crash-cart-conductor.js";

// kernel FIRST, then the rest — the founder's order the conductor must honor.
const softwareTeamsInOrder = () => [
  { softwareTeamId: "kernel", isKernel: true },
  { softwareTeamId: "alpha", isKernel: false },
  { softwareTeamId: "beta", isKernel: false },
];

describe("RestoreConductor — Atom B core", () => {
  it("R2: restores softwareTeams kernel-first, in order", async () => {
    const seen: string[] = [];
    const c = new RestoreConductor({
      listSoftwareTeamsInOrder: softwareTeamsInOrder,
      restoreSoftwareTeam: async (softwareTeamId) => {
        seen.push(softwareTeamId);
        return { outcome: "fully_restored" as PerSoftwareTeamOutcome };
      },
    });
    const results = await c.restoreFleet();
    expect(seen).toEqual(["kernel", "alpha", "beta"]);
    expect(results.map((r) => r.softwareTeamId)).toEqual(["kernel", "alpha", "beta"]);
    expect(results.every((r) => r.outcome === "fully_restored")).toBe(true);
  });

  it("R5: best-effort — one softwareTeam's failure never halts the fleet; the failed SoftwareTeam is `failed`", async () => {
    const attempted: string[] = [];
    const c = new RestoreConductor({
      listSoftwareTeamsInOrder: softwareTeamsInOrder,
      restoreSoftwareTeam: async (softwareTeamId) => {
        attempted.push(softwareTeamId);
        if (softwareTeamId === "alpha") throw new Error("resume blew up");
        return { outcome: "fully_restored" as PerSoftwareTeamOutcome };
      },
    });
    const results = await c.restoreFleet();
    // beta is STILL attempted after alpha threw
    expect(attempted).toEqual(["kernel", "alpha", "beta"]);
    expect(results.find((r) => r.softwareTeamId === "alpha")!.outcome).toBe("failed");
    expect(results.find((r) => r.softwareTeamId === "beta")!.outcome).toBe("fully_restored");
  });

  it("R8: stop-before-next-software-team cancel — the in-flight SoftwareTeam completes; later softwareTeams are `not_attempted`", async () => {
    const attempted: string[] = [];
    let cancelled = false;
    const c = new RestoreConductor({
      listSoftwareTeamsInOrder: softwareTeamsInOrder,
      restoreSoftwareTeam: async (softwareTeamId) => {
        attempted.push(softwareTeamId);
        if (softwareTeamId === "kernel") cancelled = true; // operator cancels while kernel restores
        return { outcome: "fully_restored" as PerSoftwareTeamOutcome };
      },
      isCancelled: () => cancelled,
    });
    const results = await c.restoreFleet();
    // kernel (in-flight) completed; alpha/beta never started
    expect(attempted).toEqual(["kernel"]);
    expect(results.find((r) => r.softwareTeamId === "kernel")!.outcome).toBe("fully_restored");
    const alpha = results.find((r) => r.softwareTeamId === "alpha")!;
    expect(alpha.outcome).toBe("not_attempted");
    // R3: the cancel-skipped softwareTeam carries WHY + the fix (never a blank not_attempted)
    expect(alpha.reason).toMatch(/cancel/i);
    expect(alpha.remediation).toMatch(/re-run/i);
    expect(results.find((r) => r.softwareTeamId === "beta")!.outcome).toBe("not_attempted");
  });

  it("carries the receiptRef (ledger lineage) through per softwareTeam", async () => {
    const c = new RestoreConductor({
      listSoftwareTeamsInOrder: () => [{ softwareTeamId: "kernel", isKernel: true }],
      restoreSoftwareTeam: async () => ({ outcome: "fully_restored" as PerSoftwareTeamOutcome, receiptRef: 4242 }),
    });
    const results = await c.restoreFleet();
    expect(results[0]!.receiptRef).toBe(4242);
  });

  it("r1-root: emits onSoftwareTeamDone per softwareTeam AS IT COMPLETES (the progress stream), in order", async () => {
    const streamed: Array<{ softwareTeamId: string; outcome: PerSoftwareTeamOutcome }> = [];
    const c = new RestoreConductor({
      listSoftwareTeamsInOrder: softwareTeamsInOrder,
      restoreSoftwareTeam: async (softwareTeamId) => ({ outcome: (softwareTeamId === "alpha" ? "failed" : "fully_restored") as PerSoftwareTeamOutcome }),
    });
    const results = await c.restoreFleet({ onSoftwareTeamDone: (r) => streamed.push({ softwareTeamId: r.softwareTeamId, outcome: r.outcome }) });
    // every softwareTeam streamed as it finished, in kernel-first order, matching the final sequence
    expect(streamed.map((r) => r.softwareTeamId)).toEqual(["kernel", "alpha", "beta"]);
    expect(streamed).toEqual(results.map((r) => ({ softwareTeamId: r.softwareTeamId, outcome: r.outcome })));
  });
});

describe("createDefaultRestoreSoftwareTeam — composes findLatestRestoreUsable + restore (R3/R4)", () => {
  it("R3: no usable snapshot → not_attempted, and restore is NEVER called (no silent substitute)", async () => {
    let restoreCalled = false;
    const restoreSoftwareTeam = createDefaultRestoreSoftwareTeam({
      findLatestRestoreUsable: () => null,
      restore: async () => {
        restoreCalled = true;
        return { ok: true, result: { softwareTeamResult: "fully_restored" } };
      },
    });
    const r = await restoreSoftwareTeam("alpha");
    expect(r.outcome).toBe("not_attempted");
    expect(restoreCalled).toBe(false);
  });

  it("usable snapshot → restore(snapshot.id) and returns its softwareTeamResult + the attemptId receiptRef", async () => {
    let usedSnapshotId: string | undefined;
    const restoreSoftwareTeam = createDefaultRestoreSoftwareTeam({
      findLatestRestoreUsable: () => ({ id: "snap-7" }),
      restore: async (snapshotId, opts) => {
        usedSnapshotId = snapshotId;
        opts?.onAttemptStarted?.(99); // the restore-started event seq
        return { ok: true, result: { softwareTeamResult: "partially_restored" } };
      },
    });
    const r = await restoreSoftwareTeam("alpha");
    expect(usedSnapshotId).toBe("snap-7");
    expect(r.outcome).toBe("partially_restored");
    expect(r.receiptRef).toBe(99);
  });

  it("threads automatic snapshot-selection evidence into the restore attempt", async () => {
    const selection = {
      snapshotId: "snap-ranked",
      kind: "auto-periodic",
      createdAt: "2026-09-04 18:00:00",
      ageMs: 60_000,
      mode: "automatic" as const,
      rationale: "automatic crash-insurance ranking prefers auto-pre-down/auto-periodic, then newest usable",
      newerUsableAlternative: null,
    };
    let observed: typeof selection | undefined;
    const restoreSoftwareTeam = createDefaultRestoreSoftwareTeam({
      findLatestRestoreUsable: () => ({ id: "fallback" }),
      selectRestoreUsable: () => ({ ok: true, snapshot: { id: "snap-ranked" }, selection }),
      restore: async (_snapshotId, opts) => {
        observed = opts?.snapshotSelection;
        return { ok: true, result: { softwareTeamResult: "fully_restored" } };
      },
    });

    await restoreSoftwareTeam("alpha");

    expect(observed).toEqual(selection);
  });

  it("R3: no usable snapshot → not_attempted CARRIES a reason + remediation (no blank gap)", async () => {
    const restoreSoftwareTeam = createDefaultRestoreSoftwareTeam({
      findLatestRestoreUsable: () => null,
      restore: async () => ({ ok: true, result: { softwareTeamResult: "fully_restored" } }),
    });
    const r = await restoreSoftwareTeam("alpha");
    expect(r.outcome).toBe("not_attempted");
    expect(r.reason).toMatch(/no restore-usable snapshot/i);
    expect(r.remediation).toContain("SoftwareTeam snapshot alpha");
  });

  it("restore ok:false (no result) → failed", async () => {
    const restoreSoftwareTeam = createDefaultRestoreSoftwareTeam({
      findLatestRestoreUsable: () => ({ id: "snap-1" }),
      restore: async () => ({ ok: false }),
    });
    const r = await restoreSoftwareTeam("alpha");
    expect(r.outcome).toBe("failed");
  });

  it("surfaces per-software-team attention (triage rows) from the restore result's nodes", async () => {
    const restoreSoftwareTeam = createDefaultRestoreSoftwareTeam({
      findLatestRestoreUsable: () => ({ id: "snap-x" }),
      restore: async () => ({
        ok: true,
        result: {
          softwareTeamResult: "partially_restored",
          nodes: [
            { logicalId: "dev.guard", status: "attention_required", attentionEvidence: "pick a conversation" },
            { logicalId: "dev.driver", status: "resumed" },
          ],
        },
      }),
    });
    const r = await restoreSoftwareTeam("myrig");
    expect(r.attention).toEqual([
      { softwareTeamId: "myrig", seat: "dev.guard", need: "live runtime prompt — pick a conversation" },
    ]);
  });
});

// ── AMENDMENT 2 (stamped, body hash 72757e81) — the surviving-panes ADOPT branch ──
// The round-10 door: daemon killed, panes ALIVE → restore() fail-closes 409 → the fleet
// read "failed" and the non-resumable seat never reached triage. The amendment sanctions
// ONE change: per softwareTeam, LIVE panes compose the SHIPPED reconcile/adopt + per-seat resume
// verification; DEAD panes take the existing restore path byte-unchanged. The union stays
// CLOSED (four members) and adoption touches session state only (R9).
describe("AMENDMENT 2 — per-software-team LIVE/DEAD-panes branch in createDefaultRestoreSoftwareTeam", () => {
  // The shipped restore in its 409 shape: a live-panes softwareTeam fail-closes with NO result —
  // exactly what the conductor read as `failed` at round 10.
  const restore409 = async () => ({ ok: false as const });
  const restoreDeps = () => ({
    findLatestRestoreUsable: () => ({ id: "snap-1" }),
    restore: restore409,
  });

  it("THE DOOR (unit form): a live-panes SoftwareTeam that today 409s must ADOPT — restore is never called, outcome is not `failed`", async () => {
    let restoreCalled = false;
    const restoreSoftwareTeam = createDefaultRestoreSoftwareTeam(
      {
        findLatestRestoreUsable: () => ({ id: "snap-1" }),
        restore: async () => { restoreCalled = true; return { ok: false }; },
      },
      {
        probeLiveSessions: async () => [
          { sessionName: "dev-planner@r", logicalId: "dev.planner" },
          { sessionName: "dev-driver@r", logicalId: "dev.driver" },
        ],
        reconcileSession: async () => ({ ok: true }),
        listSoftwareTeamSeats: () => ["dev.planner", "dev.driver"],
        launchNodeSubset: async () => { throw new Error("no remaining seats — must not be called"); },
      },
    );
    const r = await restoreSoftwareTeam("software-team-1");
    expect(restoreCalled).toBe(false); // adopt branch, never the 409
    expect(r.outcome).toBe("fully_restored"); // all seats re-attached
    expect(r.attention ?? []).toEqual([]);
  });

  it("some seats adopted + the engineered non-resumable seat lands on triage with its EXACT --fresh line → partially_restored", async () => {
    const subsetCalls: string[][] = [];
    const restoreSoftwareTeam = createDefaultRestoreSoftwareTeam(restoreDeps(), {
      probeLiveSessions: async () => [{ sessionName: "dev-planner@r", logicalId: "dev.planner" }],
      reconcileSession: async () => ({ ok: true }),
      listSoftwareTeamSeats: () => ["dev.planner", "dev.qa"],
      launchNodeSubset: async (_softwareTeamId, ids) => {
        subsetCalls.push(ids);
        return {
          ok: true,
          launched: [{
            logicalId: "dev.qa",
            status: "awaiting-decision",
            error: "Original session not resumable. Use --fresh dev.qa to fresh-prime, or skip.",
          }],
        };
      },
    });
    const r = await restoreSoftwareTeam("software-team-1");
    expect(subsetCalls).toEqual([["dev.qa"]]); // only the not-adopted seat is verified
    expect(r.outcome).toBe("partially_restored");
    expect(r.attention).toEqual([
      { softwareTeamId: "software-team-1", seat: "dev.qa", need: "Original session not resumable. Use --fresh dev.qa to fresh-prime, or skip." },
    ]);
  });

  it("mis-probe (probe LIVE, panes died before adopt): every adoption fails → not_attempted with reason+remediation; the subset launcher is NEVER reached", async () => {
    let subsetCalled = false;
    const restoreSoftwareTeam = createDefaultRestoreSoftwareTeam(restoreDeps(), {
      probeLiveSessions: async () => [{ sessionName: "dev-planner@r", logicalId: "dev.planner" }],
      reconcileSession: async () => ({ ok: false, code: "session_not_found", message: "No live tmux session" }),
      listSoftwareTeamSeats: () => ["dev.planner", "dev.qa"],
      launchNodeSubset: async () => { subsetCalled = true; return { ok: true, launched: [] }; },
    });
    const r = await restoreSoftwareTeam("software-team-1");
    expect(r.outcome).toBe("not_attempted"); // adopt fails EMPTY (honest) — the stamped mis-probe analysis
    expect(subsetCalled).toBe(false);
    expect(r.reason).toBeTruthy();
    expect(r.remediation).toBeTruthy();
  });

  it("DEAD panes (probe empty): the existing restore composition runs UNCHANGED", async () => {
    let restored: string | null = null;
    const restoreSoftwareTeam = createDefaultRestoreSoftwareTeam(
      {
        findLatestRestoreUsable: () => ({ id: "snap-9" }),
        restore: async (snapshotId) => { restored = snapshotId; return { ok: true, result: { softwareTeamResult: "fully_restored" } }; },
      },
      {
        probeLiveSessions: async () => [],
        reconcileSession: async () => { throw new Error("must not adopt a dead softwareTeam"); },
        listSoftwareTeamSeats: () => [],
        launchNodeSubset: async () => { throw new Error("must not launch on the dead path"); },
      },
    );
    const r = await restoreSoftwareTeam("software-team-1");
    expect(restored).toBe("snap-9");
    expect(r.outcome).toBe("fully_restored");
  });

  it("no adopt deps wired (today's callers): behavior is byte-identical to the existing composition", async () => {
    const restoreSoftwareTeam = createDefaultRestoreSoftwareTeam(restoreDeps());
    const r = await restoreSoftwareTeam("software-team-1");
    expect(r.outcome).toBe("failed"); // the pre-amendment reading of a 409 — unchanged when no adopt deps exist
  });

  it("subset launcher refusal (e.g. no usable snapshot) + failed targets fold LOUD: rows for every unverified seat, outcome partially_restored", async () => {
    const restoreSoftwareTeam = createDefaultRestoreSoftwareTeam(restoreDeps(), {
      probeLiveSessions: async () => [{ sessionName: "dev-planner@r", logicalId: "dev.planner" }],
      reconcileSession: async () => ({ ok: true }),
      listSoftwareTeamSeats: () => ["dev.planner", "dev.qa", "dev.guard"],
      launchNodeSubset: async () => ({ ok: false, code: "no_usable_snapshot", message: "No usable snapshot for SoftwareTeam software-team-1" }),
    });
    const r = await restoreSoftwareTeam("software-team-1");
    expect(r.outcome).toBe("partially_restored"); // the adopted seat is real; the unverified ones are named
    const seats = (r.attention ?? []).map((a) => a.seat).sort();
    expect(seats).toEqual(["dev.guard", "dev.qa"]);
    for (const row of r.attention ?? []) expect(row.need).toContain("No usable snapshot");
  });

  it("r1 LOW: an adopt-FAILED seat the launcher proves alreadyRunning is RUNNING — the stale failed node is dropped, triage never names a running seat", async () => {
    const restoreSoftwareTeam = createDefaultRestoreSoftwareTeam(restoreDeps(), {
      probeLiveSessions: async () => [
        { sessionName: "dev-planner@r", logicalId: "dev.planner" },
        { sessionName: "dev-qa@r", logicalId: "dev.qa" },
      ],
      // dev.qa's adopt errors transiently — but its pane IS live, which the shipped
      // launcher then proves (alreadyRunning). The seat is running; triage must not
      // carry the stale adopt-failure as its "exact need".
      reconcileSession: async (name) =>
        name === "dev-qa@r" ? { ok: false, code: "reconcile_error", message: "transient" } : { ok: true },
      listSoftwareTeamSeats: () => ["dev.planner", "dev.qa"],
      launchNodeSubset: async (_softwareTeamId, ids) => {
        expect(ids).toEqual(["dev.qa"]); // the adopt-failed seat reaches verification
        return { ok: true, launched: [], alreadyRunning: [{ logicalId: "dev.qa" }] };
      },
    });
    const r = await restoreSoftwareTeam("software-team-1");
    expect(r.attention ?? []).toEqual([]); // no triage row for a seat that is RUNNING
    expect(r.outcome).toBe("fully_restored");
  });

  it("held + failed subset targets become triage rows (never silent); outcome stays in the CLOSED union", async () => {
    const restoreSoftwareTeam = createDefaultRestoreSoftwareTeam(restoreDeps(), {
      probeLiveSessions: async () => [{ sessionName: "dev-planner@r", logicalId: "dev.planner" }],
      reconcileSession: async () => ({ ok: true }),
      listSoftwareTeamSeats: () => ["dev.planner", "dev.qa", "dev.guard"],
      launchNodeSubset: async () => ({
        ok: true,
        launched: [],
        held: [{ logicalId: "dev.qa", reason: "operator hold" }],
        failedTargets: [{ logicalId: "dev.guard", reason: "tmux probe failed (fail-closed)" }],
      }),
    });
    const r = await restoreSoftwareTeam("software-team-1");
    expect(r.outcome).toBe("partially_restored");
    const bySeat = Object.fromEntries((r.attention ?? []).map((a) => [a.seat, a.need]));
    expect(bySeat["dev.qa"]).toContain("held");
    expect(bySeat["dev.guard"]).toContain("tmux probe failed");
    expect(["fully_restored", "partially_restored", "failed", "not_attempted"]).toContain(r.outcome);
  });
});

describe("listSoftwareTeamsInKernelFirstOrder (R2 — kernel supervisor first)", () => {
  it("puts the kernel SoftwareTeam first, then the rest in listSoftwareTeams order", () => {
    const ordered = listSoftwareTeamsInKernelFirstOrder({
      listSoftwareTeams: () => [
        { id: "r-alpha", name: "alpha" },
        { id: "r-kernel", name: "kernel" },
        { id: "r-beta", name: "beta" },
      ],
    });
    expect(ordered.map((r) => r.softwareTeamId)).toEqual(["r-kernel", "r-alpha", "r-beta"]);
    expect(ordered[0]!.isKernel).toBe(true);
    expect(ordered.slice(1).every((r) => !r.isKernel)).toBe(true);
  });

  it("no kernel softwareTeam → all softwareTeams, none flagged kernel (honest, not fabricated)", () => {
    const ordered = listSoftwareTeamsInKernelFirstOrder({ listSoftwareTeams: () => [{ id: "r-a", name: "a" }] });
    expect(ordered).toEqual([{ softwareTeamId: "r-a", isKernel: false }]);
  });
});

describe("aggregateFleetRollup + deriveFleetVerdict (R6 / ARCH-RULING Q2 — pure aggregation)", () => {
  const seq: ConductorSoftwareTeamResult[] = [
    { softwareTeamId: "kernel", outcome: "fully_restored", receiptRef: 1 },
    { softwareTeamId: "alpha", outcome: "failed" },
    { softwareTeamId: "beta", outcome: "not_attempted" },
    { softwareTeamId: "gamma", outcome: "partially_restored", receiptRef: 4 },
  ];

  it("counts by the CLOSED union; not_attempted is first-class (never folded into failed)", () => {
    const rollup = aggregateFleetRollup(seq);
    expect(rollup.counts).toEqual({ fully_restored: 1, partially_restored: 1, failed: 1, not_attempted: 1 });
  });

  it("sequence is a view carrying receiptRef; NO verdict field is stored on the rollup", () => {
    const rollup = aggregateFleetRollup(seq);
    expect(rollup.sequence).toBe(seq);
    expect(rollup.sequence.find((r) => r.softwareTeamId === "kernel")!.receiptRef).toBe(1);
    expect((rollup as Record<string, unknown>)["verdict"]).toBeUndefined(); // verdict is derived, not stored
  });

  it("attention_required is the UNION of per-software-team triage rows carried in the sequence", () => {
    const seqWithAttention: ConductorSoftwareTeamResult[] = [
      { softwareTeamId: "kernel", outcome: "fully_restored" },
      { softwareTeamId: "alpha", outcome: "failed", attention: [{ softwareTeamId: "alpha", seat: "dev.driver", need: "codex auth" }] },
      { softwareTeamId: "beta", outcome: "not_attempted" },
    ];
    expect(aggregateFleetRollup(seqWithAttention).attention_required).toEqual([
      { softwareTeamId: "alpha", seat: "dev.driver", need: "codex auth" },
    ]);
    expect(aggregateFleetRollup(seq).attention_required).toEqual([]); // no per-softwareTeam attention → empty
  });

  it("deriveFleetVerdict is f(counts): all→all_fully_restored, all-failed→all_failed, all-not_attempted→none_attempted, mix→mixed", () => {
    expect(deriveFleetVerdict({ fully_restored: 3, partially_restored: 0, failed: 0, not_attempted: 0 })).toBe("all_fully_restored");
    expect(deriveFleetVerdict({ fully_restored: 0, partially_restored: 0, failed: 2, not_attempted: 0 })).toBe("all_failed");
    expect(deriveFleetVerdict({ fully_restored: 0, partially_restored: 0, failed: 0, not_attempted: 2 })).toBe("none_attempted");
    expect(deriveFleetVerdict(aggregateFleetRollup(seq).counts)).toBe("mixed");
    expect(deriveFleetVerdict({ fully_restored: 0, partially_restored: 0, failed: 0, not_attempted: 0 })).toBe("none_attempted");
  });
});

describe("attentionRowsFromNodes (R5 — triage: seat + exact need)", () => {
  it("maps attention_required / awaiting-decision / failed nodes to triage rows; running nodes are excluded", () => {
    const rows = attentionRowsFromNodes("kernel", [
      { logicalId: "dev.driver", status: "resumed" }, // running — no triage
      { logicalId: "dev.guard", status: "attention_required", attentionEvidence: "select a conversation to resume" },
      { logicalId: "dev.qa", status: "awaiting-decision" },
      { logicalId: "orch.lead", status: "failed", error: "spawn ENOENT" },
    ]);
    expect(rows.map((r) => r.seat)).toEqual(["dev.guard", "dev.qa", "orch.lead"]);
    expect(rows.find((r) => r.seat === "dev.guard")!.need).toContain("select a conversation");
    expect(rows.find((r) => r.seat === "dev.qa")!.need).toContain("choose");
    expect(rows.find((r) => r.seat === "orch.lead")!.need).toContain("spawn ENOENT");
    expect(rows.every((r) => r.softwareTeamId === "kernel")).toBe(true);
  });

  it("BLOCKER 3: awaiting-decision PRESERVES the exact node error/remediation (the --fresh command), not a generic sentence", () => {
    const exact = "session for dev.qa not resumable (resume_token expired); run: SoftwareTeam restore snap-7 --fresh dev.qa — or skip this seat";
    const rows = attentionRowsFromNodes("myrig", [{ logicalId: "dev.qa", status: "awaiting-decision", error: exact }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.need).toBe(exact); // the EXACT evidence reaches the operator (the door's acceptance sentence)
    expect(rows[0]!.need).toContain("--fresh dev.qa");
  });

  it("attention_required with no evidence carries the node's own error, such as an exited agent, not a live-prompt label", () => {
    const exited = "Session alive, agent not running for 'dev.driver': tmux session 'dev-driver@r' holds an idle shell";
    const rows = attentionRowsFromNodes("r", [{ logicalId: "dev.driver", status: "attention_required", error: exited }]);
    expect(rows[0]!.need).toBe(exited);
    expect(attentionRowsFromNodes("r", [{ logicalId: "dev.y", status: "attention_required" }])[0]!.need).toContain("live runtime prompt");
  });

  it("awaiting-decision with NO node error falls back to the generic sentence (never blank)", () => {
    const rows = attentionRowsFromNodes("r", [{ logicalId: "dev.x", status: "awaiting-decision" }]);
    expect(rows[0]!.need).toContain("choose fresh-prime or skip");
  });

  it("no attention-needing nodes → empty (never fabricated)", () => {
    expect(attentionRowsFromNodes("r", [{ logicalId: "a", status: "resumed" }, { logicalId: "b", status: "fresh-primed" }])).toEqual([]);
  });
});
