import { Command } from "commander";

// OPR.0.5.5.19 A7 — `softwareTeam parked [seat]`: the founder's one-command ask. The diagnosis is
// DERIVED at read time by the daemon (activity oracle × the queue's obligation face) and
// returns confidence for BOTH inputs — this command renders it, it never computes it.

interface SeatDiagnosis {
  seatNodeId: string;
  sessionName: string;
  parked: boolean | "indeterminate";
  reason: string;
  activity: { value: string; needsInput: { count: number; reason: string | null }; decidedBy: string | null; confidence: string };
  obligations: {
    scope: string;
    openCount: number;
    heldCount: number;
    unhealthyHeldCount?: number;
    complete: boolean;
    limit: number;
    items: Array<{ qitemId: string; state: string; summary?: string | null }>;
    held?: Array<{
      qitemId: string;
      state: string;
      summary?: string | null;
      healthy?: boolean;
      wake: { kind: string; ref: string; live: boolean; unconsumed?: boolean; deliveryStatus?: string | null } | null;
    }>;
  };
  confidence: { activity: string; obligations: string };
}

function verdictWord(parked: boolean | "indeterminate"): string {
  return parked === true ? "PARKED" : parked === false ? "not parked" : "INDETERMINATE";
}

function renderSeat(d: SeatDiagnosis): void {
  console.log(`${d.sessionName}: ${verdictWord(d.parked)} — ${d.reason}`);
  console.log(`  activity: ${d.activity.value}${d.activity.needsInput.count > 0 ? ` (needs-input x${d.activity.needsInput.count}: ${d.activity.needsInput.reason})` : ""} [decided by ${d.activity.decidedBy ?? "nothing — unknown"}; confidence ${d.confidence.activity}]`);
  console.log(`  obligations: ${d.obligations.openCount} open, ${d.obligations.heldCount} held [${d.obligations.scope}; ${d.obligations.complete ? "complete" : `MAY BE TRUNCATED at ${d.obligations.limit}`}]`);
  for (const item of d.obligations.items.slice(0, 10)) {
    console.log(`    - ${item.state} ${item.qitemId}${item.summary ? ` — ${item.summary}` : ""}`);
  }
  if (d.obligations.items.length > 10) console.log(`    … and ${d.obligations.items.length - 10} more`);
  for (const item of d.obligations.held ?? []) {
    const wake = item.wake;
    const wakeText = wake
      ? `${wake.kind} ${wake.ref}: ${wake.unconsumed ? `FIRED but unconsumed${wake.deliveryStatus ? ` (${wake.deliveryStatus})` : ""}` : wake.live ? "live" : "not live"}`
      : "no recorded wake";
    console.log(`    - HELD ${item.qitemId}${item.summary ? ` — ${item.summary}` : ""} [${wakeText}]`);
    if (!item.healthy && !(wake?.live && !wake.unconsumed)) {
      console.log("      Remedy: attach a live watchdog id, arm an atomic timer, or name a live blocker qitem; deferred/not-imminent work with a workspace home belongs in its mission/slice.");
    }
  }
}

export function parkedCommand(): Command {
  return new Command("parked")
    .description("Are we parked? Derived diagnosis: stopped seats owing work; HELD is healthy only while its recorded wake is live")
    .argument("[seat]", "Seat node id or canonical session name; omit to diagnose the whole softwareTeam")
    .option("--software-team <softwareTeam>", "SoftwareTeam scope (defaults to your seat's SoftwareTeam from SOFTWARETEAM_SESSION_NAME; a seat argument carrying @software-team self-scopes)")
    .option("--json", "Full diagnosis as JSON")
    .action(async (seat: string | undefined, opts: { json?: boolean; softwareTeam?: string }) => {
      const { DaemonClient } = await import("../client.js");
      const client = new DaemonClient();
      // WAVE-O B2: the diagnosis is software-team-scoped — carry the coordinate. A seat@software-team
      // argument self-scopes; otherwise --software-team, then the shell's own seat identity.
      // With none resolvable the daemon's teaching refusal is surfaced verbatim.
      const params = new URLSearchParams();
      if (seat) params.set("seat", seat);
      if (!seat?.includes("@")) {
        const envSession = process.env["SOFTWARETEAM_SESSION_NAME"];
        const softwareTeam = opts.softwareTeam ?? (envSession?.includes("@") ? envSession.split("@")[1] : undefined);
        if (softwareTeam) params.set("softwareTeam", softwareTeam);
      }
      const qs = params.toString();
      let data: { ok: boolean; error?: string; scope?: { softwareTeam: string; resolvedFrom: string }; seat?: SeatDiagnosis; softwareTeam?: { parked: boolean | "indeterminate"; reason: string; seats: SeatDiagnosis[]; scope?: { softwareTeam: string; resolvedFrom: string } } };
      try {
        const res = await client.get<typeof data>(`/api/activity/parked${qs ? `?${qs}` : ""}`);
        data = res.data;
      } catch (err) {
        console.error(`refused: the parked diagnosis is derived LIVE from the oracle and the queue — it needs a reachable daemon (${(err as Error).message}).`);
        process.exitCode = 1;
        return;
      }
      if (!data.ok) {
        console.error(`refused: ${data.error}`);
        process.exitCode = 1;
        return;
      }
      if (opts.json) {
        console.log(JSON.stringify(data));
        return;
      }
      if (data.seat) {
        if (data.scope) console.log(`scope: softwareTeam ${data.scope.softwareTeam} (from ${data.scope.resolvedFrom})`);
        renderSeat(data.seat);
        return;
      }
      const softwareTeam = data.softwareTeam!;
      console.log(`softwareTeam: ${verdictWord(softwareTeam.parked)} — ${softwareTeam.reason}`);
      if (softwareTeam.scope) console.log(`scope: softwareTeam ${softwareTeam.scope.softwareTeam} (from ${softwareTeam.scope.resolvedFrom})`);
      for (const d of softwareTeam.seats) {
        if (d.parked === false) continue; // the interesting cells are parked + indeterminate
        renderSeat(d);
      }
    });
}
