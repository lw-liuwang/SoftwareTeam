// LEG-7 LOW 1 — isActiveSoftwareTeam extraction (fold-wave qitem 79159e6f). The bare-default table projection
// (ps.ts ~L942) and the softwareTeamsOnHost scope count (~L1081) both applied the same `.status !== "stopped"`
// active-softwareTeam predicate inline. This pins the ONE extracted `isActiveSoftwareTeam` predicate they now share, so
// the "1 of N" scope label and the shown rows can never diverge (the derived-label-must-carry-liveness
// class the LEG-2 QA flagged). RED-first: the import does not resolve until the helper is exported.
import { describe, expect, it } from "vitest";
import { isActiveSoftwareTeam } from "../src/commands/ps.js";

describe("isActiveSoftwareTeam — the one shared active-software-team predicate (LEG-7 extraction)", () => {
  it("a SoftwareTeam is ACTIVE unless its status is exactly 'stopped'", () => {
    expect(isActiveSoftwareTeam({ status: "running" })).toBe(true);
    expect(isActiveSoftwareTeam({ status: "recoverable" })).toBe(true);
    expect(isActiveSoftwareTeam({ status: "degraded" })).toBe(true);
    expect(isActiveSoftwareTeam({ status: "stopped" })).toBe(false);
  });

  it("an absent/undefined status is ACTIVE (not stopped) — matches the pre-extraction inline behavior", () => {
    expect(isActiveSoftwareTeam({})).toBe(true);
    expect(isActiveSoftwareTeam({ status: undefined })).toBe(true);
  });
});
