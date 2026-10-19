import { describe, it, expect } from "vitest";
import { grade, type EvalCase } from "./helpers/eval-grader.js";

// slice-07 R6 — RED-first pins for the deterministic DOOR grader.
// Against the RED-first stub (unconditional pass) the FAIL cases below fail; that is the
// intended RED. GREEN lands when grade() actually discriminates.

const SEL: EvalCase = {
  id: "sel-01",
  name: "selects core/software-team-lifecycle for a fleet bring-back",
  category: "selection",
  prompt: "the box rebooted and everything's gone — bring the whole fleet back",
  expectedPatterns: ["SoftwareTeam context get\\s+core/software-team-lifecycle"],
};

const LOAD: EvalCase = {
  id: "load-01",
  name: "pulls core/software-team-lifecycle before any bring-back action",
  category: "loading",
  prompt: "the box rebooted and everything's gone — bring the whole fleet back",
  expectedPatterns: ["SoftwareTeam context get\\s+core/software-team-lifecycle"],
  order: {
    getPattern: "SoftwareTeam context get\\s+core/software-team-lifecycle",
    actionPattern: "SoftwareTeam (up|start|restore)",
  },
};

describe("eval-grader — deterministic door", () => {
  it("selection PASS when the correct ref is pulled", () => {
    expect(grade(SEL, "…thinking… SoftwareTeam context get core/software-team-lifecycle\nSoftwareTeam start").pass).toBe(true);
  });

  it("selection FAIL when the wrong ref is pulled", () => {
    expect(grade(SEL, "SoftwareTeam context get core/attention-queue\nSoftwareTeam start").pass).toBe(false);
  });

  it("selection FAIL on a forbidden pattern", () => {
    const c: EvalCase = { ...SEL, forbiddenPatterns: ["SoftwareTeam destroy"] };
    expect(grade(c, "SoftwareTeam context get core/software-team-lifecycle\nSoftwareTeam destroy").pass).toBe(false);
  });

  it("loading PASS when the get precedes the action", () => {
    expect(grade(LOAD, "SoftwareTeam context get core/software-team-lifecycle\n…\nSoftwareTeam start").pass).toBe(true);
  });

  it("loading FAIL when the action runs with no preceding get", () => {
    expect(grade(LOAD, "SoftwareTeam start   # acted without loading").pass).toBe(false);
  });

  it("loading FAIL when the action precedes the get", () => {
    expect(grade(LOAD, "SoftwareTeam start\nthen SoftwareTeam context get core/software-team-lifecycle").pass).toBe(false);
  });
});
