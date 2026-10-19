import { describe, it, expect } from "vitest";
import { restoreConfirmMessage } from "../src/crash-cart/one-click-gate.js";
import { evaluateOneClickGate } from "../src/crash-cart/one-click-gate.js";

// Crash-cart C3 — the one-click rule (founder, binding on ⏎): ⏎ is ONE keystroke IFF the plan is
// ZERO GENERATION (every seat resume-original). Pre-daemon PROXY over the C2 read: a softwareTeam is fully
// recoverable when resumableCount == seatCount. If ANY softwareTeam has non-resumable seats, ⏎ must lead to a
// confirm screen naming those deltas — never a silent resume→fresh downgrade.

const softwareTeam = (softwareTeamName: string, seatCount: number, resumableCount: number) => ({ softwareTeamName, seatCount, resumableCount });

describe("evaluateOneClickGate — zero-generation proxy over C2 discovery", () => {
  it("zero-generation TRUE (⏎ one keystroke) when every SoftwareTeam is fully resumable", () => {
    const g = evaluateOneClickGate({ foundOnHost: [softwareTeam("alpha", 3, 3), softwareTeam("kernel", 4, 4)] });
    expect(g.zeroGeneration).toBe(true);
    expect(g.deltas).toEqual([]);
  });

  it("FALSE with a delta naming the softwareTeam + its non-resumable seat count when any seat is not resumable", () => {
    const g = evaluateOneClickGate({ foundOnHost: [softwareTeam("alpha", 3, 3), softwareTeam("beta", 5, 2)] });
    expect(g.zeroGeneration).toBe(false);
    expect(g.deltas).toEqual([{ softwareTeamName: "beta", seatCount: 5, resumableCount: 2, nonResumable: 3 }]);
  });

  it("lists every SoftwareTeam that has non-resumable seats", () => {
    const g = evaluateOneClickGate({ foundOnHost: [softwareTeam("a", 2, 0), softwareTeam("b", 2, 2), softwareTeam("c", 3, 1)] });
    expect(g.deltas.map((d) => d.softwareTeamName)).toEqual(["a", "c"]);
    expect(g.zeroGeneration).toBe(false);
  });

  it("empty host (no softwareTeams) is vacuously zero-generation (the no-software-teams/onboarding path is handled upstream)", () => {
    const g = evaluateOneClickGate({ foundOnHost: [] });
    expect(g.zeroGeneration).toBe(true);
    expect(g.deltas).toEqual([]);
  });
});

describe("restoreConfirmMessage — TRUTHFUL (r2 HIGH-2: no false fresh-prime promise)", () => {
  it("names the deltas and describes the awaiting-DECISION, never claims the restore fresh-primes", () => {
    const msg = restoreConfirmMessage([{ softwareTeamName: "softwareteam-pm", seatCount: 13, resumableCount: 7, nonResumable: 6 }]);
    expect(msg).toContain("softwareteam-pm (6/13)"); // names the delta (R7 — no silent downgrade)
    expect(msg).toContain("can't resume");
    expect(msg).toContain("need a decision (fresh-prime or skip)"); // the decision the restore actually produces
    expect(msg).toContain("triage list");
    // it must NOT promise that RESTORE itself fresh-primes (the false claim r2 caught)
    expect(msg).not.toMatch(/will fresh-prime/i);
  });
});
