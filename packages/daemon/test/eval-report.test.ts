import { describe, it, expect } from "vitest";
import { grade, type EvalCase } from "./helpers/eval-grader.js";
import { failReason, recordedGrade } from "./helpers/eval-report.js";
import type { CaseOutcome } from "./helpers/eval-runner.js";

// slice-07 R6 F1 — RED-first pins: the recorded grade must EXPLAIN its verdict. Against the lossy
// stub these fail; GREEN lands when the reporter carries patternResults + order + a FAIL reason.

const LOAD: EvalCase = {
  id: "load-01", name: "loads before acting", category: "loading", prompt: "P",
  expectedPatterns: ["SoftwareTeam context get\\s+core/watchdog"],
  order: { getPattern: "SoftwareTeam context get\\s+core/watchdog", actionPattern: "SoftwareTeam watchdog register" },
};
const SEL: EvalCase = {
  id: "sel-01", name: "selects software-team-lifecycle", category: "selection", prompt: "P",
  expectedPatterns: ["SoftwareTeam context get\\s+core/software-team-lifecycle"],
};

function outcome(c: EvalCase, transcript: string): CaseOutcome {
  return { case: c, transcript, grade: grade(c, transcript) };
}

describe("eval-report — the artifact explains its own verdict", () => {
  it("failReason names the order violation for action-before-get", () => {
    const g = grade(LOAD, "SoftwareTeam watchdog register\nthen SoftwareTeam context get core/watchdog");
    expect(g.pass).toBe(false);
    expect(failReason(g)).toMatch(/precede/i);
  });

  it("failReason names the order violation for action-with-no-get", () => {
    const g = grade(LOAD, "SoftwareTeam watchdog register   # no load first");
    expect(failReason(g)).toMatch(/no preceding/i);
  });

  it("failReason names the unmatched expected pattern for a wrong selection", () => {
    const g = grade(SEL, "SoftwareTeam context get core/attention-queue");
    expect(failReason(g)).toMatch(/expected not matched/i);
  });

  it("recordedGrade carries patternResults and the order diagnostic on a loading FAIL", () => {
    const rec = recordedGrade(outcome(LOAD, "SoftwareTeam watchdog register\nthen SoftwareTeam context get core/watchdog"));
    expect(rec.pass).toBe(false);
    expect(rec.patternResults.length).toBeGreaterThan(0);
    expect(rec.order).not.toBeNull();
    expect(rec.order!.ok).toBe(false);
    expect(rec.reason).toMatch(/precede/i);
  });

  it("recordedGrade leaves reason null on a pass and null order for selection", () => {
    const rec = recordedGrade(outcome(SEL, "SoftwareTeam context get core/software-team-lifecycle"));
    expect(rec.pass).toBe(true);
    expect(rec.reason).toBeNull();
    expect(rec.order).toBeNull();
    expect(rec.patternResults.length).toBeGreaterThan(0);
  });
});
